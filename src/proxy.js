import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ResetDetector } from './detector.js';

const WORK_METHODS = new Set([
  'turn/start', 'turn/steer', 'review/start', 'thread/compact/start',
  'thread/start', 'thread/resume', 'thread/fork', 'thread/sample', 'thread/prediction/request', 'thread/queue/start',
  'thread/realtime/start', 'thread/realtime/appendText', 'thread/realtime/appendAudio',
  'thread/realtime/appendSpeech',
  // Older app-server protocol spellings.
  'sendUserMessage', 'sendUserTurn', 'addConversationListener',
]);

export function startsWork(message) {
  if (WORK_METHODS.has(message.method)) return true;
  if (message.method === 'thread/goal/set') return message.params?.status !== 'paused' && message.params?.status !== 'complete';
  return false;
}

export function positiveInteger(value, fallback, name, minimum = 1) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > 2_147_483_647) {
    throw new Error(`${name} must be an integer between ${minimum} and 2147483647.`);
  }
  return parsed;
}

/** A transparent JSONL transport; private requests never reach the T3 client. */
export function runProxy({ binary, args, store, input = process.stdin, output = process.stdout,
  errors = process.stderr, env = process.env, spawnChild = spawn, onStatus = () => {} }) {
  const pollMs = positiveInteger(env.RESETSTOP_POLL_MS, 15_000, 'RESETSTOP_POLL_MS', 250);
  const requestMs = positiveInteger(env.RESETSTOP_REQUEST_TIMEOUT_MS, 10_000, 'RESETSTOP_REQUEST_TIMEOUT_MS');
  const graceMs = positiveInteger(env.RESETSTOP_STOP_GRACE_MS, 1_000, 'RESETSTOP_STOP_GRACE_MS');
  const namespace = `resetstop:${randomUUID()}:`;
  const scope = createHash('sha256').update(`${binary}\0${resolve(env.CODEX_HOME || `${homedir()}/.codex`)}`).digest('hex');
  let state = store.read();
  let detector = new ResetDetector({ window: state.window, baseline: state.baselines[scope] || null });
  let detectorGeneration = state.generation;
  let initialized = false;
  let verified = false;
  let accountEpoch = 0;
  let closed = false;
  let pollPromise = null;
  let lastPoll = 0;
  let nextId = 0;
  let deadlineTimer;
  let stopTimer;
  let killTimer;
  let errorsBroken = false;
  const pending = new Map();
  const forwarded = new Map();
  const clientIds = new Map();
  const active = new Map();
  const threads = new Set();
  const stopping = new Set();
  // A private process group lets shutdown reach the npm Codex launcher's native child too.
  const child = spawnChild(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const clientLines = createInterface({ input, crlfDelay: Infinity });
  const serverLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.pipe(errors, { end: false });

  function log(message) {
    if (!errorsBroken && !errors.destroyed) errors.write(`[codex-brake] ${message}\n`);
  }
  function send(message) {
    if (!closed && !child.stdin.destroyed && !child.stdin.write(`${JSON.stringify(message)}\n`)) clientLines.pause();
  }
  function emit(message) {
    if (!closed && !output.destroyed && !output.write(`${JSON.stringify(message)}\n`)) serverLines.pause();
  }
  function signalChild(signal) {
    if (!child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') log(`Could not send ${signal}: ${error.message}`); }
  }
  function terminate() {
    if (closed) return;
    signalChild('SIGTERM');
    killTimer ??= setTimeout(() => signalChild('SIGKILL'), 1_000);
  }
  function internal(method, params = {}, timeoutMs = requestMs) {
    if (closed) return Promise.reject(new Error('Codex app-server has exited.'));
    const id = `${namespace}${++nextId}`;
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      pending.set(id, { resolve: resolveRequest, reject, timeout });
      send({ id, method, params });
    });
  }
  function errorResponse(message, text) {
    if (message.id !== undefined) emit({ id: message.id, error: { code: -32001, message: text } });
  }
  function pauseText() {
    const reason = (state.reason?.message || 'manual pause').replace(/[.\s]+$/, '');
    return `Codex Brake is paused: ${reason}. Run "codex-brake resume" when you want to use the new allowance, then retry your message.`;
  }
  function armDeadline() {
    clearTimeout(deadlineTimer);
    if (closed || state.mode !== 'armed' || detector.nextDeadline === null) return;
    deadlineTimer = setTimeout(() => {
      safely(() => { syncState(); checkDeadline(); armDeadline(); });
    }, Math.min(2_147_483_647, Math.max(1, detector.nextDeadline - Date.now())));
  }
  function stopTurn(threadId, turnId) {
    const key = `${threadId}/${turnId}`;
    if (stopping.has(key)) return;
    stopping.add(key);
    // Send the goal pause before interrupting so a native goal cannot keep scheduling turns.
    void internal('thread/goal/set', { threadId, status: 'paused' }, graceMs).catch(() => {});
    void internal('turn/interrupt', { threadId, turnId }, graceMs).catch(() => {});
  }
  function enforcePause() {
    if (state.mode !== 'paused' || !initialized) return;
    onStatus({ state, verified: false });
    for (const threadId of threads) {
      if (!stopping.has(`goal/${threadId}`)) {
        stopping.add(`goal/${threadId}`);
        void internal('thread/goal/set', { threadId, status: 'paused' }, graceMs).catch(() => {});
      }
    }
    for (const [threadId, turnId] of active) stopTurn(threadId, turnId);
    // Also end the backend after graceful cancellation: hidden child turns and native
    // goal loops must not survive an interrupt race. The shared latch survives reconnects.
    if (threads.size && !stopTimer) stopTimer = setTimeout(terminate, graceMs);
  }
  function latch(reason) {
    const wasPaused = state.mode === 'paused';
    state = store.pause(reason, state.generation);
    clearTimeout(deadlineTimer);
    if (state.mode === 'paused') {
      if (!wasPaused) log(pauseText());
      enforcePause();
    }
  }
  function checkDeadline() {
    if (state.mode === 'armed') {
      const reason = detector.check();
      if (reason) latch(reason);
    }
  }
  function syncState() {
    const fresh = store.read();
    if (fresh.generation !== detectorGeneration) {
      state = fresh;
      detectorGeneration = state.generation;
      detector = new ResetDetector({ window: state.window, baseline: state.baselines[scope] || null });
      verified = false;
      stopping.clear();
      if (state.mode !== 'paused') {
        clearTimeout(stopTimer);
        stopTimer = undefined;
      }
      armDeadline();
    } else {
      state = fresh;
    }
    if (state.mode === 'paused') enforcePause();
    if (initialized && state.mode === 'off') onStatus({ state, verified: false });
    return state;
  }
  function monitoringFailure(error) {
    latch({ kind: 'monitor-unavailable', detectedAt: Date.now(), message: `Usage monitoring failed (${error.message})` });
  }
  function safely(fn) {
    try { return fn(); }
    catch (error) {
      // A broken/unreadable state file must never silently disable protection.
      log(`Guard failed closed: ${error.message}`);
      state = { ...state, mode: 'paused', reason: { message: error.message } };
      enforcePause();
      terminate();
    }
  }
  function refresh() {
    if (pollPromise) return pollPromise;
    if (!initialized || closed || state.mode !== 'armed') return Promise.resolve();
    const generation = state.generation;
    const epoch = accountEpoch;
    lastPoll = Date.now();
    pollPromise = (async () => {
      try {
        const result = await internal('account/rateLimits/read', {});
        if (closed) return;
        syncState();
        if (state.generation !== generation || state.mode !== 'armed' || accountEpoch !== epoch) return;
        const reason = detector.observe(result);
        if (reason) { latch(reason); return; }
        if (!detector.snapshot.windows.some(window => detector.matches(window) && (window.usedPercent !== null || window.deadline !== null))) {
          throw new Error(`Codex returned no ${state.window} usage window; ChatGPT quota authentication is required`);
        }
        verified = true;
        state = store.saveBaseline(scope, detector.snapshot, generation);
        syncState();
        armDeadline();
        if (state.mode === 'armed' && verified) onStatus({ state, verified });
      } catch (error) {
        if (!closed) safely(() => {
          syncState();
          if (state.generation === generation && state.mode === 'armed' && accountEpoch === epoch) monitoringFailure(error);
        });
      } finally {
        pollPromise = null;
      }
    })();
    return pollPromise;
  }
  async function fromClient(message) {
    syncState();
    checkDeadline();
    if (['account/login/start', 'account/logout'].includes(message.method)) {
      accountEpoch++;
      verified = false;
    }
    if (startsWork(message)) {
      if (killTimer) {
        errorResponse(message, 'Codex Brake is shutting down this backend. Reconnect the session, then retry.');
        return;
      }
      if (state.mode === 'armed' && !verified) {
        await refresh();
        // Resume might have invalidated an older in-flight read.
        if (state.mode === 'armed' && !verified) await refresh();
      }
      syncState();
      checkDeadline();
      if (state.mode === 'paused') { errorResponse(message, pauseText()); return; }
      if (state.mode === 'armed' && !verified) {
        errorResponse(message, 'Codex Brake is waiting for initialization and a fresh usage snapshot. Retry after Codex connects.');
        return;
      }
    }
    if (typeof message.params?.threadId === 'string') threads.add(message.params.threadId);
    if (message.method && message.id !== undefined) {
      const id = `${namespace}client:${++nextId}`;
      forwarded.set(id, { id: message.id, method: message.method, params: message.params });
      clientIds.set(JSON.stringify(message.id), id);
      if (['thread/sample/cancel', 'userVerification/cancel'].includes(message.method)) {
        const requestId = clientIds.get(JSON.stringify(message.params?.requestId));
        if (requestId) message = { ...message, params: { ...message.params, requestId } };
      }
      send({ ...message, id });
    } else {
      send(message);
    }
    if (message.method === 'initialized') {
      initialized = true;
      if (state.mode === 'off') onStatus({ state, verified: false });
      checkDeadline();
      enforcePause();
      void refresh();
    }
  }
  function rememberTurn(threadId, turn) {
    if (!threadId || !turn?.id) return;
    threads.add(threadId);
    if (!turn.status || turn.status === 'inProgress') {
      active.set(threadId, turn.id);
      if (state.mode === 'paused') enforcePause();
    }
  }
  function fromServer(message) {
    const request = pending.get(message.id);
    if (request && !message.method) {
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message || 'Codex request failed'));
      else request.resolve(message.result);
      return;
    }
    const client = forwarded.get(message.id);
    if (client && !message.method) {
      forwarded.delete(message.id);
      clientIds.delete(JSON.stringify(client.id));
      if (client.method === 'turn/start') rememberTurn(client.params?.threadId, message.result?.turn);
      const thread = message.result?.thread;
      if (thread?.id) {
        threads.add(thread.id);
        for (const turn of thread.turns || []) if (turn.status === 'inProgress') rememberTurn(thread.id, turn);
      }
      emit({ ...message, id: client.id });
      return;
    }
    // Ignore late private responses following a request timeout.
    if (!message.method && typeof message.id === 'string' && message.id.startsWith(namespace)) return;
    if (message.method === 'turn/started') rememberTurn(message.params?.threadId, message.params?.turn);
    if (message.method === 'turn/completed') {
      if (active.get(message.params?.threadId) === message.params?.turn?.id) active.delete(message.params.threadId);
    }
    if (message.method === 'account/updated') {
      // Invalidate pending reads from the previous account and require a fresh one.
      // Paused state remains latched; only an explicit user resume can clear it.
      verified = false;
      accountEpoch++;
    }
    if (message.method === 'account/rateLimits/updated' || message.method === 'account/updated') {
      // Token-count notifications can contain cached quota. Only full reads feed the detector.
      if (Date.now() - lastPoll >= 1_000) void refresh();
    }
    emit(message);
  }
  clientLines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { emit({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    void fromClient(message).catch(error => safely(() => { throw error; }));
  });
  serverLines.on('line', line => {
    if (!line.trim()) return;
    safely(() => fromServer(JSON.parse(line)));
  });
  const ticker = setInterval(() => safely(() => {
    syncState();
    checkDeadline();
    if (Date.now() - lastPoll >= pollMs || !verified) void refresh();
  }), 250);
  clientLines.on('close', terminate);
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') log(error.message); });
  child.stdin.on('drain', () => clientLines.resume());
  const onOutputDrain = () => serverLines.resume();
  const onOutputError = () => terminate();
  const onErrorsError = () => { errorsBroken = true; };
  const onProcessExit = () => signalChild('SIGKILL');
  output.on('drain', onOutputDrain);
  output.on('error', onOutputError);
  output.on('close', onOutputError);
  errors.on('error', onErrorsError);
  process.once('exit', onProcessExit);
  const onSignal = () => terminate();
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  armDeadline();

  return new Promise(resolveExit => {
    function finish(code) {
      if (closed) return;
      // The npm launcher may exit while a native child still owns this group.
      if (killTimer) signalChild('SIGKILL');
      closed = true;
      clearInterval(ticker);
      clearTimeout(deadlineTimer);
      clearTimeout(stopTimer);
      clearTimeout(killTimer);
      clientLines.close();
      serverLines.close();
      input.pause();
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('exit', onProcessExit);
      output.removeListener('drain', onOutputDrain);
      output.removeListener('error', onOutputError);
      output.removeListener('close', onOutputError);
      errors.removeListener('error', onErrorsError);
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error('Codex app-server exited.'));
      }
      pending.clear();
      resolveExit(code ?? 1);
    }
    child.once('error', error => { log(`Could not launch Codex: ${error.message}`); finish(1); });
    child.once('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

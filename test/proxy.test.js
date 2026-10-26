import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../src/state.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'codex-brake.js');
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-codex.js');

async function eventually(check, description, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(10);
  }
}

function usage({ weekly = 85, short = 60, weeklyReset = Math.floor(Date.now() / 1000) + 3600,
  shortReset = Math.floor(Date.now() / 1000) + 1800 } = {}) {
  return { rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: short, windowDurationMins: 300, resetsAt: shortReset },
    secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: weeklyReset },
  } };
}

function fixture(t, initial = usage()) {
  const directory = mkdtempSync(join(tmpdir(), 'resetstop-proxy-'));
  const usagePath = join(directory, 'usage.json');
  const store = new StateStore(join(directory, 'state'));
  const clients = [];
  const setUsage = (value) => {
    writeFileSync(`${usagePath}.tmp`, JSON.stringify(value));
    renameSync(`${usagePath}.tmp`, usagePath);
  };
  setUsage(initial);
  function start(extraEnv = {}) {
    const index = clients.length;
    const logPath = join(directory, `requests-${index}.jsonl`);
    const pidPath = join(directory, `backend-${index}.pid`);
    const proc = spawn(process.execPath, [CLI, 'app-server'], {
      cwd: ROOT,
      env: {
        ...process.env,
        RESETSTOP_CODEX_BINARY: FAKE,
        RESETSTOP_STATE_DIR: store.directory,
        RESETSTOP_POLL_MS: '250',
        RESETSTOP_REQUEST_TIMEOUT_MS: '1000',
        RESETSTOP_STOP_GRACE_MS: '250',
        RESETSTOP_TEST_USAGE: usagePath,
        RESETSTOP_TEST_LOG: logPath,
        RESETSTOP_TEST_PID_FILE: pidPath,
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const messages = [];
    const queue = [];
    let stderr = '';
    let ended = false;
    const exit = new Promise((resolve) => proc.once('exit', (code, signal) => {
      ended = true;
      resolve({ code, signal });
    }));
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.stdin.on('error', () => {});
    const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        const parsed = JSON.parse(line);
        messages.push(parsed);
        queue.push(parsed);
      } catch {
        messages.push({ invalidStdout: line });
      }
    });
    const client = {
      proc, messages, exit,
      get ended() { return ended; },
      get stderr() { return stderr; },
      get backendPid() { return existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : null; },
      send(message) {
        if (ended) throw new Error(`Proxy exited before send: ${stderr}`);
        proc.stdin.write(`${JSON.stringify(message)}\n`);
      },
      async next(predicate, description = 'protocol message', timeout = 4_000) {
        return eventually(() => {
          const index = queue.findIndex(predicate);
          if (index !== -1) return queue.splice(index, 1)[0];
          if (ended) throw new Error(`Proxy exited waiting for ${description}: ${stderr}\n${JSON.stringify(messages)}`);
          return false;
        }, `${description}; stderr: ${stderr}`, timeout);
      },
      async request(id, method, params = {}) {
        this.send({ id, method, params });
        return this.next((message) => message.id === id && !message.method, `${method} response (${id})`);
      },
      async initialize() {
        const response = await this.request('initialize', 'initialize', { clientInfo: { name: 'resetstop-test', version: '1' } });
        assert.ok(response.result, `Initialization failed: ${JSON.stringify(response)}`);
        this.send({ method: 'initialized', params: {} });
      },
      log() {
        if (!existsSync(logPath)) return [];
        return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      },
      async close() {
        if (!ended) proc.stdin.end();
        try { await eventually(() => ended, 'proxy cleanup', 2_000); }
        catch {
          proc.kill('SIGKILL');
          if (existsSync(pidPath)) {
            const pid = Number(readFileSync(pidPath, 'utf8'));
            try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* Already exited. */ }
          }
          await exit;
        }
        // A regression must not leave this detached test backend behind even if
        // its wrapper crashed before it could clean up the process group.
        if (this.backendPid !== null) {
          try { process.kill(process.platform === 'win32' ? this.backendPid : -this.backendPid, 'SIGKILL'); }
          catch { /* The wrapper already cleaned up its backend. */ }
        }
        lines.close();
      },
    };
    clients.push(client);
    return client;
  }
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    store, setUsage, start,
    async baseline() {
      return eventually(() => Object.values(store.read().baselines)[0], 'persisted quota baseline');
    },
  };
}

function assertPrivateResponsesHidden(client) {
  const privateIds = new Set(client.log()
    .filter((message) => ['account/rateLimits/read', 'turn/interrupt', 'thread/goal/set'].includes(message.method))
    .map((message) => message.id));
  assert.equal(client.messages.some((message) => !message.method && privateIds.has(message.id)), false);
  assert.equal(client.messages.some((message) => Object.hasOwn(message, 'invalidStdout')), false);
}

test('work waits for initialization and a verified quota baseline; private RPC stays private', async (t) => {
  const f = fixture(t);
  const client = f.start({ RESETSTOP_TEST_USAGE_DELAY_MS: '300' });
  const early = await client.request('early', 'turn/start', { threadId: 'early-thread' });
  assert.match(early.error.message, /initialization|connects/i);
  assert.equal(client.log().some((message) => message.method === 'turn/start'), false);

  await client.initialize();
  client.send({ id: 0, method: 'turn/start', params: { threadId: 'thread-a' } });
  await eventually(() => client.log().some((message) => message.method === 'account/rateLimits/read'), 'initial quota request');
  assert.equal(client.log().some((message) => message.method === 'turn/start'), false);
  const response = await client.next((message) => message.id === 0 && !message.method, 'buffered turn');
  assert.equal(response.result.turn.status, 'inProgress');
  assert.equal(f.store.read().mode, 'armed');
  assertPrivateResponsesHidden(client);
});

test('client request IDs and server approval IDs survive transparent forwarding', async (t) => {
  const f = fixture(t);
  const client = f.start();
  await client.initialize();
  await f.baseline();
  const response = await client.request('client:string-id', 'thread/read', { threadId: 'thread-a' });
  assert.equal(response.id, 'client:string-id');
  assert.deepEqual(response.result.echo, { threadId: 'thread-a' });
  const serverRequest = {
    id: 'approval:42', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a' },
  };
  await client.request(42, 'test/serverRequest', { message: serverRequest });
  assert.deepEqual(await client.next((message) => message.method === serverRequest.method), serverRequest);
  client.send({ id: serverRequest.id, result: { decision: 'accept' } });
  const forwarded = await eventually(() => client.log().find((message) => message.id === serverRequest.id && !message.method), 'approval response to Codex');
  assert.deepEqual(forwarded.result, { decision: 'accept' });
  assertPrivateResponsesHidden(client);
});

test('five-hour replenishment is ignored; weekly replenishment interrupts and latches', async (t) => {
  const initial = usage();
  const f = fixture(t, initial);
  const client = f.start();
  await client.initialize();
  await client.request('start', 'turn/start', { threadId: 'thread-a' });
  f.setUsage(usage({ weekly: 85, short: 1, weeklyReset: initial.rateLimits.secondary.resetsAt }));
  await eventually(() => Object.values(f.store.read().baselines).some((snapshot) => snapshot.windows.some((window) => window.window === 'primary' && window.usedPercent === 1)), 'five-hour quota update');
  assert.equal(f.store.read().mode, 'armed');
  assert.equal(client.ended, false);

  f.setUsage(usage({ weekly: 1, short: 1, weeklyReset: initial.rateLimits.secondary.resetsAt }));
  await eventually(() => f.store.read().mode === 'paused', 'weekly pause');
  assert.equal(f.store.read().reason.kind, 'usage-increased');
  await client.next((message) => message.method === 'turn/completed', 'graceful interruption');
  const log = client.log();
  assert.ok(log.some((message) => message.method === 'thread/goal/set' && message.params.status === 'paused'));
  assert.ok(log.some((message) => message.method === 'turn/interrupt' && message.params.threadId === 'thread-a'));
  await eventually(() => client.ended, 'backend shutdown after interruption');
  assertPrivateResponsesHidden(client);
});

test('the weekly reset deadline pauses while idle without a notification or new quota read', async (t) => {
  const f = fixture(t, usage({ weeklyReset: Math.ceil(Date.now() / 1000) + 1 }));
  const client = f.start({ RESETSTOP_POLL_MS: '60000' });
  await client.initialize();
  await f.baseline();
  const reads = () => client.log().filter((message) => message.method === 'account/rateLimits/read').length;
  assert.equal(reads(), 1);
  await eventually(() => f.store.read().mode === 'paused', 'scheduled weekly pause');
  assert.equal(f.store.read().reason.kind, 'scheduled-reset');
  assert.equal(reads(), 1);
  const blocked = await client.request('after-deadline', 'turn/start', { threadId: 'never-started' });
  assert.match(blocked.error.message, /paused/i);
  assert.equal(client.log().some((message) => message.method === 'turn/start'), false);
});

test('one reset stops two wrappers, remains paused after restart, and off restores passthrough', async (t) => {
  const initial = usage({ weeklyReset: null, shortReset: null });
  const f = fixture(t, initial);
  const first = f.start();
  const second = f.start();
  await Promise.all([first.initialize(), second.initialize()]);
  await Promise.all([
    first.request('work-a', 'turn/start', { threadId: 'thread-a' }),
    second.request('work-b', 'turn/start', { threadId: 'thread-b' }),
  ]);
  f.setUsage(usage({ weekly: 0, weeklyReset: null, shortReset: null }));
  await eventually(() => f.store.read().mode === 'paused', 'shared reset latch');
  await eventually(() => first.ended && second.ended, 'both wrappers stopped');
  for (const client of [first, second]) {
    assert.ok(client.log().some((message) => message.method === 'turn/interrupt'));
    assertPrivateResponsesHidden(client);
  }

  const restarted = f.start();
  await restarted.initialize();
  const blocked = await restarted.request('blocked', 'turn/start', { threadId: 'thread-c' });
  assert.match(blocked.error.message, /paused/i);
  assert.equal(restarted.log().some((message) => message.method === 'turn/start'), false);
  assert.equal(restarted.log().some((message) => message.method === 'account/rateLimits/read'), false);
  f.store.control('off');
  const allowed = await restarted.request('allowed', 'turn/start', { threadId: 'thread-c' });
  assert.equal(allowed.result.turn.status, 'inProgress');
  assert.equal(f.store.read().mode, 'off');
});

test('uncooperative active turns lose their backend after the graceful stop deadline', async (t) => {
  const f = fixture(t, usage({ weeklyReset: null }));
  const client = f.start({ RESETSTOP_TEST_IGNORE_INTERRUPT: '1' });
  await client.initialize();
  await client.request('work', 'turn/start', { threadId: 'thread-a' });
  f.setUsage(usage({ weekly: 0, weeklyReset: null }));
  await eventually(() => f.store.read().mode === 'paused', 'fallback quota reset');
  await eventually(() => client.ended, 'forced backend shutdown');
  assert.ok(client.log().some((message) => message.method === 'turn/interrupt'));
  assert.equal(client.messages.some((message) => message.method === 'turn/completed'), false);
  assertPrivateResponsesHidden(client);
});

test('unavailable monitoring fails closed before work starts', async (t) => {
  const f = fixture(t);
  const client = f.start({ RESETSTOP_TEST_USAGE_ERROR: 'rate limit service unavailable' });
  await client.initialize();
  const response = await client.request('work', 'turn/start', { threadId: 'thread-a' });
  assert.match(response.error.message, /monitoring failed/i);
  assert.equal(f.store.read().mode, 'paused');
  assert.equal(f.store.read().reason.kind, 'monitor-unavailable');
  assert.equal(client.log().some((message) => message.method === 'turn/start'), false);
  assertPrivateResponsesHidden(client);
});

test('a five-hour-only snapshot cannot verify a weekly guard', async (t) => {
  const snapshot = usage();
  delete snapshot.rateLimits.secondary;
  const f = fixture(t, snapshot);
  const client = f.start();
  await client.initialize();
  const response = await client.request('work', 'turn/start', { threadId: 'thread-a' });
  assert.ok(response.error, 'Work must remain blocked when the selected weekly quota is missing');
  assert.equal(f.store.read().mode, 'paused');
  assert.equal(f.store.read().reason.kind, 'monitor-unavailable');
  assert.equal(client.log().some((message) => message.method === 'turn/start'), false);
});

test('sampling cancellation reaches the original request after transport ID remapping', async (t) => {
  const f = fixture(t);
  const client = f.start();
  await client.initialize();
  await f.baseline();
  client.send({ id: 17, method: 'thread/sample', params: { threadId: 'thread-a', input: [] } });
  await eventually(() => client.log().some((message) => message.method === 'thread/sample'), 'pending sample on backend');
  const cancellation = await client.request('cancel-sample', 'thread/sample/cancel', { requestId: 17 });
  assert.deepEqual(cancellation.result, { cancelled: true });
  const sample = await client.next((message) => message.id === 17 && !message.method, 'cancelled sample response');
  assert.equal(sample.error.code, -32800);
  const log = client.log();
  assert.equal(log.find((message) => message.method === 'thread/sample/cancel').params.requestId,
    log.find((message) => message.method === 'thread/sample').id);
  assertPrivateResponsesHidden(client);
});

test('a cached quota notification cannot falsely pause an unchanged authoritative allowance', async (t) => {
  const f = fixture(t, usage({ weekly: 85 }));
  const client = f.start();
  await client.initialize();
  await f.baseline();
  const before = client.log().filter((message) => message.method === 'account/rateLimits/read').length;
  await client.request('cached-notification', 'test/notify', {
    method: 'account/rateLimits/updated', params: usage({ weekly: 0 }),
  });
  await client.next((message) => message.method === 'account/rateLimits/updated', 'cached quota notification');
  await eventually(() => client.log().filter((message) => message.method === 'account/rateLimits/read').length > before,
    'authoritative quota refresh after the notification');
  const work = await client.request('work', 'turn/start', { threadId: 'thread-a' });
  assert.equal(work.result?.turn.status, 'inProgress');
  assert.equal(f.store.read().mode, 'armed');
  assert.equal(Object.values(f.store.read().baselines)[0].windows.find((window) => window.window === 'secondary').usedPercent, 85);
});

test('an account change invalidates a delayed quota reply before it can allow queued work', async (t) => {
  const f = fixture(t, { ...usage({ weekly: 85 }), accountId: 'old-account' });
  const client = f.start({ RESETSTOP_TEST_HOLD_QUOTA: '1', RESETSTOP_POLL_MS: '60000' });
  await client.initialize();
  const reads = () => client.log().filter((message) => message.method === 'account/rateLimits/read');
  await eventually(() => reads().length === 1, 'old account quota read');
  f.setUsage({ ...usage({ weekly: 10 }), accountId: 'new-account' });
  await client.request('account-changed', 'test/notify', { method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
  await client.next((message) => message.method === 'account/updated', 'account change notification');
  client.send({ id: 'queued-work', method: 'turn/start', params: { threadId: 'thread-a' } });
  await client.request('release-old', 'test/releaseQuota', { count: 1 });
  await eventually(() => reads().length === 2, 'fresh account quota read');
  assert.equal(client.log().some((message) => message.method === 'turn/start'), false);
  assert.deepEqual(f.store.read().baselines, {});

  await client.request('release-new', 'test/releaseQuota', { count: 1 });
  const response = await client.next((message) => message.id === 'queued-work' && !message.method, 'work after fresh account verification');
  assert.equal(response.result?.turn.status, 'inProgress');
  assert.equal(Object.values(f.store.read().baselines)[0].accountId, 'new-account');
  assert.equal(f.store.read().mode, 'armed');
  assertPrivateResponsesHidden(client);
});

test('rearming during the pause grace period cancels shutdown of newly resumed work', async (t) => {
  const f = fixture(t);
  const client = f.start({ RESETSTOP_STOP_GRACE_MS: '1000' });
  await client.initialize();
  await client.request('first-work', 'turn/start', { threadId: 'thread-a' });
  f.store.control('paused', { reason: { message: 'Manual test pause' } });
  await client.next((message) => message.method === 'turn/completed', 'first turn interrupted');
  f.store.control('armed');
  const resumed = await client.request('resumed-work', 'turn/start', { threadId: 'thread-a' });
  assert.equal(resumed.result?.turn.status, 'inProgress');
  // Keep a real protocol request outstanding beyond the former shutdown deadline.
  const stillConnected = await client.request('after-old-deadline', 'test/delay', { ms: 1200 });
  assert.deepEqual(stillConnected.result, {});
  assert.equal(f.store.read().mode, 'armed');
  assert.equal(client.ended, false);
});

test('a broken client stdout pipe terminates the detached backend', async (t) => {
  const f = fixture(t);
  const client = f.start();
  await client.initialize();
  await client.request('work', 'turn/start', { threadId: 'thread-a' });
  const backendPid = client.backendPid;
  assert.ok(backendPid > 0);
  client.proc.stdout.destroy();
  client.send({ id: 'write-to-closed-pipe', method: 'thread/read', params: { threadId: 'thread-a' } });
  await eventually(() => client.ended, 'wrapper exit after broken stdout');
  await eventually(() => {
    try { process.kill(backendPid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }, 'detached backend cleanup after broken stdout');
});

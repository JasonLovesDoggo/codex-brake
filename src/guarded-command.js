import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { positiveInteger, runProxy } from './proxy.js';

function monitorArguments(args) {
  const result = ['app-server'];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '--profile' || arg.startsWith('--profile=') || (arg.startsWith('-p') && !arg.startsWith('--'))) {
      throw new Error('Guarded CLI commands cannot use --profile/-p because app-server cannot mirror that context. Use CODEX_HOME or explicit --config overrides, or run "codex-brake off" to disable protection.');
    }
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      const value = args[++index];
      if (value === undefined || value === '--') throw new Error(`${arg} needs a value for the usage monitor.`);
      result.push(arg, value);
    } else if (arg === '--strict-config' || arg.startsWith('--config=') || arg.startsWith('--enable=') || arg.startsWith('--disable=')) {
      result.push(arg);
    } else if (arg.startsWith('-c') && !arg.startsWith('--')) {
      // Keep Clap's attached-value spelling, including -c=VALUE, intact.
      result.push(arg);
    }
  }
  return result;
}

/** Monitor the account independently while a noninteractive Codex CLI command runs. */
export function runGuardedCommand({ binary, args, store, env = process.env }) {
  if (!['exec', 'review'].includes(args?.[0])) {
    throw new TypeError('Only noninteractive Codex exec and review commands can use the command guard.');
  }
  if (store.read().mode === 'paused') {
    throw new Error('Codex Brake is paused. Run "codex-brake resume" before starting CLI work.');
  }
  const monitorArgs = monitorArguments(args);
  const requestMs = positiveInteger(env.RESETSTOP_REQUEST_TIMEOUT_MS, 10_000, 'RESETSTOP_REQUEST_TIMEOUT_MS');
  const graceMs = positiveInteger(env.RESETSTOP_STOP_GRACE_MS, 1_000, 'RESETSTOP_STOP_GRACE_MS');
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  const initializeId = `resetstop-command:${randomUUID()}`;

  return new Promise(resolveExit => {
    let command;
    let commandExited = false;
    let commandCode = null;
    let monitorDone = false;
    let closingMonitor = false;
    let initialized = false;
    let stopping = false;
    let settled = false;
    let failureCode = null;
    let killTimer;
    let initializeTimer;

    function log(message) { process.stderr.write(`[codex-brake] ${message}\n`); }
    function signalCommand(signal) {
      if (!command?.pid) return;
      try { process.kill(process.platform === 'win32' ? command.pid : -command.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') log(`Could not send ${signal} to CLI work: ${error.message}`); }
    }
    function closeMonitor() {
      if (closingMonitor) return;
      closingMonitor = true;
      clearTimeout(initializeTimer);
      input.end();
    }
    function finishIfReady() {
      if (settled || !monitorDone || (command && !commandExited) || killTimer) return;
      settled = true;
      clearTimeout(initializeTimer);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      process.removeListener('exit', onExit);
      lines.close();
      input.destroy();
      output.destroy();
      resolveExit(failureCode ?? commandCode ?? 1);
    }
    function fail(message, code = 1, monitorFailure = false) {
      if (stopping || settled) return;
      stopping = true;
      failureCode = code;
      log(message);
      if (monitorFailure) {
        try {
          const current = store.read();
          store.pause({ kind: 'monitor-unavailable', detectedAt: Date.now(), message }, current.generation);
        } catch (error) { log(`Could not persist the monitoring failure: ${error.message}`); }
      }
      if (command?.pid) {
        signalCommand('SIGTERM');
        // Keep this timer even if the launcher exits: its native child may ignore SIGTERM.
        killTimer = setTimeout(() => {
          signalCommand('SIGKILL');
          killTimer = undefined;
          finishIfReady();
        }, graceMs);
      }
      closeMonitor();
      finishIfReady();
    }
    function onInterrupt() { fail('CLI work interrupted.', 130); }
    function onTerminate() { fail('CLI work terminated.', 143); }
    function onExit() { signalCommand('SIGKILL'); }
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    process.once('exit', onExit);

    function onStatus({ state, verified }) {
      if (stopping || settled) return;
      if (state.mode === 'paused') {
        fail(`Stopping CLI work: ${state.reason?.message || 'Codex Brake is paused.'}`);
        return;
      }
      if (command || !(state.mode === 'off' || (state.mode === 'armed' && verified))) return;
      try {
        // A user may pause or rearm between verification and this callback.
        const current = store.read();
        if (current.mode === 'paused') {
          fail(`Stopping CLI work: ${current.reason?.message || 'Codex Brake is paused.'}`);
          return;
        }
        if (current.mode === 'armed' && current.generation !== state.generation) return;
        command = spawn(binary, args, {
          env,
          stdio: 'inherit',
          detached: process.platform !== 'win32',
        });
        command.once('error', error => fail(`Could not launch Codex CLI work: ${error.message}`));
        command.once('close', (code, signal) => {
          commandExited = true;
          commandCode = code ?? (signal ? 1 : 0);
          closeMonitor();
          finishIfReady();
        });
      } catch (error) {
        fail(`Could not start monitored CLI work: ${error.message}`);
      }
    }

    lines.on('line', line => {
      if (stopping || closingMonitor || !line.trim()) return;
      let message;
      try { message = JSON.parse(line); }
      catch { fail('Usage monitor returned invalid protocol data.', 1, true); return; }
      if (message.id === initializeId && !message.method) {
        if (message.error || !message.result || typeof message.result !== 'object') {
          fail(`Usage monitor initialization failed: ${message.error?.message || 'invalid initialize response'}`, 1, true);
          return;
        }
        if (initialized) return;
        initialized = true;
        clearTimeout(initializeTimer);
        input.write(`${JSON.stringify({ method: 'initialized' })}\n`);
      } else if (message.method && message.id !== undefined) {
        fail(`Usage monitor requires an unsupported client request: ${message.method}`, 1, true);
      }
    });
    input.on('error', error => fail(`Usage monitor input failed: ${error.message}`, 1, true));
    output.on('error', error => fail(`Usage monitor output failed: ${error.message}`, 1, true));

    try {
      const monitor = runProxy({ binary, args: monitorArgs, store, env, input, output, onStatus });
      initializeTimer = setTimeout(() => fail('Usage monitor initialization timed out.', 1, true), requestMs);
      input.write(`${JSON.stringify({
        id: initializeId,
        method: 'initialize',
        params: { clientInfo: { name: 'codex-brake', version: '0.2.0' }, capabilities: { experimentalApi: true } },
      })}\n`);
      Promise.resolve(monitor).then(() => {
        monitorDone = true;
        if (!closingMonitor) fail('Usage monitor exited unexpectedly; stopping CLI work.', 1, true);
        finishIfReady();
      }, error => {
        monitorDone = true;
        fail(`Usage monitor failed: ${error.message}`, 1, true);
        finishIfReady();
      });
    } catch (error) {
      monitorDone = true;
      fail(`Could not start the usage monitor: ${error.message}`, 1, true);
    }
  });
}

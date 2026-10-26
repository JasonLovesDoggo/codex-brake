#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, getStateDirectory } from '../src/state.js';
import { runProxy } from '../src/proxy.js';
import { installT3 } from '../src/install.js';
import { runGuardedCommand } from '../src/guarded-command.js';
import { guardEnvironment } from '../src/environment.js';

const args = process.argv.slice(2);
const command = args[0];
const env = guardEnvironment();
const usage = `Codex Brake — pause at the next weekly usage reset.

  codex-brake arm [--window weekly|five-hour|either]
  codex-brake resume [--window weekly|five-hour|either]
  codex-brake pause
  codex-brake off
  codex-brake status [--json]
  codex-brake install-t3 [--settings PATH]

Run codex-brake exec "your task", or set your app's Codex executable to this tool.
exec, review, and stdio app-server are monitored. --version reports Codex's version.
Use CODEX_BRAKE_CODEX_BINARY to select the real executable (default: codex).
Use CODEX_BRAKE_STATE_DIR to select the shared state directory.
`;

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value.`);
  return args[index + 1];
}

function validateOptions(allowed) {
  for (let i = 1; i < args.length; i++) {
    const value = allowed[args[i]];
    if (value === undefined) throw new Error(`Unexpected argument: ${args[i]}. Run codex-brake help.`);
    if (value) { option(args[i]); i++; }
  }
}

function printState(state, store) {
  const windows = Object.values(state.baselines).flatMap(snapshot => snapshot.windows || [])
    .filter(window => state.window === 'either' || (window.durationMins === null
      ? window.window === (state.window === 'weekly' ? 'secondary' : 'primary')
      : window.durationMins === (state.window === 'weekly' ? 10080 : 300)));
  const deadlines = windows.map(window => window.deadline).filter(value => typeof value === 'number');
  console.log(`Codex Brake: ${state.mode} (${state.window})`);
  if (state.reason?.message) console.log(state.reason.message);
  if (state.mode === 'armed') {
    console.log(deadlines.length ? `Stop deadline: ${new Date(Math.min(...deadlines)).toLocaleString()}`
      : windows.length ? 'Watching for an increase in remaining allowance; no reset time reported.'
        : 'Waiting for a wrapped Codex session to read the usage allowance.');
  }
  console.log(`State: ${store.path}`);
}

function realBinary() {
  const binary = env.RESETSTOP_CODEX_BINARY || 'codex';
  const candidates = binary.includes('/') || binary.includes('\\') ? [resolve(binary)]
    : (env.PATH || '').split(delimiter).map(directory => resolve(directory, binary));
  const ownPath = realpathSync(fileURLToPath(import.meta.url));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === ownPath) throw new Error('CODEX_BRAKE_CODEX_BINARY points back to codex-brake; select the real Codex executable.');
      return candidate;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error(`Cannot find Codex executable ${JSON.stringify(binary)}. Set CODEX_BRAKE_CODEX_BINARY to its absolute path.`);
}

function passthrough(binary) {
  return new Promise(resolveExit => {
    const child = spawn(binary, args, { stdio: 'inherit', env });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', error => { console.error(error.message); resolveExit(1); });
    child.once('close', code => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      resolveExit(code ?? 1);
    });
  });
}

async function main() {
  if (['help', '--help', '-h'].includes(command)) { console.log(usage); return 0; }
  const store = new StateStore(getStateDirectory(env));
  if (command === 'status') {
    validateOptions({ '--json': false });
    const state = store.read();
    if (args.includes('--json')) console.log(JSON.stringify(state, null, 2));
    else printState(state, store);
    return 0;
  }
  if (['arm', 'resume', 'pause', 'off'].includes(command)) {
    validateOptions(command === 'arm' || command === 'resume' ? { '--window': true } : {});
    const mode = command === 'arm' || command === 'resume' ? 'armed' : command === 'pause' ? 'paused' : 'off';
    const state = store.control(mode, {
      window: option('--window'),
      reason: mode === 'paused' ? { kind: 'manual', message: 'Paused by you.', detectedAt: Date.now() } : null,
    });
    printState(state, store);
    return 0;
  }
  if (command === 'install-t3') {
    validateOptions({ '--settings': true });
    const result = installT3({ settingsPath: option('--settings'), binaryPath: resolve(process.argv[1]) });
    console.log(`${result.alreadyInstalled ? 'Already configured' : 'Configured'} T3 Codex Binary path: ${result.binaryPath}`);
    if (result.backupPath) console.log(`Original settings: ${result.backupPath}`);
    const previousIsWrapper = result.previousBinaryPath && (() => {
      try { return realpathSync(result.previousBinaryPath) === realpathSync(process.argv[1]); }
      catch { return false; }
    })();
    if (!result.alreadyInstalled && result.previousBinaryPath && result.previousBinaryPath !== 'codex' && !previousIsWrapper) {
      console.log(`Previous Codex executable: ${result.previousBinaryPath}. Set CODEX_BRAKE_CODEX_BINARY to this path in T3's provider environment to keep using it.`);
    }
    console.log('Restart T3 Codex sessions to activate protection. Existing processes keep their previous executable.');
    return 0;
  }
  const binary = realBinary();
  const state = store.read();
  if (command === 'app-server') {
    if (args.some(arg => ['daemon', 'proxy'].includes(arg))) {
      throw new Error('Codex Brake must own its Codex backend. app-server daemon/proxy modes are not supported.');
    }
    const listen = option('--listen') || args.find(arg => arg.startsWith('--listen='))?.slice('--listen='.length);
    if (listen && listen !== 'stdio://') throw new Error('Codex Brake requires app-server stdio transport; WebSocket listeners are not supported.');
    // app-server schema generators produce a document, not a JSONL connection.
    if (args.includes('generate-ts') || args.includes('generate-json-schema') || args.includes('--help')) {
      return passthrough(binary);
    }
    return runProxy({ binary, args, store, env });
  }
  if (['exec', 'review'].includes(command) && state.mode !== 'off') {
    return runGuardedCommand({ binary, args, store, env });
  }
  const harmless = ['--version', '-V', 'login', 'logout', 'mcp', 'completion', 'features'].includes(command);
  if (!harmless && state.mode !== 'off') {
    throw new Error(`This Codex mode is blocked while Codex Brake is ${state.mode}. Use exec, review, or stdio app-server, or run "codex-brake off" to disable protection.`);
  }
  return passthrough(binary);
}

try { process.exitCode = await main(); }
catch (error) { console.error(`[codex-brake] ${error.message}`); process.exitCode = 1; }

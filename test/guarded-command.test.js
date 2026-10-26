import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { StateStore } from '../src/state.js';
import { runGuardedCommand } from '../src/guarded-command.js';

function fixture(t, extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'resetstop-command-'));
  const binary = join(directory, 'fake-codex');
  const logPath = join(directory, 'events.jsonl');
  const store = new StateStore(join(directory, 'state'));
  const script = `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
const { createInterface } = require('node:readline');
const { spawn } = require('node:child_process');
const log = (event, data = {}) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ event, pid: process.pid, ...data }) + '\\n');
if (process.argv[2] === 'app-server') {
  log('monitor-start', { args: process.argv.slice(2) });
  let count = 0;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      log('initialize');
      if (process.env.FIXTURE_SCENARIO === 'init-hang') return;
      if (process.env.FIXTURE_SCENARIO === 'init-error') {
        process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'fixture init failure' } }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n');
    } else if (message.method === 'account/rateLimits/read') {
      count++;
      log('usage-read', { count });
      if (process.env.FIXTURE_SCENARIO === 'read-error') {
        process.stdout.write(JSON.stringify({ id: message.id, error: { code: -1, message: 'fixture usage failure' } }) + '\\n');
        return;
      }
      const used = process.env.FIXTURE_SCENARIO === 'reset' && count > 1 ? 1 : 80;
      process.stdout.write(JSON.stringify({ id: message.id, result: { rateLimits: { limitId: 'codex', secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: null } } } }) + '\\n');
      if (process.env.FIXTURE_SCENARIO === 'monitor-crash') setTimeout(() => process.exit(12), 100);
    }
  });
} else if (['exec', 'review'].includes(process.argv[2])) {
  log('command-start', { args: process.argv.slice(2) });
  if (process.env.FIXTURE_DESCENDANT === '1') {
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
    log('descendant-start', { childPid: descendant.pid });
  }
  process.on('SIGTERM', () => { log('command-term'); process.exit(0); });
  setTimeout(() => process.exit(Number(process.env.FIXTURE_EXIT_CODE || 0)), Number(process.env.FIXTURE_COMMAND_MS || 30));
} else process.exit(90);
`;
  writeFileSync(binary, script, { mode: 0o700 });
  function events() {
    return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  t.after(() => {
    for (const event of events()) {
      if (event.event === 'monitor-start' || event.event === 'command-start' || event.event === 'descendant-start') {
        const pid = event.childPid || event.pid;
        try { process.kill(process.platform === 'win32' || event.childPid ? pid : -pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    binary, store, events,
    env: { ...process.env, FIXTURE_LOG: logPath, RESETSTOP_POLL_MS: '250', RESETSTOP_REQUEST_TIMEOUT_MS: '1000', RESETSTOP_STOP_GRACE_MS: '80', ...extraEnv },
  };
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    // Linux may briefly retain a killed orphan as a zombie until PID 1 reaps it.
    if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z ')) return false;
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes(error.code)) return false;
    throw error;
  }
}

async function eventually(check, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for command process cleanup');
    await delay(10);
  }
}

test('exec starts only after the initial quota read and preserves its exit code', async (t) => {
  const input = fixture(t, { FIXTURE_EXIT_CODE: '7' });
  const sigint = process.listenerCount('SIGINT');
  const sigterm = process.listenerCount('SIGTERM');
  const exit = process.listenerCount('exit');
  assert.equal(await runGuardedCommand({ ...input, args: ['exec', '--model', 'fixture', '-'] }), 7);
  const events = input.events();
  assert.ok(events.findIndex(event => event.event === 'usage-read') < events.findIndex(event => event.event === 'command-start'));
  assert.deepEqual(events.find(event => event.event === 'command-start').args, ['exec', '--model', 'fixture', '-']);
  assert.equal(input.store.read().mode, 'armed');
  assert.equal(process.listenerCount('SIGINT'), sigint);
  assert.equal(process.listenerCount('SIGTERM'), sigterm);
  assert.equal(process.listenerCount('exit'), exit);
});

test('the monitor receives CLI config and feature overrides while preserving the original command arguments', async (t) => {
  const input = fixture(t);
  const args = [
    'exec', '--config', 'model_provider="fixture"', '-c', 'auth.example=true',
    '-cmodel_reasoning_effort="low"', '-c=auth.keep=true', '--config=example=false',
    '--enable', 'feature_a', '--disable', 'feature_b', '--enable=feature_c', '--disable=feature_d',
    '--strict-config', '--model', 'fixture-model', '--', '--profile', 'this is prompt text', '-cfake_prompt=true',
  ];
  assert.equal(await runGuardedCommand({ ...input, args }), 0);
  assert.deepEqual(input.events().find(event => event.event === 'monitor-start').args, [
    'app-server', '--config', 'model_provider="fixture"', '-c', 'auth.example=true',
    '-cmodel_reasoning_effort="low"', '-c=auth.keep=true', '--config=example=false',
    '--enable', 'feature_a', '--disable', 'feature_b', '--enable=feature_c', '--disable=feature_d', '--strict-config',
  ]);
  assert.deepEqual(input.events().find(event => event.event === 'command-start').args, args);
});

test('unsupported profiles and incomplete config flags fail before any process launches', (t) => {
  const input = fixture(t);
  for (const args of [
    ['exec', '--profile', 'work'], ['exec', '--profile=work'], ['exec', '-p', 'work'], ['exec', '-pwork'],
  ]) assert.throws(() => runGuardedCommand({ ...input, args }), /cannot use --profile/);
  assert.throws(() => runGuardedCommand({ ...input, args: ['exec', '-c'] }), /needs a value/);
  assert.deepEqual(input.events(), []);
});

test('noninteractive review also runs under a verified monitor', async (t) => {
  const input = fixture(t);
  assert.equal(await runGuardedCommand({ ...input, args: ['review', '--uncommitted'] }), 0);
  assert.ok(input.events().some(event => event.event === 'usage-read'));
  assert.deepEqual(input.events().find(event => event.event === 'command-start').args, ['review', '--uncommitted']);
});

test('an already-paused guard refuses before launching either process', (t) => {
  const input = fixture(t);
  input.store.control('paused');
  assert.throws(() => runGuardedCommand({ ...input, args: ['exec', '-'] }), /Codex Brake is paused/);
  assert.deepEqual(input.events(), []);
});

test('interactive commands cannot use the guarded command path', (t) => {
  const input = fixture(t);
  assert.throws(() => runGuardedCommand({ ...input, args: ['resume', 'thread'] }), /Only noninteractive/);
  assert.deepEqual(input.events(), []);
});

for (const scenario of ['init-error', 'init-hang', 'read-error']) {
  test(`${scenario} fails closed before inference starts`, async (t) => {
    const input = fixture(t, { FIXTURE_SCENARIO: scenario, RESETSTOP_REQUEST_TIMEOUT_MS: '150' });
    assert.notEqual(await runGuardedCommand({ ...input, args: ['exec', '-'] }), 0);
    assert.equal(input.events().some(event => event.event === 'command-start'), false);
    assert.equal(input.store.read().mode, 'paused');
  });
}

test('an observed allowance increase terminates the CLI process group including a surviving descendant', { skip: process.platform === 'win32' }, async (t) => {
  const input = fixture(t, { FIXTURE_SCENARIO: 'reset', FIXTURE_DESCENDANT: '1', FIXTURE_COMMAND_MS: '10000' });
  assert.notEqual(await runGuardedCommand({ ...input, args: ['exec', '-'] }), 0);
  const events = input.events();
  assert.ok(events.some(event => event.event === 'command-term'));
  const commandPid = events.find(event => event.event === 'command-start')?.pid;
  const childPid = events.find(event => event.event === 'descendant-start')?.childPid;
  assert.ok(commandPid && childPid);
  await eventually(() => !isRunning(commandPid) && !isRunning(childPid));
  assert.equal(input.store.read().mode, 'paused');
  assert.equal(input.store.read().reason.kind, 'usage-increased');
});

test('unexpected monitor exit kills running CLI work and latches a pause', async (t) => {
  const input = fixture(t, { FIXTURE_SCENARIO: 'monitor-crash', FIXTURE_COMMAND_MS: '10000' });
  assert.notEqual(await runGuardedCommand({ ...input, args: ['exec', '-'] }), 0);
  const pid = input.events().find(event => event.event === 'command-start')?.pid;
  assert.ok(pid);
  await eventually(() => !isRunning(pid));
  assert.equal(input.store.read().mode, 'paused');
  assert.equal(input.store.read().reason.kind, 'monitor-unavailable');
});

test('a manual pause from another process stops auxiliary CLI work', async (t) => {
  const input = fixture(t, { FIXTURE_COMMAND_MS: '10000' });
  const result = runGuardedCommand({ ...input, args: ['exec', '-'] });
  await eventually(() => input.events().some(event => event.event === 'command-start'));
  new StateStore(input.store.directory).control('paused', { reason: { kind: 'manual', message: 'fixture pause' } });
  assert.notEqual(await result, 0);
  const pid = input.events().find(event => event.event === 'command-start').pid;
  await eventually(() => !isRunning(pid));
});

test('parent SIGTERM stops the monitor and CLI group despite an unused stdin at EOF', { skip: process.platform === 'win32' }, async (t) => {
  const input = fixture(t, { FIXTURE_DESCENDANT: '1', FIXTURE_COMMAND_MS: '10000' });
  const script = `
    import { runGuardedCommand } from ${JSON.stringify(new URL('../src/guarded-command.js', import.meta.url).href)};
    import { StateStore } from ${JSON.stringify(new URL('../src/state.js', import.meta.url).href)};
    process.exitCode = await runGuardedCommand({ binary: process.env.FIXTURE_BINARY, args: ['exec', '-'], store: new StateStore(process.env.RESETSTOP_STATE_DIR) });
  `;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...input.env, FIXTURE_BINARY: input.binary, RESETSTOP_STATE_DIR: input.store.directory },
    stdio: 'ignore',
  });
  t.after(() => { if (wrapper.exitCode === null) wrapper.kill('SIGKILL'); });
  const result = new Promise(resolveExit => wrapper.once('exit', (code, signal) => resolveExit({ code, signal })));
  await eventually(() => input.events().some(event => event.event === 'descendant-start'));
  wrapper.kill('SIGTERM');
  assert.deepEqual(await result, { code: 143, signal: null });
  const events = input.events();
  const pids = [
    events.find(event => event.event === 'monitor-start').pid,
    events.find(event => event.event === 'command-start').pid,
    events.find(event => event.event === 'descendant-start').childPid,
  ];
  await eventually(() => pids.every(pid => !isRunning(pid)));
});

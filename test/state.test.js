import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StateStore, getStateDirectory } from '../src/state.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'resetstop-state-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new StateStore(directory) };
}

function child(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (data) => { stdout += data; });
    proc.stderr.on('data', (data) => { stderr += data; });
    proc.on('error', reject);
    proc.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Child exited ${code}: ${stderr}`)));
  });
}

test('state directory honors overrides and XDG defaults', () => {
  assert.equal(getStateDirectory({ RESETSTOP_STATE_DIR: '/tmp/guard', XDG_STATE_HOME: '/other' }), '/tmp/guard');
  assert.equal(getStateDirectory({ XDG_STATE_HOME: '/tmp/state' }), '/tmp/state/codex-resetstop');
  assert.equal(getStateDirectory({ HOME: '/tmp/home' }), '/tmp/home/.local/state/codex-resetstop');
});

test('first read creates persistent armed weekly state with private permissions', (t) => {
  const { directory, store } = fixture(t);
  const initial = store.read();
  assert.equal(initial.version, 1);
  assert.equal(initial.mode, 'armed');
  assert.equal(initial.window, 'weekly');
  assert.deepEqual(initial.baselines, {});
  assert.equal(initial.reason, null);
  assert.deepEqual(new StateStore(directory).read(), initial);
  assert.deepEqual(readdirSync(directory), ['state.json']);
  if (process.platform !== 'win32') assert.equal(statSync(store.path).mode & 0o777, 0o600);
});

test('pause is persistent, preserves baselines, and refuses late polls', (t) => {
  const { directory, store } = fixture(t);
  const initial = store.read();
  const baseline = { weekly: { usedPercent: 90, resetsAt: 1_900_000_000 } };
  store.saveBaseline('account-a', baseline, initial.generation);
  const reason = { type: 'reset', window: 'weekly' };
  const paused = store.pause(reason, initial.generation);
  assert.equal(paused.mode, 'paused');
  assert.equal(paused.generation, initial.generation);
  assert.deepEqual(paused.baselines['account-a'], baseline);
  assert.deepEqual(store.saveBaseline('account-a', { weekly: { usedPercent: 1 } }, initial.generation), paused);
  assert.deepEqual(store.pause({ type: 'different' }, initial.generation), paused);
  assert.deepEqual(new StateStore(directory).read(), paused);
});

test('explicit controls rotate generation and discard stale reset callbacks', (t) => {
  const { store } = fixture(t);
  const initial = store.read();
  store.saveBaseline('account', { used: 80 }, initial.generation);
  const armed = store.control('armed', { window: 'either' });
  assert.notEqual(armed.generation, initial.generation);
  assert.deepEqual(armed.baselines, {});
  assert.equal(armed.window, 'either');
  assert.deepEqual(store.pause({ type: 'old-reset' }, initial.generation), armed);
  assert.deepEqual(store.saveBaseline('account', { used: 1 }, initial.generation), armed);
  const paused = store.control('paused', { reason: { type: 'manual' } });
  assert.notEqual(paused.generation, armed.generation);
  assert.equal(paused.mode, 'paused');
  const off = store.control('off');
  assert.equal(off.mode, 'off');
  assert.notEqual(off.generation, paused.generation);
  assert.deepEqual(store.pause({ type: 'reset' }, off.generation), off);
});

test('malformed or unsupported state fails closed without overwriting evidence', (t) => {
  const { store } = fixture(t);
  const valid = store.read();
  const invalid = [
    '{broken json',
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, mode: 'unknown' }),
    JSON.stringify({ ...valid, window: 'monthly' }),
    JSON.stringify({ ...valid, generation: 'missing' }),
    JSON.stringify({ ...valid, baselines: [] }),
    JSON.stringify({ ...valid, baselines: { account: null } }),
  ];
  for (const contents of invalid) {
    writeFileSync(store.path, contents);
    assert.throws(() => store.read(), /Cannot read guard state/);
    assert.throws(() => store.control('armed'), /Cannot read guard state/);
    assert.equal(readFileSync(store.path, 'utf8'), contents);
  }
});

test('invalid controls cannot damage valid state', (t) => {
  const { store } = fixture(t);
  const state = store.read();
  assert.throws(() => store.control('invalid'), TypeError);
  assert.throws(() => store.control('armed', { window: 'invalid' }), TypeError);
  assert.throws(() => store.pause(null, state.generation), TypeError);
  assert.throws(() => store.saveBaseline('', {}, state.generation), TypeError);
  assert.deepEqual(store.read(), state);
});

test('dead process lock is recovered without losing state', (t) => {
  const { store } = fixture(t);
  const state = store.read();
  const departed = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(departed.status, 0);
  mkdirSync(store.lockPath, { mode: 0o700 });
  const token = randomUUID();
  writeFileSync(join(store.lockPath, `owner-${departed.pid}-${token}.json`), JSON.stringify({ pid: departed.pid, token }));
  const paused = store.pause({ type: 'reset' }, state.generation);
  assert.equal(paused.mode, 'paused');
  assert.equal(paused.generation, state.generation);
});

test('live lock is not stolen on timeout', (t) => {
  const { store } = fixture(t);
  const initial = store.read();
  mkdirSync(store.lockPath, { mode: 0o700 });
  const owner = `owner-${process.pid}-${randomUUID()}.json`;
  writeFileSync(join(store.lockPath, owner), '{}');
  assert.throws(() => store.control('off'), /Timed out waiting/);
  assert.deepEqual(store.read(), initial);
  assert.deepEqual(readdirSync(store.lockPath), [owner]);
});

test('empty lock left by an interrupted release is recovered', (t) => {
  const { store } = fixture(t);
  store.read();
  mkdirSync(store.lockPath, { mode: 0o700 });
  assert.equal(store.control('off').mode, 'off');
});

test('concurrent processes preserve every independent baseline', async (t) => {
  const { directory, store } = fixture(t);
  const { generation } = store.read();
  const script = `
    import { StateStore } from ${JSON.stringify(new URL('../src/state.js', import.meta.url).href)};
    const [directory, generation, index] = process.argv.slice(1);
    const store = new StateStore(directory);
    for (let update = 0; update < 12; update++) {
      store.saveBaseline('scope-' + index, { index: Number(index), update }, generation);
    }
  `;
  await Promise.all(Array.from({ length: 8 }, (_, index) => child(script, [directory, generation, String(index)])));
  const final = store.read();
  assert.equal(Object.keys(final.baselines).length, 8);
  for (let index = 0; index < 8; index++) assert.deepEqual(final.baselines[`scope-${index}`], { index, update: 11 });
  assert.deepEqual(readdirSync(directory), ['state.json']);
});

test('concurrent baseline writers never erase a pause from another process', async (t) => {
  const { directory, store } = fixture(t);
  const { generation } = store.read();
  const script = `
    import { StateStore } from ${JSON.stringify(new URL('../src/state.js', import.meta.url).href)};
    const [directory, generation, index] = process.argv.slice(1);
    const store = new StateStore(directory);
    for (let update = 0; update < 25; update++) {
      if (index === 'pause' && update === 2) store.pause({ type: 'weekly-reset' }, generation);
      else store.saveBaseline('scope-' + index, { update }, generation);
    }
  `;
  await Promise.all(['a', 'b', 'pause', 'c', 'd'].map((index) => child(script, [directory, generation, index])));
  const final = store.read();
  assert.equal(final.mode, 'paused');
  assert.deepEqual(final.reason, { type: 'weekly-reset' });
  assert.deepEqual(readdirSync(directory), ['state.json']);
});

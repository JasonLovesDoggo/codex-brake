import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'resetstop-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return (...args) => spawnSync(process.execPath, ['bin/codex-brake.js', ...args], {
    encoding: 'utf8', timeout: 5_000,
    env: { ...process.env, RESETSTOP_STATE_DIR: directory, RESETSTOP_CODEX_BINARY: resolve('test/fixtures/fake-codex.js') },
  });
}

test('CLI controls preserve a weekly pause until explicit resume', t => {
  const run = harness(t);
  let status = JSON.parse(run('status', '--json').stdout);
  assert.equal(status.mode, 'armed');
  assert.equal(status.window, 'weekly');
  assert.equal(run('pause').status, 0);
  status = JSON.parse(run('status', '--json').stdout);
  assert.equal(status.mode, 'paused');
  assert.equal(run('resume').status, 0);
  status = JSON.parse(run('status', '--json').stdout);
  assert.equal(status.mode, 'armed');
  assert.equal(status.window, 'weekly');
  assert.deepEqual(status.baselines, {});
  assert.equal(run('off').status, 0);
  assert.equal(JSON.parse(run('status', '--json').stdout).mode, 'off');
});

test('invalid controls cannot accidentally clear a pause', t => {
  const run = harness(t);
  run('pause');
  for (const args of [['resume', 'session-id'], ['arm', '--window', 'daily'], ['arm', '--window'], ['off', '--typo']]) {
    assert.equal(run(...args).status, 1);
    assert.equal(JSON.parse(run('status', '--json').stdout).mode, 'paused');
  }
});

test('underlying version works while paused but unmonitored interactive work is blocked', t => {
  const run = harness(t);
  run('pause');
  const version = run('--version');
  assert.equal(version.status, 0);
  assert.match(version.stdout, /codex-cli/);
  assert.match(run().stderr, /blocked/);
  assert.match(run('app-server', '--listen', 'ws:\/\/127.0.0.1:9999').stderr, /stdio/);
});

test('renamed environment settings preserve a legacy pause and select the real executable', t => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-brake-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (env, ...args) => spawnSync(process.execPath, ['bin/codex-brake.js', ...args], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, ...env },
  });
  assert.equal(run({ RESETSTOP_STATE_DIR: directory }, 'pause').status, 0);
  const renamed = {
    CODEX_BRAKE_STATE_DIR: directory,
    RESETSTOP_STATE_DIR: join(directory, 'wrong-state'),
    CODEX_BRAKE_CODEX_BINARY: resolve('test/fixtures/fake-codex.js'),
    RESETSTOP_CODEX_BINARY: '/nonexistent/legacy-codex',
  };
  assert.equal(JSON.parse(run(renamed, 'status', '--json').stdout).mode, 'paused');
  assert.match(run(renamed, '--version').stdout, /codex-cli/);
  assert.equal(run(renamed, 'resume').status, 0);
  assert.equal(JSON.parse(run({ RESETSTOP_STATE_DIR: directory }, 'status', '--json').stdout).mode, 'armed');
});

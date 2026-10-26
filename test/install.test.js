import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installT3 } from '../src/install.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'resetstop-install-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binaryPath = join(directory, 'wrapper');
  const settingsPath = join(directory, 'settings.json');
  writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  return { directory, binaryPath, settingsPath };
}

test('installs the Codex path while preserving other settings and original backup bytes', (t) => {
  const input = fixture(t);
  const settings = {
    appearance: { theme: 'night' },
    providerInstances: {
      codex: {
        driver: 'codex',
        enabled: false,
        displayName: 'Personal',
        environment: [{ name: 'SAMPLE', value: 'preserved' }],
        config: { binaryPath: '/old/codex', homePath: '/private/codex', launchArgs: '-c value=true' },
      },
      other: { driver: 'unrecognized', config: { futureProperty: true } },
    },
  };
  const original = `${JSON.stringify(settings, null, 4)}\n\n`;
  writeFileSync(input.settingsPath, original, { mode: 0o640 });
  const result = installT3(input);
  assert.equal(result.previousBinaryPath, '/old/codex');
  assert.equal(result.alreadyInstalled, false);
  assert.equal(result.binaryPath, input.binaryPath);
  assert.equal(result.settingsPath, input.settingsPath);
  assert.match(result.backupPath, /\.resetstop-backup-.+[0-9a-f-]{36}$/);
  assert.equal(readFileSync(result.backupPath, 'utf8'), original);
  settings.providerInstances.codex.config.binaryPath = input.binaryPath;
  assert.deepEqual(JSON.parse(readFileSync(input.settingsPath, 'utf8')), settings);
  if (process.platform !== 'win32') {
    assert.equal(statSync(input.settingsPath).mode & 0o777, 0o640);
    assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
  }
  assert.equal(readdirSync(input.directory).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('creates missing settings privately and adds a default Codex instance', (t) => {
  const input = fixture(t);
  input.settingsPath = join(input.directory, 'new', 'userdata', 'settings.json');
  const result = installT3(input);
  assert.equal(result.backupPath, null);
  assert.equal(result.previousBinaryPath, 'codex');
  assert.deepEqual(JSON.parse(readFileSync(input.settingsPath, 'utf8')), {
    providerInstances: { codex: { driver: 'codex', config: { binaryPath: input.binaryPath } } },
  });
  if (process.platform !== 'win32') {
    assert.equal(statSync(input.settingsPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(input.directory, 'new', 'userdata')).mode & 0o777, 0o700);
  }
});

test('a repeated install does not rewrite the file or create another backup', (t) => {
  const input = fixture(t);
  writeFileSync(input.settingsPath, '{ "custom": true }\n');
  installT3(input);
  const original = readFileSync(input.settingsPath, 'utf8');
  const originalStat = statSync(input.settingsPath);
  const names = readdirSync(input.directory);
  const result = installT3(input);
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.backupPath, null);
  assert.equal(readFileSync(input.settingsPath, 'utf8'), original);
  assert.equal(statSync(input.settingsPath).mtimeMs, originalStat.mtimeMs);
  assert.deepEqual(readdirSync(input.directory), names);
});

test('refuses managed mode, driver conflicts, and malformed records without changing files', (t) => {
  const input = fixture(t);
  const invalid = [
    ['{broken', /Invalid JSON/],
    ['[]', /JSON object/],
    ['null', /JSON object/],
    [JSON.stringify({ providerInstances: [] }), /provider records/],
    [JSON.stringify({ providerInstances: null }), /provider records/],
    [JSON.stringify({ providerInstances: { other: [] } }), /provider records/],
    [JSON.stringify({ providerInstances: { codex: { driver: 'claude' } } }), /another driver/],
    [JSON.stringify({ providerInstances: { codex: { driver: 'codex', config: null } } }), /config must be an object/],
    [JSON.stringify({ providerInstances: { codex: { driver: 'codex', config: [] } } }), /config must be an object/],
    [JSON.stringify({ providerInstances: { codex: { driver: 'codex', config: { binaryPath: 123 } } } }), /binaryPath must be a string/],
    [JSON.stringify({ providerInstances: { codex: { driver: 'codex', config: { binaryPath: null } } } }), /binaryPath must be a string/],
    [JSON.stringify({ providerInstances: { codex: { driver: 'codex', config: { setupMode: 'managed' } } } }), /existing Codex CLI login/],
  ];
  for (const [contents, message] of invalid) {
    writeFileSync(input.settingsPath, contents);
    assert.throws(() => installT3(input), message);
    assert.equal(readFileSync(input.settingsPath, 'utf8'), contents);
    assert.deepEqual(readdirSync(input.directory).sort(), ['settings.json', 'wrapper']);
  }
});

test('requires an absolute executable file before touching settings', (t) => {
  const input = fixture(t);
  assert.throws(() => installT3({ ...input, binaryPath: 'wrapper' }), /absolute executable path/);
  assert.throws(() => installT3({ ...input, binaryPath: join(input.directory, 'missing') }), /Cannot execute/);
  assert.throws(() => installT3({ ...input, binaryPath: input.directory }), /Cannot execute/);
  if (process.platform !== 'win32') {
    chmodSync(input.binaryPath, 0o600);
    assert.throws(() => installT3(input), /Cannot execute/);
  }
  assert.equal(existsSync(input.settingsPath), false);
});

test('preserves a settings symlink and modifies its target atomically', { skip: process.platform === 'win32' }, (t) => {
  const input = fixture(t);
  const targetDirectory = join(input.directory, 'elsewhere');
  mkdirSync(targetDirectory);
  const targetPath = join(targetDirectory, 'real-settings.json');
  const original = '{"preserved":true}\n';
  writeFileSync(targetPath, original, { mode: 0o600 });
  symlinkSync(targetPath, input.settingsPath);
  const result = installT3(input);
  assert.equal(lstatSync(input.settingsPath).isSymbolicLink(), true);
  assert.equal(readFileSync(result.backupPath, 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(targetPath, 'utf8')).providerInstances.codex.config.binaryPath, input.binaryPath);
  assert.deepEqual(readdirSync(targetDirectory), ['real-settings.json']);
});

test('accepts the executable symlink created by npm global installation', { skip: process.platform === 'win32' }, (t) => {
  const input = fixture(t);
  const npmLink = join(input.directory, 'codex-brake');
  symlinkSync(input.binaryPath, npmLink);
  const result = installT3({ ...input, binaryPath: npmLink });
  assert.equal(result.binaryPath, npmLink);
  assert.equal(JSON.parse(readFileSync(input.settingsPath, 'utf8')).providerInstances.codex.config.binaryPath, npmLink);
});

test('refuses a dangling settings symlink without replacing it', { skip: process.platform === 'win32' }, (t) => {
  const input = fixture(t);
  symlinkSync(join(input.directory, 'missing-target'), input.settingsPath);
  assert.throws(() => installT3(input), /Cannot read T3 settings/);
  assert.equal(lstatSync(input.settingsPath).isSymbolicLink(), true);
  assert.deepEqual(readdirSync(input.directory).sort(), ['settings.json', 'wrapper']);
});

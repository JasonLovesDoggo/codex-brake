import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeExclusive(path, contents, mode) {
  const descriptor = openSync(path, 'wx', mode);
  let completed = false;
  try {
    // Preserve the requested permissions even when the caller has a stricter umask.
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    completed = true;
  } finally {
    closeSync(descriptor);
    if (!completed) unlinkSync(path);
  }
}

/** Configure the existing Codex CLI provider; never overwrite managed-account setup. */
export function installT3({
  settingsPath = join(homedir(), '.t3', 'userdata', 'settings.json'),
  binaryPath,
} = {}) {
  if (typeof binaryPath !== 'string' || !isAbsolute(binaryPath)) {
    throw new TypeError('The wrapper binaryPath must be an absolute executable path');
  }
  try {
    if (!statSync(binaryPath).isFile()) throw new Error('not a file');
    accessSync(binaryPath, constants.X_OK);
  } catch (cause) {
    throw new Error(`Cannot execute the wrapper at ${binaryPath}: ${cause.message}`, { cause });
  }
  if (typeof settingsPath !== 'string' || !settingsPath.trim()) {
    throw new TypeError('settingsPath must be a nonempty path');
  }
  settingsPath = resolve(settingsPath);
  binaryPath = resolve(binaryPath);

  let original = null;
  let writePath = settingsPath;
  let mode = 0o600;
  let link = false;
  try {
    const entry = lstatSync(settingsPath);
    link = entry.isSymbolicLink();
    if (link) writePath = realpathSync(settingsPath);
    const info = statSync(writePath);
    if (!info.isFile()) throw new Error('Settings path must refer to a regular file');
    mode = info.mode & 0o777;
    original = readFileSync(writePath);
  } catch (cause) {
    if (cause.code !== 'ENOENT' || link) {
      throw new Error(`Cannot read T3 settings at ${settingsPath}: ${cause.message}`, { cause });
    }
  }

  let settings;
  try {
    settings = original === null ? {} : JSON.parse(original.toString('utf8'));
  } catch (cause) {
    throw new Error(`Invalid JSON in T3 settings at ${settingsPath}; no changes made`, { cause });
  }
  if (!isRecord(settings)) throw new Error('T3 settings must be a JSON object; no changes made');
  const instances = settings.providerInstances === undefined ? {} : settings.providerInstances;
  if (!isRecord(instances) || !Object.values(instances).every(isRecord)) {
    throw new Error('T3 providerInstances must be an object of provider records; no changes made');
  }
  const existing = Object.hasOwn(instances, 'codex') ? instances.codex : { driver: 'codex' };
  if (existing.driver !== 'codex') {
    throw new Error('T3 provider instance "codex" uses another driver; no changes made');
  }
  const config = existing.config === undefined ? {} : existing.config;
  if (!isRecord(config)) throw new Error('T3 Codex config must be an object; no changes made');
  if (config.setupMode === 'managed') {
    throw new Error('T3 manages this Codex executable. Select an existing Codex CLI login in Settings → Providers before installing reset protection; no changes made');
  }
  const previousBinaryPath = config.binaryPath === undefined ? 'codex' : config.binaryPath;
  if (typeof previousBinaryPath !== 'string') {
    throw new Error('T3 Codex binaryPath must be a string; no changes made');
  }
  if (previousBinaryPath === binaryPath) {
    return { settingsPath, backupPath: null, binaryPath, previousBinaryPath, alreadyInstalled: true };
  }
  const updated = {
    ...settings,
    providerInstances: {
      ...instances,
      codex: { ...existing, config: { ...config, binaryPath } },
    },
  };
  const contents = `${JSON.stringify(updated, null, 2)}\n`;
  mkdirSync(dirname(writePath), { recursive: true, mode: 0o700 });
  const suffix = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const temporary = join(dirname(writePath), `.resetstop-settings-${suffix}.tmp`);
  const backupPath = original === null ? null : `${settingsPath}.resetstop-backup-${suffix}`;
  let temporaryCreated = false;
  try {
    if (backupPath !== null) writeExclusive(backupPath, original, 0o600);
    writeExclusive(temporary, contents, mode);
    temporaryCreated = true;

    // A live T3 process may also save settings. Refuse a detected concurrent change.
    if (link && realpathSync(settingsPath) !== writePath) {
      throw new Error('T3 settings symlink changed during installation; retry the command');
    }
    if (original === null) {
      try {
        lstatSync(settingsPath);
        throw new Error('T3 settings were created during installation; retry the command');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    } else if (!readFileSync(settingsPath).equals(original)) {
      throw new Error('T3 settings changed during installation; retry the command');
    }
    renameSync(temporary, writePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { settingsPath, backupPath, binaryPath, previousBinaryPath, alreadyInstalled: false };
}

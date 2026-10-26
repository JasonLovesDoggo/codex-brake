import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MODES = new Set(['armed', 'paused', 'off']);
const WINDOWS = new Set(['weekly', 'five-hour', 'either']);
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 1_000;

export function getStateDirectory(env = process.env) {
  if (env.CODEX_BRAKE_STATE_DIR) return resolve(env.CODEX_BRAKE_STATE_DIR);
  if (env.RESETSTOP_STATE_DIR) return resolve(env.RESETSTOP_STATE_DIR);
  // Retain the original directory so upgrades share pauses with running wrappers.
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'codex-resetstop');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateState(state) {
  if (!isObject(state)
    || state.version !== 1
    || !MODES.has(state.mode)
    || !WINDOWS.has(state.window)
    || typeof state.generation !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.generation)
    || typeof state.changedAt !== 'string'
    || !Number.isFinite(Date.parse(state.changedAt))
    || !(state.reason === null || isObject(state.reason))
    || !isObject(state.baselines)
    || !Object.values(state.baselines).every(isObject)) {
    throw new Error('Unsupported or invalid guard state');
  }
  return state;
}

function defaultState() {
  return {
    version: 1,
    mode: 'armed',
    generation: randomUUID(),
    window: 'weekly',
    changedAt: new Date().toISOString(),
    reason: null,
    baselines: {},
  };
}

function processIsDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error.code === 'ESRCH';
  }
}

/** A process-shared guard latch. All changes re-read state under an exclusive lock. */
export class StateStore {
  constructor(directory = getStateDirectory()) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'state.json');
    this.lockPath = join(this.directory, '.state.lock');
  }

  read() {
    const state = this.#readExisting();
    return state ?? this.#transaction((current) => current);
  }

  /** Explicit user controls invalidate every in-flight poll from the prior generation. */
  control(mode, { window, reason = null } = {}) {
    if (!MODES.has(mode)) throw new TypeError(`Invalid guard mode: ${mode}`);
    if (window !== undefined && !WINDOWS.has(window)) throw new TypeError(`Invalid usage window: ${window}`);
    if (reason !== null && !isObject(reason)) throw new TypeError('Guard reason must be an object or null');
    return this.#transaction((state) => ({
      ...state,
      mode,
      window: window ?? state.window,
      generation: randomUUID(),
      changedAt: new Date().toISOString(),
      reason,
      baselines: mode === 'paused' ? state.baselines : {},
    }));
  }

  /** A reset can pause only the armed generation that observed it. */
  pause(reason, expectedGeneration) {
    if (!isObject(reason)) throw new TypeError('Pause reason must be an object');
    return this.#transaction((state) => {
      if (state.mode !== 'armed' || state.generation !== expectedGeneration) return state;
      return { ...state, mode: 'paused', changedAt: new Date().toISOString(), reason };
    });
  }

  saveBaseline(scope, baseline, expectedGeneration) {
    if (typeof scope !== 'string' || scope.length === 0) throw new TypeError('Baseline scope must be a nonempty string');
    if (!isObject(baseline)) throw new TypeError('Baseline must be an object');
    return this.#transaction((state) => {
      if (state.mode !== 'armed' || state.generation !== expectedGeneration) return state;
      return { ...state, baselines: { ...state.baselines, [scope]: baseline } };
    });
  }

  #readExisting() {
    let data;
    try {
      data = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return validateState(JSON.parse(data));
    } catch (cause) {
      // Never repair or overwrite malformed state: losing a pause is unsafe.
      throw new Error(`Cannot read guard state at ${this.path}: ${cause.message}`, { cause });
    }
  }

  #transaction(update) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const release = this.#acquireLock();
    try {
      const existing = this.#readExisting();
      const state = existing ?? defaultState();
      const next = update(state);
      if (!existing || next !== state) this.#write(next);
      return next;
    } finally {
      release();
    }
  }

  #write(state) {
    // Validate the serialized representation, too: undefined values must not erase fields.
    const data = `${JSON.stringify(state, null, 2)}\n`;
    validateState(JSON.parse(data));
    const temporary = join(this.directory, `.state-${process.pid}-${randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, data, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  #acquireLock() {
    const token = randomUUID();
    const ownerName = `owner-${process.pid}-${token}.json`;
    const candidate = join(this.directory, `.state-lock-${process.pid}-${token}`);
    mkdirSync(candidate, { mode: 0o700 });
    try {
      writeFileSync(join(candidate, ownerName), JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      try { rmdirSync(candidate); } catch { /* Preserve the original error. */ }
      throw error;
    }

    const deadline = performance.now() + LOCK_TIMEOUT_MS;
    let acquired = false;
    try {
      while (true) {
        try {
          // A populated directory is published atomically. rename cannot replace an
          // occupied lock; it can replace an empty directory left during release.
          renameSync(candidate, this.lockPath);
          acquired = true;
          return () => this.#releaseOwner(this.lockPath, ownerName);
        } catch (error) {
          const collision = ['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(error.code);
          // The owner can release between rename's failure and this catch; do
          // not require the lock path to still exist before retrying.
          if (!collision) throw error;
        }
        this.#reclaimDeadOwner();
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for guard state lock at ${this.lockPath}`);
        Atomics.wait(WAIT, 0, 0, 10);
      }
    } finally {
      if (!acquired) this.#releaseOwner(candidate, ownerName);
    }
  }

  #releaseOwner(directory, ownerName) {
    try {
      unlinkSync(join(directory, ownerName));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    try {
      rmdirSync(directory);
    } catch (error) {
      // Another process may already have atomically acquired this now-empty path.
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }

  #reclaimDeadOwner() {
    let entries;
    try {
      entries = readdirSync(this.lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (entries.length === 0) {
      // This can remain if a process dies halfway through release. Every new
      // owner is published with its file already present, so rmdir is safe.
      try { rmdirSync(this.lockPath); } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
      return;
    }
    if (entries.length !== 1) return;
    const match = /^owner-([1-9]\d*)-([0-9a-f-]{36})\.json$/.exec(entries[0]);
    if (!match || !processIsDead(Number(match[1]))) return;
    // Unlink only the observed owner's unique file. Concurrent recovery cannot
    // delete a new owner's directory, even if it appears at the same lock path.
    this.#releaseOwner(this.lockPath, entries[0]);
  }
}

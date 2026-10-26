const SLOTS = ['primary', 'secondary'];
const SELECTORS = new Set(['either', 'weekly', 'five-hour', 'short', ...SLOTS]);
const MAX_TIMESTAMP_MS = 8.64e15;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const percentage = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const resetTime = (value) => positive(value) && value <= MAX_TIMESTAMP_MS / 1000;
const identity = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const keyOf = (bucket, window) => JSON.stringify([bucket, window]);

/**
 * Detect quota replenishment from serialized account/rateLimits/read responses.
 * Do not feed rolling notifications here: Codex can emit cached quota snapshots.
 * A caller must latch a returned reason and require an explicit rearm.
 */
export class ResetDetector {
  constructor({ window = 'weekly', now = Date.now, baseline = null } = {}) {
    if (!SELECTORS.has(window)) throw new TypeError(`Unsupported quota window: ${window}`);
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.window = window;
    this.now = now;
    this.accountId = null;
    this.accountChanged = false;
    this.windows = new Map();
    if (baseline !== null) this.importState(baseline);
  }

  matches(window) {
    if (this.window === 'either') return true;
    if (SLOTS.includes(this.window)) return window.window === this.window;
    const weekly = this.window === 'weekly';
    return window.durationMins === null
      ? window.window === (weekly ? 'secondary' : 'primary')
      : window.durationMins === (weekly ? 10080 : 300);
  }

  get nextDeadline() {
    let earliest = null;
    for (const window of this.windows.values()) {
      if (this.matches(window) && window.deadline !== null) {
        earliest = earliest === null ? window.deadline : Math.min(earliest, window.deadline);
      }
    }
    return earliest;
  }

  check() {
    return this.checkAt(this.now());
  }

  checkAt(now) {
    let expired = null;
    for (const window of this.windows.values()) {
      if (this.matches(window) && window.deadline !== null && window.deadline <= now &&
          (expired === null || window.deadline < expired.deadline)) {
        expired = window;
      }
    }
    return expired === null ? null : {
      kind: 'scheduled-reset',
      message: `The ${expired.bucket} ${expired.window} quota reset deadline was reached.`,
      bucket: expired.bucket,
      window: expired.window,
      detectedAt: now,
    };
  }

  observe(result) {
    this.accountChanged = false;
    const now = this.now();
    // A post-reset read must not replace an already elapsed deadline with the next one.
    const elapsed = this.checkAt(now);
    if (elapsed) return elapsed;
    if (!isObject(result)) return null;

    const accountId = identity(result.accountId);
    if (accountId !== null) {
      if (this.accountId !== null && this.accountId !== accountId) {
        this.accountChanged = true;
        this.windows.clear();
      }
      this.accountId = accountId;
    }

    const mapped = isObject(result.rateLimitsByLimitId)
      ? Object.entries(result.rateLimitsByLimitId).filter(([bucket, value]) => identity(bucket) && isObject(value))
      : [];
    const buckets = mapped.length ? mapped : isObject(result.rateLimits)
      ? [[identity(result.rateLimits.limitId) ?? 'codex', result.rateLimits]]
      : [];
    let reason = null;

    for (const [bucket, snapshot] of buckets) {
      for (const slot of SLOTS) {
        const update = snapshot[slot];
        if (!isObject(update)) continue;
        const key = keyOf(bucket, slot);
        let previous = this.windows.get(key);
        const duration = positive(update.windowDurationMins) ? update.windowDurationMins : null;
        // A different duration is a different quota window, not evidence of replenishment.
        if (previous && duration !== null && previous.durationMins !== null &&
            duration !== previous.durationMins) previous = undefined;

        const usedPercent = percentage(update.usedPercent) ? update.usedPercent : null;
        const resetsAt = resetTime(update.resetsAt) ? update.resetsAt : null;
        if (!previous && usedPercent === null && resetsAt === null) continue;

        const window = previous ? { ...previous } : {
          bucket, window: slot, durationMins: null, usedPercent: null, resetsAt: null, deadline: null,
        };
        if (duration !== null) window.durationMins = duration;
        if (usedPercent !== null) window.usedPercent = usedPercent;
        if (resetsAt !== null) {
          window.resetsAt = resetsAt;
          const deadline = resetsAt * 1000;
          if (deadline > now) {
            // A later backend estimate cannot silently extend a previously armed boundary.
            window.deadline = window.deadline === null ? deadline : Math.min(window.deadline, deadline);
          }
          // A stale timestamp on the first read does not prove a reset occurred while armed.
        }

        if (reason === null && this.matches(window) && previous?.usedPercent !== null &&
            previous?.usedPercent !== undefined && usedPercent !== null && usedPercent < previous.usedPercent) {
          reason = {
            kind: 'usage-increased',
            message: `Remaining ${bucket} ${slot} quota increased (used ${previous.usedPercent}% → ${usedPercent}%).`,
            bucket,
            window: slot,
            detectedAt: now,
          };
        }
        this.windows.set(key, window);
      }
    }
    return reason;
  }

  get snapshot() {
    return this.exportState();
  }

  exportState() {
    return {
      version: 1,
      accountId: this.accountId,
      windows: [...this.windows.values()].map((window) => ({ ...window })),
    };
  }

  importState(snapshot) {
    if (!isObject(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.windows) ||
        !(snapshot.accountId === null || identity(snapshot.accountId) !== null)) {
      throw new TypeError('Invalid reset detector snapshot');
    }
    const windows = new Map();
    for (const window of snapshot.windows) {
      if (!isObject(window) || identity(window.bucket) === null || !SLOTS.includes(window.window) ||
          !(window.durationMins === null || positive(window.durationMins)) ||
          !(window.usedPercent === null || percentage(window.usedPercent)) ||
          !(window.resetsAt === null || resetTime(window.resetsAt)) ||
          !(window.deadline === null || (positive(window.deadline) && window.deadline <= MAX_TIMESTAMP_MS))) {
        throw new TypeError('Invalid quota window in reset detector snapshot');
      }
      const key = keyOf(window.bucket, window.window);
      if (windows.has(key)) throw new TypeError('Duplicate quota window in reset detector snapshot');
      windows.set(key, {
        bucket: window.bucket,
        window: window.window,
        durationMins: window.durationMins,
        usedPercent: window.usedPercent,
        resetsAt: window.resetsAt,
        deadline: window.deadline,
      });
    }
    // Commit only after validation, so a corrupt snapshot cannot erase an armed deadline.
    this.accountId = snapshot.accountId;
    this.windows = windows;
    this.accountChanged = false;
    return this;
  }
}

export const createDetector = (options) => new ResetDetector(options);

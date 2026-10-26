import assert from 'node:assert/strict';
import test from 'node:test';
import { ResetDetector, createDetector } from '../src/detector.js';

const START = 1_800_000_000_000;
const RESET = START / 1000 + 60;
const window = (usedPercent = 80, resetsAt = RESET, windowDurationMins = 300) =>
  ({ usedPercent, resetsAt, windowDurationMins });
const read = (primary = window(), secondary = null, extra = {}) =>
  ({ rateLimits: { primary, secondary }, ...extra });
function clock(options = {}) {
  let time = START;
  return {
    detector: createDetector({ window: 'either', ...options, now: () => time }),
    set(value) { time = value; },
  };
}

test('first observation and increasing consumed usage do not trigger; replenishment does', () => {
  const { detector } = clock();
  assert.equal(detector.observe(read()), null);
  assert.equal(detector.observe(read(window(99))), null);
  assert.deepEqual(detector.observe(read(window(0))), {
    kind: 'usage-increased',
    message: 'Remaining codex primary quota increased (used 99% → 0%).',
    bucket: 'codex', window: 'primary', detectedAt: START,
  });
});

test('announced reset stops at the deadline without another usage observation', () => {
  const { detector, set } = clock();
  detector.observe(read());
  assert.equal(detector.nextDeadline, RESET * 1000);
  set(RESET * 1000 - 1);
  assert.equal(detector.check(), null);
  set(RESET * 1000);
  assert.equal(detector.check().kind, 'scheduled-reset');
});

test('an already stale first timestamp is ignored until a future deadline is observed', () => {
  const { detector, set } = clock();
  detector.observe(read(window(0, START / 1000 - 60)));
  assert.equal(detector.nextDeadline, null);
  set(START + 10_000);
  assert.equal(detector.check(), null);
  detector.observe(read(window(1, RESET)));
  assert.equal(detector.nextDeadline, RESET * 1000);
});

test('a persisted deadline crossed during downtime pauses immediately', () => {
  const { detector } = clock();
  detector.observe(read());
  const resumed = new ResetDetector({ window: 'either', now: () => RESET * 1000 + 10, baseline: detector.snapshot });
  assert.equal(resumed.check().kind, 'scheduled-reset');
});

test('a new post-reset observation cannot overwrite an elapsed deadline', () => {
  const { detector, set } = clock();
  detector.observe(read());
  set(RESET * 1000 + 5_000);
  assert.equal(detector.observe(read(window(0, RESET + 18_000))).kind, 'scheduled-reset');
  assert.equal(detector.nextDeadline, RESET * 1000);
});

test('a future timestamp advancing is not a reset and does not silently extend protection', () => {
  const { detector, set } = clock();
  detector.observe(read());
  assert.equal(detector.observe(read(window(81, RESET + 18_000))), null);
  assert.equal(detector.nextDeadline, RESET * 1000);
  set(RESET * 1000);
  assert.equal(detector.check().kind, 'scheduled-reset');
});

test('missing and null fields preserve both deadline and comparison baseline', () => {
  const { detector } = clock();
  detector.observe(read());
  for (const result of [null, {}, read(null), read({}), read({ usedPercent: null, resetsAt: null })]) {
    assert.equal(detector.observe(result), null);
    assert.equal(detector.nextDeadline, RESET * 1000);
  }
  assert.equal(detector.observe(read({ usedPercent: 20 })).kind, 'usage-increased');
});

test('remaining usage fallback works without any reset timestamp', () => {
  const { detector } = clock();
  detector.observe(read(window(80, null)));
  assert.equal(detector.nextDeadline, null);
  assert.equal(detector.observe(read(window(79, null))).kind, 'usage-increased');
});

test('map buckets are independent and take precedence over the legacy mirror', () => {
  const { detector } = clock();
  detector.observe(read(window(99), null, { rateLimitsByLimitId: {
    codex: { primary: window(80) }, fast: { primary: window(20) },
  } }));
  assert.equal(detector.observe({ rateLimitsByLimitId: { fast: { primary: window(21) } } }), null);
  const reason = detector.observe({ rateLimitsByLimitId: { codex: { primary: window(79) } } });
  assert.equal(reason.kind, 'usage-increased');
  assert.equal(reason.bucket, 'codex');
});

test('legacy snapshots use limitId, and empty maps fall back to legacy', () => {
  const { detector } = clock();
  detector.observe({ rateLimitsByLimitId: {}, rateLimits: { limitId: 'other', primary: window(99) } });
  assert.equal(detector.snapshot.windows[0].bucket, 'other');
  assert.equal(detector.observe({ rateLimits: { limitId: 'other', primary: window(1) } }).bucket, 'other');
});

test('weekly and five-hour selectors follow known durations even if slots are swapped', () => {
  const weekly = clock({ window: 'weekly' }).detector;
  const fiveHour = clock({ window: 'five-hour' }).detector;
  const initial = read(window(80, RESET + 100, 10080), window(80, RESET, 300));
  weekly.observe(initial);
  fiveHour.observe(initial);
  assert.equal(weekly.nextDeadline, (RESET + 100) * 1000);
  assert.equal(fiveHour.nextDeadline, RESET * 1000);
  const shortDrop = read(window(80, RESET + 100, 10080), window(0, RESET, 300));
  assert.equal(weekly.observe(shortDrop), null);
  assert.equal(fiveHour.observe(shortDrop).window, 'secondary');
  assert.equal(weekly.observe(read(window(0, RESET + 100, 10080))).window, 'primary');
});

test('the default monitors weekly resets only', () => {
  const detector = new ResetDetector({ now: () => START });
  detector.observe(read(window(80, RESET, 300), window(80, RESET + 100, 10080)));
  assert.equal(detector.nextDeadline, (RESET + 100) * 1000);
  assert.equal(detector.observe(read(window(0, RESET, 300))), null);
  assert.equal(detector.observe(read(null, window(0, RESET + 100, 10080))).kind, 'usage-increased');
});

test('selectors use slot fallback only while duration is unknown', () => {
  const weekly = clock({ window: 'weekly' }).detector;
  weekly.observe(read(window(90, RESET, null), window(80, RESET + 100, null)));
  assert.equal(weekly.nextDeadline, (RESET + 100) * 1000);
  assert.equal(weekly.observe(read(window(0, RESET, null))), null);
  assert.equal(weekly.observe(read(null, window(0, RESET + 100, null))).kind, 'usage-increased');
  const otherDuration = clock({ window: 'five-hour' }).detector;
  otherDuration.observe(read(window(90, RESET, 1440)));
  assert.equal(otherDuration.nextDeadline, null);
  assert.equal(otherDuration.observe(read(window(0, RESET, 1440))), null);
});

test('a known duration change starts a new baseline; missing duration preserves it', () => {
  const { detector } = clock();
  detector.observe(read());
  assert.equal(detector.observe(read(window(1, RESET + 100, 1440))), null);
  assert.equal(detector.nextDeadline, (RESET + 100) * 1000);
  assert.equal(detector.observe(read(window(0, null, null))).kind, 'usage-increased');
  assert.equal(detector.snapshot.windows[0].durationMins, 1440);
});

test('an account switch clears comparisons and timers, and reports accountChanged once', () => {
  const { detector } = clock();
  detector.observe(read(window(99), null, { accountId: 'a' }));
  assert.equal(detector.observe(read(window(1, RESET + 100), null, { accountId: 'b' })), null);
  assert.equal(detector.accountChanged, true);
  assert.equal(detector.nextDeadline, (RESET + 100) * 1000);
  detector.observe(read(window(2, RESET + 100), null, { accountId: null }));
  assert.equal(detector.accountChanged, false);
  assert.equal(detector.snapshot.accountId, 'b');
  assert.equal(detector.observe(read(window(1, RESET + 100))).kind, 'usage-increased');
});

test('elapsed deadlines win even if the response reports a different account', () => {
  const { detector, set } = clock();
  detector.observe(read(window(80), null, { accountId: 'a' }));
  set(RESET * 1000);
  assert.equal(detector.observe(read(window(0), null, { accountId: 'b' })).kind, 'scheduled-reset');
});

test('invalid percentages and reset timestamps never masquerade as zero or remove protection', () => {
  const { detector } = clock();
  detector.observe(read());
  for (const value of [undefined, null, NaN, Infinity, -1, '0']) {
    assert.equal(detector.observe(read({ usedPercent: value, resetsAt: value })), null);
  }
  assert.equal(detector.nextDeadline, RESET * 1000);
  assert.equal(detector.snapshot.windows[0].usedPercent, 80);
});

test('snapshot import/export is independent of mutable caller objects', () => {
  const { detector } = clock();
  detector.observe(read());
  const snapshot = detector.snapshot;
  const imported = clock({ baseline: snapshot }).detector;
  snapshot.windows[0].deadline = null;
  assert.equal(detector.nextDeadline, RESET * 1000);
  assert.equal(imported.nextDeadline, RESET * 1000);
  assert.deepEqual(imported.exportState(), detector.exportState());
});

test('invalid persisted state is rejected without changing an existing baseline', () => {
  const { detector } = clock();
  detector.observe(read());
  const before = detector.snapshot;
  assert.throws(() => detector.importState({ version: 99, windows: [] }), /Invalid/);
  const broken = detector.snapshot;
  broken.windows[0].deadline = 'tomorrow';
  assert.throws(() => detector.importState(broken), /Invalid/);
  const duplicate = detector.snapshot;
  duplicate.windows.push({ ...duplicate.windows[0] });
  assert.throws(() => detector.importState(duplicate), /Duplicate/);
  assert.deepEqual(detector.snapshot, before);
});

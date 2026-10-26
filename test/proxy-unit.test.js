import assert from 'node:assert/strict';
import test from 'node:test';
import { positiveInteger, startsWork } from '../src/proxy.js';

test('the work gate covers direct inference and entry points that restore autonomous work', () => {
  for (const method of [
    'turn/start', 'turn/steer', 'review/start', 'thread/compact/start',
    'thread/resume', 'thread/fork', 'thread/start', 'thread/sample',
    'thread/queue/start', 'thread/prediction/request',
    'thread/realtime/start', 'thread/realtime/appendText',
    'thread/realtime/appendAudio', 'thread/realtime/appendSpeech',
    'sendUserMessage', 'sendUserTurn', 'addConversationListener',
  ]) {
    assert.equal(startsWork({ method, params: {} }), true, `${method} must not bypass a pause`);
  }
});

test('creating or editing a goal is gated while explicit goal stops remain available', () => {
  for (const params of [undefined, {}, { objective: 'Keep working' }, { status: 'active' }, { tokenBudget: 1000 }]) {
    assert.equal(startsWork({ method: 'thread/goal/set', params }), true);
  }
  for (const status of ['paused', 'complete']) {
    assert.equal(startsWork({ method: 'thread/goal/set', params: { status } }), false);
  }
});

test('inspection, cancellation, login, and server-request replies can pass the work gate', () => {
  for (const method of [
    'initialize', 'initialized', 'account/read', 'account/rateLimits/read',
    'account/login/start', 'account/logout', 'thread/read', 'thread/list',
    'turn/interrupt', 'thread/goal/get', 'thread/goal/clear',
    'thread/sample/cancel', 'userVerification/cancel', 'thread/realtime/stop',
    'thread/queue/add', 'thread/queue/delete',
  ]) {
    assert.equal(startsWork({ method }), false, `${method} should remain available while paused`);
  }
  assert.equal(startsWork({ id: 17, result: { decision: 'decline' } }), false);
});

test('timing configuration accepts bounded whole milliseconds and uses the supplied default', () => {
  assert.equal(positiveInteger(undefined, 15_000, 'POLL'), 15_000);
  assert.equal(positiveInteger('250', 15_000, 'POLL', 250), 250);
  assert.equal(positiveInteger('2147483647', 15_000, 'POLL'), 2_147_483_647);
  for (const value of ['', 'no', '0', '-1', '0.5', 'Infinity', 'NaN', '2147483648']) {
    assert.throws(() => positiveInteger(value, 15_000, 'POLL'), /POLL must be an integer/);
  }
  assert.throws(() => positiveInteger('249', 15_000, 'POLL', 250), /between 250 and/);
});

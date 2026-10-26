#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-resetstop-test\n');
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('The fake Codex executable only implements app-server.\n');
  process.exit(2);
}
if (process.env.RESETSTOP_TEST_PID_FILE) writeFileSync(process.env.RESETSTOP_TEST_PID_FILE, String(process.pid));

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (request, result) => emit({ id: request.id, result });
const active = new Map();
const samples = new Map();
const heldQuota = [];
let sequence = 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (process.env.RESETSTOP_TEST_LOG) appendFileSync(process.env.RESETSTOP_TEST_LOG, `${JSON.stringify(message)}\n`);
  if (!message.method) return;
  switch (message.method) {
    case 'initialize':
      reply(message, { userAgent: 'fake-codex/1.0', platformFamily: 'unix', platformOs: 'linux' });
      break;
    case 'initialized':
      break;
    case 'account/rateLimits/read': {
      // Capture the server's snapshot now, so a delayed response can represent
      // an account that changed while this request was in flight.
      const snapshot = JSON.parse(readFileSync(process.env.RESETSTOP_TEST_USAGE, 'utf8'));
      const respond = () => {
        if (process.env.RESETSTOP_TEST_USAGE_ERROR) {
          emit({ id: message.id, error: { code: -32000, message: process.env.RESETSTOP_TEST_USAGE_ERROR } });
        } else {
          reply(message, snapshot);
        }
      };
      const delay = Number(process.env.RESETSTOP_TEST_USAGE_DELAY_MS || 0);
      if (process.env.RESETSTOP_TEST_HOLD_QUOTA === '1') heldQuota.push(respond);
      else if (delay > 0) setTimeout(respond, delay);
      else respond();
      break;
    }
    case 'thread/start':
      reply(message, { thread: { id: `thread-${++sequence}`, turns: [] } });
      break;
    case 'turn/start': {
      const threadId = message.params.threadId;
      const turn = { id: `turn-${++sequence}`, status: 'inProgress', items: [], error: null };
      active.set(threadId, turn);
      reply(message, { turn });
      emit({ method: 'turn/started', params: { threadId, turn } });
      break;
    }
    case 'turn/interrupt': {
      if (process.env.RESETSTOP_TEST_IGNORE_INTERRUPT === '1') break;
      const { threadId, turnId } = message.params;
      reply(message, {});
      const turn = active.get(threadId);
      if (turn?.id === turnId) {
        active.delete(threadId);
        emit({ method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'interrupted' } } });
      }
      break;
    }
    case 'thread/goal/set':
      reply(message, { goal: { ...message.params } });
      break;
    case 'thread/sample':
      samples.set(message.id, message);
      break;
    case 'thread/sample/cancel': {
      const request = samples.get(message.params.requestId);
      if (!request) {
        emit({ id: message.id, error: { code: -32602, message: 'No sample exists for that request ID' } });
        break;
      }
      samples.delete(request.id);
      reply(message, { cancelled: true });
      emit({ id: request.id, error: { code: -32800, message: 'Sampling cancelled' } });
      break;
    }
    case 'test/releaseQuota':
      reply(message, {});
      for (let count = 0; count < (message.params.count ?? 1); count++) heldQuota.shift()?.();
      break;
    case 'test/delay':
      setTimeout(() => reply(message, {}), message.params.ms);
      break;
    case 'test/serverRequest':
      reply(message, {});
      emit(message.params.message);
      break;
    case 'test/notify':
      reply(message, {});
      emit({ method: message.params.method, params: message.params.params });
      break;
    default:
      if (message.id !== undefined) reply(message, { echo: message.params ?? null });
  }
});

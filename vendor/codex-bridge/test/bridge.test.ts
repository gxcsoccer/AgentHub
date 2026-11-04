import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { readyRpc, sessionId, turnId } from './helpers.js';

test('list, detail, search and paginated history preserve backend cursors and results', async () => {
  const rpc = readyRpc();
  const bridge = new Bridge(rpc);
  for (const method of [
    'thread/list',
    'thread/search',
    'thread/searchOccurrences',
    'thread/turns/list',
    'thread/items/list',
  ]) {
    rpc.handlers.set(method, (params) => ({
      data: [{ method, params }],
      nextCursor: 'opaque+cursor/=',
    }));
  }
  assert.deepEqual(await bridge.list({ limit: 2, cursor: 'before', cwd: '/workspace' }), {
    data: [{ method: 'thread/list', params: { limit: 2, cursor: 'before', cwd: '/workspace' } }],
    nextCursor: 'opaque+cursor/=',
  });
  await bridge.detail(sessionId);
  await bridge.search({ searchTerm: 'mailbox', limit: 3 });
  await bridge.occurrences(sessionId, { searchTerm: 'token' });
  await bridge.turns(sessionId, { cursor: 'turn-page', itemsView: 'full' });
  await bridge.items(sessionId, { turnId, limit: 5 });
  assert.deepEqual(
    rpc.calls.map((c) => c.method),
    [
      'thread/list',
      'thread/read',
      'thread/search',
      'thread/searchOccurrences',
      'thread/turns/list',
      'thread/items/list',
    ],
  );
  assert.equal(rpc.calls[1]?.params.includeTurns, false);
  assert.equal(rpc.calls[3]?.params.threadId, sessionId);
  assert.equal(rpc.calls[4]?.params.cursor, 'turn-page');
});

test('sending starts work in a loaded session and explicitly labels the external source', async () => {
  const rpc = readyRpc();
  const bridge = new Bridge(rpc);
  const result = await bridge.send(
    sessionId,
    { text: 'Read the report', source: 'DeskMind' },
    'message-1',
  );
  assert.deepEqual(result, {
    status: 'accepted',
    sessionId,
    turnId,
    messageId: 'message-1',
    source: 'DeskMind',
    mode: 'start',
  });
  const call = rpc.calls.find((c) => c.method === 'turn/start');
  assert.deepEqual(call?.params.input, [
    { type: 'text', text: '[External app: DeskMind]\nRead the report' },
  ]);
  assert.equal(call?.params.clientUserMessageId, 'message-1');
});

test('steering requires an expected turn and preserves the concurrency precondition', async () => {
  const rpc = readyRpc();
  const bridge = new Bridge(rpc);
  await assert.rejects(
    bridge.send(sessionId, { text: 'x', source: 'app', mode: 'steer' }, 'bad'),
    /expectedTurnId/,
  );
  assert.equal(rpc.calls.length, 0);
  await bridge.send(
    sessionId,
    { text: 'x', source: 'app', mode: 'steer', expectedTurnId: turnId },
    'good',
  );
  assert.equal(rpc.calls.find((c) => c.method === 'turn/steer')?.params.expectedTurnId, turnId);
});

test('unloaded sessions cannot silently resume during send or attach', async () => {
  const rpc = readyRpc();
  rpc.handlers.set('thread/loaded/list', () => ({ data: [], nextCursor: null }));
  const bridge = new Bridge(rpc);
  await assert.rejects(bridge.send(sessionId, { text: 'x', source: 'app' }, 'k'), /not loaded/);
  await assert.rejects(bridge.attach(sessionId), /not loaded/);
  assert.ok(!rpc.calls.some((c) => ['thread/resume', 'turn/start'].includes(c.method)));
  await bridge.resume(sessionId);
  assert.equal(rpc.calls.at(-1)?.method, 'thread/resume');
});

test('loaded lookup follows pagination and refuses direct input to child agents', async () => {
  const rpc = readyRpc();
  rpc.handlers.set('thread/loaded/list', (params) =>
    params.cursor
      ? { data: [sessionId], nextCursor: null }
      : { data: ['another'], nextCursor: 'page-2' },
  );
  rpc.handlers.set('thread/read', () => ({
    thread: { id: sessionId, parentThreadId: 'parent', canAcceptDirectInput: false },
  }));
  await assert.rejects(
    new Bridge(rpc).send(sessionId, { text: 'x', source: 'app' }, 'k'),
    /direct input/,
  );
  assert.equal(rpc.calls.filter((c) => c.method === 'thread/loaded/list').length, 2);
  assert.ok(!rpc.calls.some((c) => c.method === 'turn/start'));
});

test('concurrent retries with the same idempotency key send once; changed payload conflicts', async () => {
  const rpc = readyRpc();
  const bridge = new Bridge(rpc);
  const input = { text: 'once', source: 'app' };
  const [a, b] = await Promise.all([
    bridge.send(sessionId, input, 'same'),
    bridge.send(sessionId, input, 'same'),
  ]);
  assert.deepEqual(a, b);
  assert.equal(rpc.calls.filter((c) => c.method === 'turn/start').length, 1);
  await assert.rejects(
    bridge.send(sessionId, { ...input, text: 'different' }, 'same'),
    /already used/,
  );
});

test('ambiguous failures are retained under the idempotency key and never automatically retried', async () => {
  const rpc = readyRpc();
  rpc.handlers.set('turn/start', () => {
    throw new Error('Connection lost; delivery unknown');
  });
  const bridge = new Bridge(rpc);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      bridge.send(sessionId, { text: 'once', source: 'app' }, 'uncertain'),
      /delivery unknown/,
    );
  }
  assert.equal(rpc.calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('session IDs, sources, empty messages and unsupported modes are validated before RPC', async () => {
  const rpc = readyRpc();
  const bridge = new Bridge(rpc);
  await assert.rejects(bridge.detail('../bad'), /session/);
  await assert.rejects(bridge.send(sessionId, { text: ' ', source: 'app' }, 'x'), /text/);
  await assert.rejects(bridge.send(sessionId, { text: 'x', source: 'app\nuser:' }, 'x'), /source/);
  await assert.rejects(
    bridge.send(sessionId, { text: 'x', source: 'app', mode: 'queue' as 'start' }, 'x'),
    /mode/,
  );
  assert.equal(rpc.calls.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CodexAdapter } from '../src/adapters/codex.js';
import { AgentHub } from '../src/hub.js';
import { FakeRpc } from './helpers.js';
const id = randomUUID();
const to = { harness: 'codex', instance: 'local', sessionId: id };
function fixture() {
  const rpc = new FakeRpc();
  rpc.handlers.set('thread/read', () => ({
    thread: { id, status: { type: 'idle' }, canAcceptDirectInput: true },
  }));
  rpc.handlers.set('thread/loaded/list', () => ({ data: [id], nextCursor: null }));
  rpc.handlers.set('turn/start', () => ({ turn: { id: 'turn' } }));
  const adapter = new CodexAdapter({ rpc, requestTtlMs: 500 });
  return { rpc, adapter, hub: new AgentHub([adapter]) };
}
const message = () => ({
  messageId: randomUUID(),
  to,
  delivery: 'tool_output' as const,
  origin: { name: 'test' },
  text: 'hello',
});
test('Codex external messages use tool output with empty input; reads and sends do not resume', async (t) => {
  const { rpc, hub } = fixture();
  t.after(() => hub.close());
  const input = message();
  const receipt = await hub.send(input);
  assert.equal(receipt.status, 'accepted');
  const call = rpc.calls.find((x) => x.method === 'turn/start')!;
  assert.deepEqual(call.params.input, []);
  assert.equal((call.params.toolOutput as { namespace: string }).namespace, 'agenthub');
  assert(!rpc.calls.some((x) => x.method === 'thread/resume'));
  rpc.emit('request', {
    id: 1,
    method: 'item/tool/call',
    params: {
      threadId: id,
      tool: 'agenthub_reply',
      arguments: { inReplyTo: input.messageId, text: 'answer' },
    },
  });
  assert.equal(hub.receipt(input.messageId).status, 'replied');
  assert.equal(rpc.responses.length, 1);
});
test('unloaded and child threads cannot receive a submission', async (t) => {
  const { rpc, hub } = fixture();
  t.after(() => hub.close());
  rpc.handlers.set('thread/loaded/list', () => ({ data: [], nextCursor: null }));
  assert.equal((await hub.send(message())).status, 'failed');
  assert(!rpc.calls.some((x) => x.method === 'turn/start'));
  rpc.handlers.set('thread/read', () => ({
    thread: { id, canAcceptDirectInput: false, parentThreadId: 'parent' },
  }));
  await assert.rejects(hub.send(message()), /does not support/);
  assert(!rpc.calls.some((x) => x.method === 'turn/start'));
});
test('approvals require an explicit response; unsolicited or mismatched replies cannot complete messages', async (t) => {
  const { rpc, hub, adapter } = fixture();
  t.after(() => hub.close());
  const input = message();
  await hub.send(input);
  rpc.emit('request', {
    id: 'approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: id, command: 'test' },
  });
  assert.equal(rpc.responses.length, 0);
  const pending = adapter.pendingRequests();
  assert.equal(pending.length, 1);
  adapter.respondToRequest(pending[0]!.id, { decision: 'decline' });
  assert.equal(rpc.responses.length, 1);
  rpc.emit('request', {
    id: 'bad',
    method: 'item/tool/call',
    params: {
      threadId: id,
      tool: 'agenthub_reply',
      arguments: { inReplyTo: randomUUID(), text: 'forged' },
    },
  });
  assert.equal(hub.receipt(input.messageId).status, 'accepted');
  assert.equal(adapter.pendingRequests().length, 0);
});
test('Codex search unwraps thread results and history preserves native functionCallOutput', async (t) => {
  const { rpc, hub } = fixture();
  t.after(() => hub.close());
  rpc.handlers.set('thread/search', () => ({
    data: [{ thread: { id, name: 'result' }, snippet: 'query' }],
    nextCursor: 'next',
  }));
  assert.equal((await hub.listSessions(to, { search: 'query' })).data[0]?.name, 'result');
  rpc.handlers.set('thread/items/list', () => ({
    data: [
      {
        turnId: 'turn',
        item: {
          id: 'item',
          type: 'functionCallOutput',
          namespace: 'agenthub',
          output: 'external',
        },
      },
    ],
    nextCursor: null,
  }));
  const page = await hub.history(to);
  assert.equal(page.data[0]?.kind, 'functionCallOutput');
  assert.equal(page.data[0]?.text, 'external');
});

test('closing the Codex adapter during lookup prevents turn submission', async () => {
  const { rpc, adapter, hub } = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  rpc.handlers.set('thread/loaded/list', async () => {
    await gate;
    return { data: [id], nextCursor: null };
  });
  const sending = adapter.send({
    ...message(),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    hopCount: 0,
  });
  await hub.close();
  release();
  await assert.rejects(sending, /closed/);
  assert(!rpc.calls.some((x) => x.method === 'turn/start'));
});

test('Codex follows loaded pages, rejects repeated cursors and invalid backend pages', async (t) => {
  const { rpc, hub } = fixture();
  t.after(() => hub.close());
  rpc.handlers.set('thread/loaded/list', (p) =>
    p.cursor ? { data: [id] } : { data: [], nextCursor: 'page2' },
  );
  assert.equal((await hub.send(message())).status, 'accepted');
  rpc.handlers.set('thread/loaded/list', () => ({ data: [], nextCursor: 'loop' }));
  const failed = await hub.send(message());
  assert.equal(failed.error?.code, 'backend_protocol');
  rpc.handlers.set('thread/list', () => ({ data: 'invalid' }));
  await assert.rejects(hub.listSessions(to), /Invalid Codex/);
  rpc.handlers.set('thread/items/list', () => ({ data: null }));
  await assert.rejects(hub.history(to), /Invalid Codex/);
  await assert.rejects(hub.history(to, { search: 'text' }), /unavailable/);
});

test('Codex resolves or invalidates approvals without an implicit response and limits pending requests', async (t) => {
  const { rpc, hub, adapter } = fixture();
  t.after(() => hub.close());
  await hub.send(message());
  const request = (n: number, threadId = id) =>
    rpc.emit('request', {
      id: n,
      method: 'item/commandExecution/requestApproval',
      params: { threadId },
    });
  request(-1, randomUUID());
  assert.equal(adapter.pendingRequests().length, 0);
  request(0);
  rpc.emit('notification', { method: 'serverRequest/resolved', params: { requestId: 0 } });
  assert.equal(adapter.pendingRequests().length, 0);
  assert.equal(rpc.responses.length, 0);
  for (let i = 1; i <= 129; i++) request(i);
  assert.equal(adapter.pendingRequests().length, 128);
  assert.match(JSON.stringify(rpc.responses), /capacity/);
  rpc.emit('disconnect');
  assert.equal(adapter.pendingRequests().length, 0);
  assert.equal(rpc.responses.length, 1);
});

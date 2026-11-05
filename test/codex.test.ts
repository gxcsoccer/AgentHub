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
test('Codex results omit reply instructions and reject forced replies before and after recovery', async (t) => {
  for (const recovered of [false, true]) {
    const { rpc, hub, adapter } = fixture();
    t.after(() => hub.close());
    const input = { ...message(), messageKind: 'result' as const, inReplyTo: randomUUID() };
    const updates: unknown[] = [];
    adapter.on('update', (u) => updates.push(u));
    if (recovered) {
      await hub.ready();
      await adapter.restore([
        { ...input, hopCount: 1, expiresAt: new Date(Date.now() + 10000).toISOString() },
      ]);
    } else {
      await hub.send(input);
      const call = rpc.calls.find((x) => x.method === 'turn/start')!;
      const payload = JSON.parse(String((call.params.toolOutput as { output: string }).output));
      assert.equal(payload.message.messageKind, 'result');
      assert.equal(payload.reply, undefined);
      assert.match(payload.guidance, /no reply/i);
    }
    rpc.emit('request', {
      id: 'result-reply',
      method: 'item/tool/call',
      params: {
        threadId: id,
        tool: 'agenthub_reply',
        arguments: { inReplyTo: input.messageId, text: 'thanks' },
      },
    });
    assert.equal(updates.length, 0);
    assert.equal((rpc.responses[0] as { error?: unknown })?.error !== undefined, true);
  }
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

const envelope = (messageId: string) => ({
  type: 'functionCallOutput',
  name: 'receive_message',
  namespace: 'agenthub',
  output: JSON.stringify({ message: { messageId, messageKind: 'request' } }),
});
const answer = (text: string, phase = 'final_answer') => ({ type: 'agentMessage', text, phase });
function fallback(t: test.TestContext, replyFallback = true) {
  const rpc = new FakeRpc();
  let turns: unknown[] = [];
  rpc.handlers.set('thread/read', () => ({
    thread: { id, status: { type: 'idle' }, canAcceptDirectInput: true, turns },
  }));
  rpc.handlers.set('thread/loaded/list', () => ({ data: [id], nextCursor: null }));
  rpc.handlers.set('turn/start', () => ({ turn: { id: 'turn' } }));
  const adapter = new CodexAdapter({ rpc, replyFallback });
  const hub = new AgentHub([adapter]);
  t.after(() => hub.close());
  const finish = async (messageId: string, items: unknown[], status = 'completed') => {
    turns = [{ id: 'turn', status, items }];
    rpc.emit('notification', { method: 'turn/completed', params: { threadId: id } });
    for (let i = 0; i < 50 && !hub.receipt(messageId).reply; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (hub.receipt(messageId).noReply) break;
    }
    return hub.receipt(messageId);
  };
  return { rpc, adapter, hub, finish };
}
const request = () => ({ ...message(), messageKind: 'request' as const });

test('reply fallback returns the answer of a turn whose sole input was the request', async (t) => {
  const { hub, finish } = fallback(t);
  const input = request();
  await hub.send(input);
  const receipt = await finish(input.messageId, [
    envelope(input.messageId),
    { type: 'reasoning', summary: [], content: [] },
    answer('working', 'commentary'),
    answer('ALONE-1'),
  ]);
  assert.equal(receipt.status, 'replied');
  assert.equal(receipt.reply?.text, 'ALONE-1');
  assert.equal(receipt.reply?.metadata?.source, 'turn_final_message');
});

test('reply fallback sends no text for merged, ambiguous, failed or interrupted turns', async (t) => {
  const user = { type: 'userMessage', content: [{ type: 'text', text: 'private work' }] };
  const failedCall = { type: 'mcpToolCall', tool: 'reply_agent', status: 'failed' };
  const other = randomUUID();
  const cases: [(id: string) => unknown[], string, string?][] = [
    [(m) => [user, answer('private work'), envelope(m), answer('reply')], 'merged_turn'],
    [(m) => [envelope(m), envelope(other), answer('reply')], 'merged_turn'],
    [(m) => [envelope(m), failedCall, answer('could not reply')], 'reply_call_failed'],
    [(m) => [envelope(m), answer('a'), answer('b')], 'no_single_answer'],
    [(m) => [envelope(m), answer('', 'final_answer')], 'no_single_answer'],
    [(m) => [envelope(m), answer('partial')], 'turn_interrupted', 'interrupted'],
    [(m) => [envelope(m), answer('partial')], 'turn_failed', 'failed'],
  ];
  for (const [items, reason, status] of cases) {
    const { hub, finish, adapter } = fallback(t);
    const input = request();
    await hub.send(input);
    const receipt = await finish(input.messageId, items(input.messageId), status);
    assert.equal(receipt.reply, undefined);
    assert.equal(receipt.status, 'received');
    assert.equal(receipt.noReply?.reason, reason);
    adapter.emit('update', {
      messageId: input.messageId,
      status: 'replied',
      reply: { text: 'real reply' },
    });
    assert.equal(hub.receipt(input.messageId).noReply, undefined);
    assert.equal(hub.receipt(input.messageId).reply?.text, 'real reply');
  }
});

test('an explicit reply wins, and the fallback stays off by default', async (t) => {
  const on = fallback(t);
  const input = request();
  await on.hub.send(input);
  on.adapter.emit('update', {
    messageId: input.messageId,
    status: 'replied',
    reply: { text: 'explicit' },
  });
  const call = { type: 'mcpToolCall', tool: 'reply_agent', status: 'completed' };
  const receipt = await on.finish(input.messageId, [
    envelope(input.messageId),
    call,
    answer('done'),
  ]);
  assert.equal(receipt.reply?.text, 'explicit');
  assert.equal(receipt.reply?.metadata, undefined);
  const off = fallback(t, false);
  const other = request();
  await off.hub.send(other);
  await off.finish(other.messageId, [envelope(other.messageId), answer('text')]);
  assert.equal(off.hub.receipt(other.messageId).reply, undefined);
  assert.equal(off.rpc.calls.filter((c) => c.params.includeTurns).length, 0);
});

test('a forwarded fallback is labeled, watches resume after restart, and close stops polling', async (t) => {
  const { hub, adapter, rpc, finish } = fallback(t);
  await hub.ready();
  const restored = randomUUID();
  await adapter.restore([
    {
      ...request(),
      messageId: restored,
      hopCount: 0,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    },
  ]);
  const input = {
    ...request(),
    replyTo: { harness: 'codex', instance: 'local', sessionId: id },
  };
  await hub.send(input);
  await finish(input.messageId, [envelope(input.messageId), answer('answer')]);
  const forwarded = await hub.receipt(input.messageId);
  assert.equal(forwarded.reply?.text, 'answer');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const outputs = rpc.calls
    .filter((c) => c.method === 'turn/start')
    .map((c) => JSON.parse(String((c.params.toolOutput as { output: string }).output)));
  const result = outputs.find((o) => o.message.messageKind === 'result');
  assert.match(result.message.origin.name, /did not call reply_agent/);
  await hub.close();
  const reads = rpc.calls.length;
  rpc.emit('notification', { method: 'turn/completed', params: { threadId: id } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(rpc.calls.length, reads);
});

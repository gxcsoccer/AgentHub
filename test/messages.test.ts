import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentHub } from '../src/hub.js';
import { openReceiptStore } from '../src/store.js';
import { TestAdapter, httpFixture, testAddress } from './helpers.js';
import type { MessageInput } from '../src/types.js';

const input = (extra: Partial<MessageInput> = {}): MessageInput => ({
  messageId: randomUUID(),
  to: testAddress,
  origin: { name: 'test', session: { ...testAddress, sessionId: 'origin' } },
  text: 'request text',
  delivery: 'peer_message',
  ...extra,
});
async function stateFile(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ah-messages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.sqlite');
}

test('listMessages returns text and origin, pages by change, and a changed message reappears', async (t) => {
  const adapter = new TestAdapter();
  const hub = new AgentHub([adapter]);
  t.after(() => hub.close());
  const first = input({ messageKind: 'request' }),
    second = input();
  await hub.send(first);
  await hub.send(second);
  const one = await hub.listMessages({ limit: 1 });
  assert.equal(one.hasMore, true);
  assert.equal(one.gap, false);
  assert.equal(one.data[0]!.envelope.text, 'request text');
  assert.equal(one.data[0]!.envelope.origin.session?.sessionId, 'origin');
  const two = await hub.listMessages({ cursor: one.nextCursor });
  assert.equal(two.hasMore, false);
  assert.deepEqual(
    two.data.map((m) => m.envelope.messageId),
    [second.messageId],
  );
  assert.equal((await hub.listMessages({ cursor: two.nextCursor })).data.length, 0);
  adapter.emit('update', {
    messageId: first.messageId,
    status: 'replied',
    reply: { text: 'answer' },
  });
  const changed = await hub.listMessages({ cursor: two.nextCursor });
  assert.equal(changed.data[0]!.receipt.reply?.text, 'answer');
  await assert.rejects(hub.listMessages({ cursor: 'bad' }), { code: 'invalid_cursor' });
  await assert.rejects(hub.listMessages({ limit: 0 }), { code: 'invalid_input' });
  await assert.rejects(hub.listMessages({}, 'agents'), { code: 'forbidden' });
  await assert.rejects(hub.clearMessages('agents'), { code: 'forbidden' });
});

test('expiry reports a gap to an older cursor, including after a restart', async (t) => {
  const file = await stateFile(t);
  const store = await openReceiptStore(file);
  const hub = new AgentHub([new TestAdapter()], { store, receiptTtlMs: 1 });
  const start = (await hub.listMessages()).nextCursor;
  await hub.send(input());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const page = await hub.listMessages({ cursor: start });
  assert.equal(page.gap, true);
  assert.equal(page.data.length, 0);
  assert.equal((await hub.listMessages({ cursor: page.nextCursor })).gap, false);
  await hub.close();
  const restored = new AgentHub([new TestAdapter()], { store: await openReceiptStore(file) });
  t.after(() => restored.close());
  assert.equal((await restored.listMessages({ cursor: start })).gap, true);
  const foreign = await restored.listMessages({ cursor: randomUUID() + ':1' });
  assert.equal(foreign.gap, true);
});

test('clearMessages keeps waiting requests, removes text from disk and survives restart', async (t) => {
  const file = await stateFile(t);
  const store = await openReceiptStore(file);
  const adapter = new TestAdapter();
  const hub = new AgentHub([adapter], { store });
  const before = hub.events.cursor;
  const finished = input({ text: 'secret finished text' }),
    waiting = input({ messageKind: 'request', text: 'still waiting' }),
    answered = input({ messageKind: 'request', text: 'secret answered text' });
  await hub.send(finished);
  await hub.send(waiting);
  await hub.send(answered);
  adapter.emit('update', {
    messageId: answered.messageId,
    status: 'replied',
    reply: { text: 'secret reply text' },
  });
  store.setMeta('feature:connectors:registry', { kept: true });
  store.setMeta('feature:connector-cli-activation:registry', { kept: true });
  const seen: string[] = [];
  hub.events.on('event', (event) => seen.push(event.type));
  assert.deepEqual(await hub.clearMessages(), { removed: 2, retained: 1 });
  assert.deepEqual(seen, ['messages.cleared']);
  assert.throws(() => hub.events.replay(before), /expired/);
  const after = await hub.listMessages({ cursor: before });
  assert.equal(after.gap, true);
  assert.equal((await hub.listMessages()).data[0]!.envelope.messageId, waiting.messageId);
  assert.throws(() => hub.receipt(finished.messageId), /not found/);
  adapter.emit('update', {
    messageId: waiting.messageId,
    status: 'replied',
    reply: { text: 'late reply' },
  });
  assert.equal(hub.receipt(waiting.messageId).reply?.text, 'late reply');
  await hub.close();
  const db = new DatabaseSync(file, { readOnly: true });
  const dump = JSON.stringify([
    db.prepare('SELECT value FROM receipts').all(),
    db.prepare('SELECT value FROM events').all(),
  ]);
  db.close();
  assert.doesNotMatch(dump, /secret/);
  const reopened = await openReceiptStore(file);
  const restored = new AgentHub([new TestAdapter()], { store: reopened });
  t.after(() => restored.close());
  assert.equal((await restored.listMessages()).data.length, 1);
  assert.deepEqual(reopened.getMeta('feature:connectors:registry'), { kept: true });
  assert.deepEqual(reopened.getMeta('feature:connector-cli-activation:registry'), { kept: true });
});

test('owner HTTP routes list and clear messages', async (t) => {
  const { client, hub } = await httpFixture(t);
  const message = input();
  await hub.send(message);
  assert.equal((await client.listMessages()).data[0]!.envelope.text, 'request text');
  assert.deepEqual(await client.clearMessages(), { removed: 1, retained: 0 });
  assert.equal((await client.listMessages()).data.length, 0);
});

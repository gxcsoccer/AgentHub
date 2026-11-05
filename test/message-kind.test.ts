import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHub } from '../src/hub.js';
import { openReceiptStore } from '../src/store.js';
import { messageInput, fingerprint } from '../src/validation.js';
import { TestAdapter, testAddress, httpFixture } from './helpers.js';

const message = () => ({
  messageId: randomUUID(),
  to: testAddress,
  delivery: 'peer_message' as const,
  origin: { name: 'test' },
  text: 'answer',
  inReplyTo: randomUUID(),
});

test('message kind is validated without changing omitted-field fingerprints', () => {
  const value = message();
  assert.equal(Object.hasOwn(messageInput(value), 'messageKind'), false);
  const before = fingerprint(messageInput(value));
  assert.equal(fingerprint(messageInput({ ...value, messageKind: undefined })), before);
  assert.equal(messageInput({ ...value, messageKind: 'result' }).messageKind, 'result');
  for (const kind of [null, '', 'notification', true])
    assert.throws(() => messageInput({ ...value, messageKind: kind }), /messageKind/);
  assert.throws(
    () => messageInput({ ...value, messageKind: 'result', replyTo: testAddress }),
    /result.*replyTo/i,
  );
  assert.throws(
    () => messageInput({ ...value, messageKind: 'result', delivery: 'user_input' }),
    /external messages/,
  );
});

test('HTTP preserves kind, rejects result reply routes and includes kind in idempotency', async (t) => {
  const adapter = new TestAdapter();
  const { client, hub } = await httpFixture(t, adapter);
  const value = { ...message(), messageKind: 'result' as const };
  await client.send(value);
  assert.equal(adapter.calls[0]!.messageKind, 'result');
  await client.send(value);
  assert.equal(adapter.calls.length, 1);
  await assert.rejects(client.send({ ...value, messageKind: 'request' }), /different payload/);
  await assert.rejects(
    client.send({ ...value, messageId: randomUUID(), replyTo: testAddress }),
    /result.*replyTo/i,
  );
  adapter.emit('update', { messageId: value.messageId, status: 'received' });
  adapter.emit('update', {
    messageId: value.messageId,
    status: 'replied',
    reply: { text: 'loop' },
  });
  adapter.emit('update', {
    messageId: value.messageId,
    status: 'received',
    reply: { text: 'smuggled' },
  });
  assert.equal(hub.receipt(value.messageId).status, 'received');
  assert.equal(hub.receipt(value.messageId).reply, undefined);
});

test('state upgrade preserves legacy idempotency and result suppression after reopening', async (t) => {
  const dir = await mkdtemp('/tmp/ah-kind-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const legacy = message();
  let adapter = new TestAdapter();
  let hub = new AgentHub([adapter], { store: await openReceiptStore(path) });
  t.after(() => hub.close());
  await hub.send(legacy);
  await hub.close();
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path);
  old.exec('PRAGMA user_version=2');
  old.close();
  adapter = new TestAdapter();
  hub = new AgentHub([adapter], { store: await openReceiptStore(path) });
  await hub.send(legacy);
  assert.equal(adapter.calls.length, 0);
  const result = { ...message(), messageKind: 'result' as const };
  await hub.send(result);
  await hub.close();
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
  db.close();
  adapter = new TestAdapter();
  hub = new AgentHub([adapter], { store: await openReceiptStore(path) });
  await hub.ready();
  await hub.send(result);
  assert.equal(adapter.calls.length, 0);
  adapter.emit('update', {
    messageId: result.messageId,
    status: 'replied',
    reply: { text: 'late loop' },
  });
  assert.equal(hub.receipt(result.messageId).reply, undefined);
  assert.equal(hub.receipt(result.messageId).status, 'accepted');
});

test('persisted result records cannot contain a business reply', async (t) => {
  const dir = await mkdtemp('/tmp/ah-kind-corrupt-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openReceiptStore(join(dir, 'state.sqlite'));
  const hub = new AgentHub([new TestAdapter()], { store });
  t.after(() => hub.close());
  await hub.send({ ...message(), messageKind: 'result' });
  const rows = store.load();
  rows[0]!.receipt.reply = { text: 'invalid reply to a result' };
  assert.throws(() => store.save(rows), /Invalid persisted receipt/);
  assert.equal(store.load()[0]!.receipt.reply, undefined);
});

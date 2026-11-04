import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessHub } from '../src/hub.js';
import { openReceiptStore } from '../src/store.js';
import { TestAdapter, testAddress } from './helpers.js';
import { openLocalHub } from '../src/runtime.js';

const input = () => ({
  messageId: randomUUID(),
  to: testAddress,
  delivery: 'peer_message' as const,
  origin: { name: 'test' },
  text: 'hello',
});
async function directory(t: test.TestContext) {
  const dir = await mkdtemp('/tmp/hh-store-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.sqlite');
}

test('durable receipts deduplicate across restart and retain payload conflicts', async (t) => {
  const path = await directory(t),
    first = new TestAdapter();
  const hub = new HarnessHub([first], { store: await openReceiptStore(path) });
  await hub.ready();
  const message = input();
  await hub.send(message);
  first.emit('update', {
    messageId: message.messageId,
    status: 'replied',
    reply: { text: 'answer' },
  });
  await hub.close();
  const second = new TestAdapter(),
    restored = new HarnessHub([second], { store: await openReceiptStore(path) });
  t.after(() => restored.close());
  await restored.ready();
  assert.equal((await restored.send(message)).reply?.text, 'answer');
  assert.equal(second.calls.length, 0);
  await assert.rejects(restored.send({ ...message, text: 'changed' }), /different payload/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a reserved or dispatching receipt becomes unknown on recovery and is never resubmitted', async (t) => {
  const path = await directory(t),
    adapter = new TestAdapter();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  adapter.send = async (m) => {
    adapter.calls.push(m);
    await gate;
    return { status: 'accepted' };
  };
  const store = await openReceiptStore(path),
    hub = new HarnessHub([adapter], { store });
  await hub.ready();
  const m = input(),
    sending = hub.send(m);
  await new Promise((r) => setImmediate(r));
  // Snapshot the committed record exactly as a process killed here would leave it.
  const snapshot = store.load();
  assert.equal(snapshot[0]?.phase, 'dispatching');
  release();
  await sending;
  await hub.close();
  const crashed = await openReceiptStore(path);
  crashed.save(snapshot);
  crashed.close();
  const next = new TestAdapter(),
    recovered = new HarnessHub([next], { store: await openReceiptStore(path) });
  t.after(() => recovered.close());
  await recovered.ready();
  assert.equal(recovered.receipt(m.messageId).status, 'unknown');
  await recovered.send(m);
  assert.equal(next.calls.length, 0);
});

test('one store has one live owner and the lock is reusable after close', async (t) => {
  const path = await directory(t),
    store = await openReceiptStore(path);
  await assert.rejects(openReceiptStore(path), /already open|in use/);
  store.close();
  const next = await openReceiptStore(path);
  next.close();
});

test('a saved reply route resumes an unreserved forward once, preserving its message ID', async (t) => {
  const path = await directory(t),
    a = new TestAdapter();
  const store = await openReceiptStore(path),
    hub = new HarnessHub([a], { store });
  await hub.ready();
  const m = { ...input(), replyTo: testAddress };
  await hub.send(m);
  // Crash point: reply and forwarding intent committed, child not yet reserved.
  const rows = store.load(),
    row = rows[0]!;
  row.receipt.status = 'replied';
  row.receipt.reply = { text: 'reply' };
  row.receipt.forwardedMessageId = randomUUID();
  row.forwardState = 'ready';
  await hub.close();
  const seed = await openReceiptStore(path);
  seed.save(rows);
  seed.close();
  const b = new TestAdapter(),
    recovered = new HarnessHub([b], { store: await openReceiptStore(path) });
  await recovered.ready();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0]?.messageId, row.receipt.forwardedMessageId);
  await recovered.close();
  const c = new TestAdapter(),
    again = new HarnessHub([c], { store: await openReceiptStore(path) });
  t.after(() => again.close());
  await again.ready();
  assert.equal(c.calls.length, 0);
  assert.equal(again.receipt(m.messageId).forwardedMessageId, row.receipt.forwardedMessageId);
});

test('transaction rollback preserves the prior receipt, and expiry removes its correlation metadata', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const path = await directory(t),
    store = await openReceiptStore(path),
    adapter = new TestAdapter();
  const hub = new HarnessHub([adapter], { store, receiptTtlMs: 1000 });
  await hub.ready();
  const m = input();
  await hub.send(m);
  const rows = store.load();
  store.setMeta(`adapter:outgoing:${m.messageId}`, { inbox: 'test.sock' });
  const changed = structuredClone(rows[0]!);
  changed.receipt.status = 'held';
  const invalid = structuredClone(changed);
  invalid.fingerprint = 'corrupt';
  assert.throws(() => store.save([changed, invalid]), /Invalid persisted/);
  assert.equal(store.load()[0]?.receipt.status, 'accepted');
  t.mock.timers.tick(1001);
  assert.throws(() => hub.receipt(m.messageId), /expired/);
  assert.equal(store.load().length, 0);
  assert.equal(store.getMeta(`adapter:outgoing:${m.messageId}`), undefined);
  await hub.close();
  const next = await openReceiptStore(path);
  next.save(rows);
  next.close();
  const expired = new HarnessHub([], { store: await openReceiptStore(path) });
  await expired.ready();
  assert.throws(() => expired.receipt(m.messageId), /expired/);
  await expired.close();
});

test('opening with invalid configuration or a close-time disk failure still releases store ownership', async (t) => {
  const path = await directory(t);
  await assert.rejects(openLocalHub({ typo: true }, { stateFile: path }));
  const store = await openReceiptStore(path),
    adapter = new TestAdapter();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  adapter.send = async () => {
    await gate;
    return { status: 'accepted' };
  };
  const hub = new HarnessHub([adapter], { store });
  await hub.ready();
  const sending = hub.send(input());
  await new Promise((r) => setImmediate(r));
  store.appendEvent = () => {
    throw new Error('disk full during shutdown');
  };
  await assert.rejects(hub.close(), /disk full/);
  release();
  await sending;
  const recovered = await openLocalHub({ codex: false, claude: false }, { stateFile: path });
  await recovered.close();
  const ephemeral = await openLocalHub({ codex: false, claude: false }, { stateFile: false });
  await ephemeral.close();
});

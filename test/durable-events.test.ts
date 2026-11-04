import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventLog } from '../src/events.js';
import { openReceiptStore } from '../src/store.js';
import { AgentHub } from '../src/hub.js';
import { TestAdapter, testAddress } from './helpers.js';
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'hh-events-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'state.sqlite');
}
test('bounded durable events survive restart with the same cursor and explicit expiration', async (t) => {
  const file = await fixture(t),
    store = await openReceiptStore(file),
    log = new EventLog(store, 2);
  const start = log.cursor;
  log.publish('one', {});
  const cursor = log.cursor;
  log.publish('two', {});
  log.publish('three', {});
  assert.throws(() => log.replay(start), /expired/);
  store.close();
  const next = await openReceiptStore(file);
  t.after(() => next.close());
  const restored = new EventLog(next, 2);
  assert.equal(restored.durable, true);
  assert.deepEqual(
    restored.replay(cursor).map((e) => e.type),
    ['two', 'three'],
  );
  restored.publish('four', {});
  assert.throws(() => restored.replay(cursor), /expired/);
  assert.throws(() => restored.replay(restored.cursor + ':extra'), /Malformed/);
  assert.throws(() => restored.replay(restored.cursor.split(':')[0] + ':9999'), /future/);
});
test('receipt and evidence commit atomically; failed writes cannot dispatch', async (t) => {
  const file = await fixture(t),
    store = await openReceiptStore(file),
    adapter = new TestAdapter();
  const hub = new AgentHub([adapter], { store });
  await hub.ready();
  const cursor = hub.events.cursor;
  const input = {
    messageId: randomUUID(),
    to: testAddress,
    delivery: 'peer_message' as const,
    origin: { name: 'test' },
    text: 'hello',
  };
  const append = store.appendEvent!.bind(store);
  store.appendEvent = (event, state, records) =>
    append(event, state, [...(records ?? []), { ...records![0]!, fingerprint: 'invalid' }]);
  await assert.rejects(hub.send(input), /Invalid persisted/);
  assert.equal(adapter.calls.length, 0);
  assert.equal(store.load().length, 0);
  assert.equal(hub.events.cursor, cursor);
  await hub.close();
  const next = await openReceiptStore(file);
  t.after(() => next.close());
  assert.equal(next.loadEvents!()?.events.length, 0);
});
test('schema 1 upgrades without dropping receipts, while corrupt checkpoints fail closed', async (t) => {
  const file = await fixture(t),
    store = await openReceiptStore(file);
  store.close();
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE events; PRAGMA user_version=1');
  db.close();
  const next = await openReceiptStore(file);
  const log = new EventLog(next);
  log.publish('one', {});
  next.close();
  const corrupt = new DatabaseSync(file);
  corrupt.exec('DELETE FROM events');
  corrupt.close();
  const broken = await openReceiptStore(file);
  t.after(() => broken.close());
  assert.throws(() => new EventLog(broken), /gap/);
});

test('an empty durable event cursor remains valid across restarts', async (t) => {
  const path = await fixture(t),
    store = await openReceiptStore(path),
    log = new EventLog(store);
  const cursor = log.cursor;
  store.close();
  const restoredStore = await openReceiptStore(path);
  t.after(() => restoredStore.close());
  const restored = new EventLog(restoredStore);
  assert.equal(restored.cursor, cursor);
  assert.deepEqual(restored.replay(cursor), []);
});

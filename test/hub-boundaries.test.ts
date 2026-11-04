import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentHub } from '../src/hub.js';
import { TestAdapter, testAddress } from './helpers.js';
import { createLocalHub } from '../src/runtime.js';
import type { MessageInput } from '../src/types.js';
const input = (): MessageInput => ({
  messageId: randomUUID(),
  to: testAddress,
  origin: { name: 'test' },
  text: 'hello',
  delivery: 'peer_message',
});

test('capacity retains pending submissions and expiry frees completed receipts', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const adapter = new TestAdapter();
  const hub = new AgentHub([adapter], { receiptCapacity: 1, receiptTtlMs: 100 });
  t.after(() => hub.close());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  adapter.send = async (e) => {
    adapter.calls.push(e);
    await gate;
    return { status: 'accepted' };
  };
  const first = input();
  const pending = hub.send(first);
  t.mock.timers.tick(1000);
  await assert.rejects(hub.send(input()), /capacity/);
  release();
  await pending;
  await assert.rejects(hub.send(input()), /capacity/);
  t.mock.timers.tick(101);
  assert.throws(() => hub.receipt(first.messageId), /expired/);
  await hub.send(input());
  assert.equal(adapter.calls.length, 2);
});

test('invalid inputs and unknown instances never reach an adapter', async (t) => {
  const adapter = new TestAdapter();
  const hub = new AgentHub([adapter]);
  t.after(() => hub.close());
  const invalid = [
    null,
    [],
    {},
    { ...input(), messageId: 'bad' },
    { ...input(), text: ' ' },
    { ...input(), text: 'x'.repeat(100001) },
    { ...input(), hopCount: 9 },
    { ...input(), hopCount: -1 },
    { ...input(), expiresAt: 'bad-date' },
    { ...input(), origin: null },
    { ...input(), to: { ...testAddress, instance: 'missing' } },
    { ...input(), replyTo: { ...testAddress, harness: 'missing' } },
  ];
  for (const value of invalid) await assert.rejects(hub.send(value as MessageInput));
  assert.equal(adapter.calls.length, 0);
  for (const q of [{ limit: 0 }, { limit: 1.5 }, { cursor: '' }, { search: ' ' }])
    await assert.rejects(hub.listSessions(testAddress, q));
});

test('foreign and malformed callbacks cannot complete a message; snapshots are immutable', async (t) => {
  const a = new TestAdapter(),
    b = new TestAdapter();
  b.instance = 'other';
  const hub = new AgentHub([a, b]);
  t.after(() => hub.close());
  const m = input();
  await hub.send(m);
  b.emit('update', { messageId: m.messageId, status: 'replied', reply: { text: 'wrong' } });
  a.emit('update', { messageId: m.messageId, status: 'made_up' });
  a.emit('update', {
    messageId: m.messageId,
    status: 'replied',
    reply: { text: 'x'.repeat(100001) },
  });
  a.emit('update', { messageId: randomUUID(), status: 'replied', reply: { text: 'wrong' } });
  assert.equal(hub.receipt(m.messageId).status, 'accepted');
  const snapshot = hub.receipt(m.messageId);
  snapshot.to.sessionId = 'changed';
  assert.equal(hub.receipt(m.messageId).to.sessionId, testAddress.sessionId);
  a.emit('update', { messageId: m.messageId, status: 'received' });
  a.emit('update', { messageId: m.messageId, status: 'unknown' });
  a.emit('update', { messageId: m.messageId, status: 'transport_written' });
  assert.equal(hub.receipt(m.messageId).status, 'received');
});

test('forwarding records failure and hop exhaustion without retry or reply loops', async (t) => {
  const a = new TestAdapter();
  const hub = new AgentHub([a]);
  t.after(() => hub.close());
  for (const mode of ['failed', 'unknown', 'unsupported', 'hop']) {
    const m = { ...input(), replyTo: testAddress, hopCount: mode === 'hop' ? 8 : 0 };
    await hub.send(m);
    const previous = a.getSession.bind(a),
      send = a.send.bind(a);
    if (mode === 'unsupported')
      a.getSession = async (addr) => ({
        ...(await previous(addr)),
        capabilities: { send: [], history: true, liveEvents: false },
      });
    if (mode === 'failed' || mode === 'unknown') a.send = async () => ({ status: mode });
    a.emit('update', { messageId: m.messageId, status: 'replied', reply: { text: 'reply' } });
    await new Promise((r) => setImmediate(r));
    assert(hub.receipt(m.messageId).forwardError);
    assert.equal(hub.receipt(m.messageId).status, 'replied');
    a.getSession = previous;
    a.send = send;
  }
});

test('poll timeout preserves uncertainty and a later reply is observable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = new TestAdapter();
  const hub = new AgentHub([a]);
  t.after(() => hub.close());
  const m = input();
  await hub.send(m);
  a.emit('update', { messageId: m.messageId, status: 'unknown' });
  const waiting = hub.wait(m.messageId, 10);
  t.mock.timers.tick(10);
  assert.equal((await waiting).status, 'unknown');
  a.emit('update', { messageId: m.messageId, status: 'replied', reply: { text: 'late' } });
  assert.equal((await hub.wait(m.messageId)).reply?.text, 'late');
  await assert.rejects(hub.wait(m.messageId, 60001), /timeoutMs/);
});

test('runtime configuration is strict and supports explicitly disabled and multiple instances', async () => {
  for (const bad of [
    { unknown: true },
    { claude: [{ instance: '' }] },
    { codex: [{ instance: 'x', unknown: true }] },
  ])
    assert.throws(() => createLocalHub(bad));
  const empty = createLocalHub({ codex: false, claude: false });
  assert.deepEqual(empty.instances(), []);
  await empty.close();
  const configured = createLocalHub({
    codex: [{ instance: 'a' }, { instance: 'b' }],
    claude: [{ instance: 'c' }],
  });
  assert.equal(configured.instances().length, 3);
  await configured.close();
  const defaults = createLocalHub();
  assert.equal(defaults.instances().length, 2);
  await defaults.close();
  const a = new TestAdapter();
  assert.throws(() => new AgentHub([a, a]), /Duplicate/);
  assert.equal(a.listenerCount('update'), 0);
});

test('non-Error adapter failures still produce stable failed receipts without retries', async (t) => {
  const adapter = new TestAdapter(),
    hub = new AgentHub([adapter]);
  t.after(() => hub.close());
  for (const error of [null, undefined, 'plain failure']) {
    adapter.send = async () => {
      throw error;
    };
    const m = input();
    assert.equal((await hub.send(m)).status, 'failed');
    assert.equal((await hub.send(m)).status, 'failed');
  }
});

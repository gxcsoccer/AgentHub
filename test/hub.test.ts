import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AgentHub } from '../src/hub.js';
import type { Adapter, Envelope, SessionAddress } from '../src/types.js';

const address: SessionAddress = { harness: 'claude', instance: 'local', sessionId: 'native:id' };
class FakeAdapter extends EventEmitter implements Adapter {
  harness = 'claude';
  instance = 'local';
  calls: Envelope[] = [];
  async listSessions() {
    return { data: [], nextCursor: null };
  }
  async getSession(a: SessionAddress) {
    return {
      address: a,
      status: 'idle',
      capabilities: { send: ['peer_message'] as const, history: true, liveEvents: false },
    };
  }
  async history() {
    return { data: [], nextCursor: null };
  }
  async send(message: Envelope) {
    this.calls.push(message);
    return { status: 'transport_written' as const };
  }
  async close() {}
}
function input(messageId = randomUUID()) {
  return {
    messageId,
    to: address,
    origin: { name: 'test' },
    delivery: 'peer_message' as const,
    text: 'hello',
  };
}

test('concurrent duplicate submissions share an attempt; conflicts never send', async () => {
  const adapter = new FakeAdapter();
  const hub = new AgentHub([adapter]);
  const message = input();
  const [a, b] = await Promise.all([hub.send(message), hub.send(message)]);
  assert.equal(adapter.calls.length, 1);
  assert.equal(a.messageId, b.messageId);
  await assert.rejects(hub.send({ ...message, text: 'changed' }), /different payload/);
  await hub.close();
});
test('an early correlated reply is not overwritten by a later transport acknowledgement', async () => {
  const adapter = new FakeAdapter();
  const hub = new AgentHub([adapter]);
  adapter.send = async (message) => {
    adapter.emit('update', {
      messageId: message.messageId,
      status: 'replied',
      reply: { text: 'answer' },
    });
    return { status: 'transport_written' };
  };
  const receipt = await hub.send(input());
  assert.equal(receipt.status, 'replied');
  assert.equal(receipt.reply?.text, 'answer');
  await hub.close();
});
test('uncertain delivery is retained and repeated IDs never resubmit', async () => {
  const adapter = new FakeAdapter();
  const hub = new AgentHub([adapter]);
  adapter.send = async (message) => {
    adapter.calls.push(message);
    throw Object.assign(new Error('disconnected'), { deliveryUnknown: true });
  };
  const message = input();
  assert.equal((await hub.send(message)).status, 'unknown');
  assert.equal((await hub.send(message)).status, 'unknown');
  assert.equal(adapter.calls.length, 1);
  await hub.close();
});
test('delivery semantics and expiry are validated before submission', async () => {
  const adapter = new FakeAdapter();
  const hub = new AgentHub([adapter]);
  await assert.rejects(hub.send({ ...input(), delivery: 'tool_output' }), /does not support/);
  await assert.rejects(hub.send({ ...input(), expiresAt: new Date(0).toISOString() }), /expired/);
  assert.equal(adapter.calls.length, 0);
  await hub.close();
});
test('reply forwarding is explicit and forwards at most once without creating a reply loop', async () => {
  const adapter = new FakeAdapter();
  const hub = new AgentHub([adapter]);
  const message = input();
  await hub.send({ ...message, replyTo: address });
  adapter.emit('update', {
    messageId: message.messageId,
    status: 'replied',
    reply: { text: 'answer' },
  });
  adapter.emit('update', {
    messageId: message.messageId,
    status: 'replied',
    reply: { text: 'answer' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[1]?.inReplyTo, message.messageId);
  assert.equal(adapter.calls[1]?.replyTo, undefined);
  await hub.close();
});
test('closing the hub releases pending receipt waiters', async () => {
  const adapter = new FakeAdapter();
  const hub = new AgentHub([adapter]);
  const message = input();
  await hub.send(message);
  const waiting = hub.wait(message.messageId, 60000);
  await hub.close();
  assert.equal((await waiting).messageId, message.messageId);
});
test('late delivery evidence resolves unknown without regressing a reply', async () => {
  const adapter = new FakeAdapter();
  const hub = new AgentHub([adapter]);
  const message = input();
  await hub.send(message);
  adapter.emit('update', { messageId: message.messageId, status: 'unknown' });
  adapter.emit('update', { messageId: message.messageId, status: 'received' });
  assert.equal(hub.receipt(message.messageId).status, 'received');
  adapter.emit('update', {
    messageId: message.messageId,
    status: 'replied',
    reply: { text: 'answer' },
  });
  adapter.emit('update', { messageId: message.messageId, status: 'rejected' });
  assert.equal(hub.receipt(message.messageId).status, 'replied');
  await hub.close();
});

test('closing during session lookup prevents a subsequent native send', async () => {
  const adapter = new FakeAdapter();
  const lookup = adapter.getSession.bind(adapter);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  adapter.getSession = async (a) => {
    await gate;
    return lookup(a);
  };
  const hub = new AgentHub([adapter]);
  const sending = hub.send(input());
  await hub.close();
  release();
  await assert.rejects(sending, /closed/);
  assert.equal(adapter.calls.length, 0);
});

test('receipt expiry during long polling rejects without an uncaught timer error', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const hub = new AgentHub([new FakeAdapter()], { receiptTtlMs: 1000 });
  const message = input();
  await hub.send(message);
  const waiting = hub.wait(message.messageId, 2000);
  const rejected = assert.rejects(waiting, /expired/);
  t.mock.timers.tick(2000);
  await rejected;
  await hub.close();
});

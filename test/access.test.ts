import test from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AgentHub } from '../src/hub.js';
import { TestAdapter, testAddress } from './helpers.js';
import { AccessPolicy, authenticator } from '../src/access.js';
const caller = {
  id: 'app-a',
  grants: [
    {
      harness: 'test',
      instance: 'local',
      sessions: [testAddress.sessionId],
      operations: ['read', 'send'] as ('read' | 'send')[],
    },
  ],
};
const input = () => ({
  messageId: randomUUID(),
  to: testAddress,
  delivery: 'peer_message' as const,
  origin: { name: 'test' },
  text: 'hello',
});
test('caller denial occurs before adapter access, including replyTo and owner operations', async () => {
  const adapter = new TestAdapter();
  let reads = 0;
  const read = adapter.getSession.bind(adapter);
  adapter.getSession = async (a) => {
    reads++;
    return read(a);
  };
  const hub = new AgentHub([adapter], { callers: [caller] });
  await assert.rejects(
    hub.send({ ...input(), to: { ...testAddress, sessionId: 'forbidden' } }, 'app-a'),
    /authorized/,
  );
  await assert.rejects(
    hub.send({ ...input(), replyTo: { ...testAddress, sessionId: 'forbidden' } }, 'app-a'),
    /authorized/,
  );
  await assert.rejects(
    hub.attachReplyRoute(testAddress, { acceptResumeRace: true }, 'app-a'),
    /authorized/,
  );
  await assert.rejects(
    hub.getSession({ ...testAddress, instance: 'other' }, 'app-a'),
    /authorized/,
  );
  assert.equal(reads, 0);
  assert.equal(adapter.calls.length, 0);
  await hub.close();
});
test('receipts and same-id submissions cannot cross caller boundaries', async () => {
  const hub = new AgentHub([new TestAdapter()], {
    callers: [caller, { ...caller, id: 'app-b' }],
  });
  const message = input();
  await hub.send(message, 'app-a');
  assert.throws(() => hub.receipt(message.messageId, 'app-b'), /not found/i);
  await assert.rejects(hub.send(message, 'app-b'), /not found/i);
  assert.equal(hub.receipt(message.messageId, 'app-a').messageId, message.messageId);
  await hub.close();
});
test('credential configuration fails closed and targeted grants do not authorize other sessions', () => {
  const policy = new AccessPolicy([caller]),
    owner = 'owner'.repeat(10),
    token = 'caller'.repeat(10);
  const auth = authenticator(owner, [{ id: 'app-a', token }], policy);
  assert.equal(auth('Bearer ' + token), 'app-a');
  assert.throws(() => auth('Bearer wrong'), /Valid bearer/);
  assert.throws(() => authenticator(owner, [{ id: 'app-a', token: owner }], policy), /unique/);
  assert.throws(() => new AccessPolicy([{ ...caller, id: '@owner' }]), /policy/);
  assert.equal(policy.allows('app-a', 'approve', testAddress, testAddress.sessionId), false);
});

test('HTTP tokens isolate discovery, receipts, SSE, history and approvals', async (t) => {
  const { createHubServer } = await import('../src/server.js');
  const { AgentHubClient } = await import('../src/client.js');
  const adapter = new TestAdapter();
  const hub = new AgentHub([adapter], { callers: [caller, { ...caller, id: 'app-b' }] });
  const tokens = { owner: 'owner'.repeat(10), a: 'caller-a'.repeat(8), b: 'caller-b'.repeat(8) };
  const app = createHubServer({
    hub,
    token: tokens.owner,
    callers: [
      { id: 'app-a', token: tokens.a },
      { id: 'app-b', token: tokens.b },
    ],
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const address = app.server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const a = new AgentHubClient({ baseUrl, token: tokens.a }),
    b = new AgentHubClient({ baseUrl, token: tokens.b });
  assert.equal((await a.listSessions(testAddress)).data.length, 1);
  assert.equal(
    adapter.queries.length,
    0,
    'scoped discovery must not enumerate unauthorized sessions',
  );
  await assert.rejects(a.history({ ...testAddress, sessionId: 'secret' }), /authorized/);
  await assert.rejects(a.pendingRequests(testAddress), /authorized/);
  await assert.rejects(a.attachReplyRoute(testAddress, { acceptResumeRace: true }), /authorized/);
  const cursor = hub.events.cursor,
    ma = input(),
    mb = input();
  await a.send(ma);
  await b.send(mb);
  await assert.rejects(b.receipt(ma.messageId), /not found/i);
  const stream = a.events({ after: cursor });
  const seen = [];
  for await (const event of stream) {
    if (event.event === 'ready') break;
    seen.push((event.data as { data: { messageId: string } }).data.messageId);
  }
  assert(seen.length >= 2);
  assert(seen.every((id) => id === ma.messageId));
  const forbidden = a.events({ address: { ...testAddress, sessionId: 'secret' } });
  await assert.rejects(forbidden.next(), /authorized/);
});

test('private caller files load relative tokens and reject unsafe files or invalid grants', async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadAccessFile } = await import('../src/access-file.js');
  const dir = await mkdtemp(join(tmpdir(), 'hh-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const token = 'private-caller-token'.repeat(4),
    path = join(dir, 'access.json');
  await writeFile(join(dir, 'token'), token, { mode: 0o600 });
  await writeFile(path, JSON.stringify({ callers: [{ ...caller, tokenFile: 'token' }] }), {
    mode: 0o600,
  });
  const loaded = await loadAccessFile(path);
  assert.equal(loaded.credentials[0]?.token, token);
  assert.equal(loaded.policies[0]?.id, 'app-a');
  await chmod(path, 0o644);
  await assert.rejects(loadAccessFile(path), /private/);
  await chmod(path, 0o600);
  await writeFile(
    path,
    JSON.stringify({
      callers: [
        {
          ...caller,
          tokenFile: 'token',
          grants: [{ harness: 'test', instance: 'local', operations: ['unknown'] }],
        },
      ],
    }),
  );
  await assert.rejects(loadAccessFile(path), /operations/);
  await writeFile(path, JSON.stringify({ callers: false }));
  await assert.rejects(loadAccessFile(path), /callers/);
});

test('approval grants are session scoped and cannot answer another session request', async (t) => {
  const { createHubServer } = await import('../src/server.js');
  const { AgentHubClient } = await import('../src/client.js');
  class Approvals extends TestAdapter {
    answers: string[] = [];
    pendingRequests() {
      return [
        { id: 'mine', address: testAddress, method: 'test', params: {} },
        {
          id: 'secret',
          address: { ...testAddress, sessionId: 'secret' },
          method: 'test',
          params: { secret: true },
        },
      ];
    }
    respondToRequest(id: string) {
      this.answers.push(id);
    }
  }
  const a = new Approvals(),
    hub = new AgentHub([a], {
      callers: [
        {
          id: 'approve',
          grants: [{ ...testAddress, sessions: [testAddress.sessionId], operations: ['approve'] }],
        },
      ],
    });
  const token = 'approval-token'.repeat(4),
    app = createHubServer({ hub, token: 'owner'.repeat(10), callers: [{ id: 'approve', token }] });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const addr = app.server.address();
  assert(addr && typeof addr === 'object');
  const client = new AgentHubClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token });
  assert.deepEqual(
    (await client.pendingRequests(testAddress)).data.map((p) => p.id),
    ['mine'],
  );
  await assert.rejects(
    client.respondToRequest(testAddress, 'secret', { decision: 'accept' }),
    /not found/i,
  );
  assert.equal(a.answers.length, 0);
  await client.respondToRequest(testAddress, 'mine', { decision: 'decline' });
  assert.deepEqual(a.answers, ['mine']);
});

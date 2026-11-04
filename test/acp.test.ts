import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AcpAdapter } from '../src/adapters/acp.js';
import { AgentHub } from '../src/hub.js';
import { httpFixture } from './helpers.js';
const adapter = () =>
  new AcpAdapter({
    instance: 'managed',
    command: process.execPath,
    args: [fileURLToPath(new URL('./acp-agent.js', import.meta.url))],
    permissionTtlMs: 100,
    timeoutMs: 5000,
  });
const message = (to: { harness: string; instance: string; sessionId: string }, text: string) => ({
  messageId: randomUUID(),
  to,
  delivery: 'user_input' as const,
  origin: { name: 'owner' },
  text,
});
test('managed ACP is lazy, explicit user input, isolated and roundtrips through official SDK and child process', async (t) => {
  const a = adapter(),
    { client } = await httpFixture(t, a);
  assert.equal((await client.listSessions({ harness: 'acp', instance: 'managed' })).data.length, 0);
  const first = await client.createSession(a, tmpdir()),
    second = await client.createSession(a, tmpdir());
  assert.notDeepEqual(first.address, second.address);
  await assert.rejects(client.send(message(first.address, 'hi')), /explicit prompt/i);
  await assert.rejects(
    client.send({ ...message(first.address, 'hi'), delivery: 'peer_message' }),
    /semantics/,
  );
  const input = message(first.address, 'hi');
  const reply = await client.prompt(input);
  assert.equal(reply.reply?.text, 'echo:hi');
  assert.equal((await client.prompt(input)).reply?.text, 'echo:hi');
  assert.equal((await client.history(first.address)).data.length, 2);
  assert.equal((await client.history(second.address)).data.length, 0);
  const history = await client.history(first.address, { limit: 1 });
  assert(history.nextCursor);
  assert.equal(
    (await client.history(first.address, { cursor: history.nextCursor })).data[0]?.text,
    'echo:hi',
  );
  assert.equal((await client.search(first.address, { search: 'ECHO:HI' })).data.length, 1);
  const page = await client.listSessions(a, { limit: 1 });
  assert(page.nextCursor);
  assert.equal((await client.listSessions(a, { cursor: page.nextCursor })).data.length, 1);
});
test('ACP permissions time out denied; explicit selected options are validated; cancellation remains an owner operation', async (t) => {
  const a = adapter(),
    hub = new AgentHub([a]);
  t.after(() => hub.close());
  const s = await hub.createSession(a, tmpdir());
  const denied = await hub.prompt(message(s.address, 'permission'));
  assert.match(denied.reply!.text, /cancelled/);
  const prompt = hub.prompt(message(s.address, 'permission'));
  while (!a.pendingRequests().length) await delay(5);
  const p = a.pendingRequests()[0]!;
  assert.throws(
    () => a.respondToRequest(p.id, { outcome: { outcome: 'selected', optionId: 'invalid' } }),
    /optionId/,
  );
  a.respondToRequest(p.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
  assert.match((await prompt).reply!.text, /selected/);
  const waiting = hub.prompt(message(s.address, 'wait'));
  while ((await a.getSession(s.address)).status !== 'busy') await delay(5);
  assert.equal((await hub.prompt(message(s.address, 'overlap'))).error?.code, 'session_busy');
  // Wait until the child has registered the prompt before sending cancellation.
  await delay(25);
  await hub.cancel(s.address);
  assert.equal((await waiting).native?.stopReason, 'cancelled');
});
test('ACP disconnect becomes unknown and does not launch a replacement agent', async (t) => {
  const a = adapter(),
    hub = new AgentHub([a]);
  t.after(() => hub.close());
  const s = await hub.createSession(a, tmpdir());
  const m = message(s.address, 'disconnect');
  assert.equal((await hub.prompt(m)).status, 'unknown');
  assert.equal((await hub.prompt(m)).status, 'unknown');
  await assert.rejects(hub.createSession(a, tmpdir()), /closed/);
});
test('send permission cannot become prompt or session creation permission', async (t) => {
  const a = adapter(),
    hub = new AgentHub([a], {
      callers: [
        {
          id: 'agent',
          grants: [{ harness: 'acp', instance: 'managed', operations: ['send', 'read'] }],
        },
      ],
    });
  t.after(() => hub.close());
  const s = await hub.createSession(a, tmpdir());
  await assert.rejects(hub.prompt(message(s.address, 'untrusted'), 'agent'), /authorized/);
  await assert.rejects(hub.createSession(a, tmpdir(), 'agent'), /authorized/);
  await assert.rejects(hub.cancel(s.address, 'agent'), /authorized/);
});
test('lost ACP session/new closes the owned backend and cannot leave an earlier session busy', async (t) => {
  const a = new AcpAdapter({
    instance: 'managed',
    command: process.execPath,
    args: [fileURLToPath(new URL('./acp-agent.js', import.meta.url))],
    env: { AGENTHUB_TEST_HANG_NEW: '1' },
    timeoutMs: 1000,
  });
  t.after(() => a.close());
  const first = await a.createSession(tmpdir());
  await assert.rejects(a.createSession(tmpdir()));
  assert.equal((await a.getSession(first.address)).status, 'closed');
  await assert.rejects(a.createSession(tmpdir()), /closed/);
  await assert.rejects(
    a.send({
      ...message(first.address, 'no replay'),
      hopCount: 0,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    }),
    /closed/,
  );
  assert.equal((await a.history(first.address)).data.length, 0);
});

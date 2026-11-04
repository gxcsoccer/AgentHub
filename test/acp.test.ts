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
test('lost ACP session/new blocks further creation while existing sessions remain usable', async (t) => {
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
  assert.equal((await a.getSession(first.address)).status, 'idle');
  assert.equal((await a.getSession(first.address)).metadata?.sessionCreationBlocked, true);
  await assert.rejects(a.createSession(tmpdir()), /owner must restart the Hub daemon/i);
  assert.equal(
    (
      await a.send({
        ...message(first.address, 'still usable'),
        hopCount: 0,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
      })
    ).status,
    'replied',
  );
  assert.equal((await a.history(first.address)).data.at(-1)?.text, 'echo:still usable');
});
for (const [envKey, blocked] of [
  ['AGENTHUB_TEST_REJECT_NEW', false],
  ['AGENTHUB_TEST_FAIL_NEW', true],
] as const) {
  test(`ACP creation failure ${envKey} preserves an in-flight permission and prompt`, async (t) => {
    const a = new AcpAdapter({
      instance: 'managed',
      command: process.execPath,
      args: [fileURLToPath(new URL('./acp-agent.js', import.meta.url))],
      env: { [envKey]: '1' },
      timeoutMs: 5000,
      permissionTtlMs: 5000,
    });
    const hub = new AgentHub([a]);
    t.after(() => hub.close());
    const first = await hub.createSession(a, tmpdir());
    const prompt = hub.prompt(message(first.address, 'permission'));
    const deadline = Date.now() + 3000;
    while (!a.pendingRequests().length && Date.now() < deadline) await delay(5);
    const pending = a.pendingRequests()[0];
    assert(pending, 'fixture prompt reached the pending permission');
    await assert.rejects(hub.createSession(a, tmpdir()));
    assert.equal((await a.getSession(first.address)).status, 'busy');
    assert.equal((await a.getSession(first.address)).metadata?.sessionCreationBlocked, blocked);
    assert.equal(a.pendingRequests()[0]?.id, pending.id);
    a.respondToRequest(pending.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
    assert.equal((await prompt).status, 'replied');
    assert.equal(
      (await hub.prompt(message(first.address, 'after failure'))).reply?.text,
      'echo:after failure',
    );
    if (blocked) await assert.rejects(hub.createSession(a, tmpdir()), /creation.*blocked/i);
    else assert.notDeepEqual((await hub.createSession(a, tmpdir())).address, first.address);
  });
}

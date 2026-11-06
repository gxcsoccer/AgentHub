import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openReceiptStore, type ReceiptStore } from '../src/store.js';
import { AgentHub } from '../src/hub.js';
import { ConnectorService } from '../src/connectors/service.js';
import { TestAdapter } from './helpers.js';
import type { Page, SessionAddress, SessionInfo } from '../src/types.js';
import { HubError } from '../src/validation.js';
import type { ProcessIdentity, ConnectorProfile } from '../src/connectors/types.js';

const token = 'connector-enrollment-'.repeat(3);
async function fixture(
  t: test.TestContext,
  store?: ReceiptStore,
  extraProfiles: ConnectorProfile[] = [],
) {
  const a = { harness: 'claude', instance: 'local', sessionId: randomUUID() };
  const b = { ...a, sessionId: randomUUID() };
  const rows = new Map<string, SessionInfo>([
    [
      a.sessionId,
      {
        address: a,
        name: 'worker',
        status: 'idle',
        capabilities: {
          send: ['peer_message'],
          history: true,
          liveEvents: false,
          reply: 'native_callback',
        },
        metadata: { pid: 20001 },
      },
    ],
    [
      b.sessionId,
      {
        address: b,
        name: 'reviewer',
        status: 'idle',
        capabilities: {
          send: ['peer_message'],
          history: true,
          liveEvents: false,
          reply: 'native_callback',
        },
        metadata: { pid: 20002 },
      },
    ],
  ]);
  class Native extends TestAdapter {
    override harness = 'claude';
    override async listSessions(): Promise<Page<SessionInfo>> {
      return { data: [...rows.values()], nextCursor: null };
    }
    override async getSession(address: SessionAddress) {
      const row = rows.get(address.sessionId);
      if (!row) throw new HubError('session_not_found', 'Missing', 404);
      return structuredClone(row);
    }
  }
  const adapter = new Native();
  const hub = new AgentHub([adapter], {
    store,
    callers: [
      {
        id: 'agents',
        grants: [{ harness: 'claude', instance: 'local', operations: ['read', 'send'] }],
      },
      {
        id: 'limited',
        grants: [
          {
            harness: 'claude',
            instance: 'local',
            sessions: [b.sessionId],
            operations: ['read', 'send'],
          },
        ],
      },
    ],
  });
  t.after(() => hub.close());
  const profiles: ConnectorProfile[] = [
    {
      id: 'local-agents',
      callerId: 'agents',
      harness: 'claude',
      instance: 'local',
      enrollmentToken: token,
    },
    ...extraProfiles,
  ];
  const processes = new Map<number, ProcessIdentity>();
  for (const [pid, ppid] of [
    [10001, 20001],
    [10002, 20002],
    [10003, 20001],
    [20001, 30001],
    [20002, 30001],
  ])
    processes.set(pid!, { pid: pid!, ppid: ppid!, uid: process.getuid!(), start: 'start-' + pid });
  const inspect = async (pid: number) => {
    const p = processes.get(pid);
    if (!p) throw new HubError('identity_unavailable', 'Missing process', 409);
    return { ...p };
  };
  const service = new ConnectorService(hub, profiles, { inspect });
  const ea = { pid: 10001, startupSessionId: a.sessionId },
    eb = { pid: 10002, startupSessionId: b.sessionId };
  return { a, b, rows, adapter, hub, profiles, processes, inspect, service, ea, eb };
}

test('enrollment separates credentials and resolves caller source from native process evidence', async (t) => {
  const f = await fixture(t);
  const registered = await f.service.enroll(token, f.ea);
  assert.deepEqual(registered.binding.address, f.a);
  await assert.rejects(f.service.call(token, f.ea, { operation: 'list_peers' }), /credential/);
  await assert.rejects(f.service.enroll(registered.token, f.ea), /credential/);
  await assert.rejects(
    f.service.enroll(token, { ...f.ea, startupSessionId: f.b.sessionId }),
    /identity|session/i,
  );
  await assert.rejects(
    f.service.call(registered.token, f.eb, { operation: 'list_peers' }),
    /process|credential/,
  );
  const peers = (await f.service.call(registered.token, f.ea, { operation: 'list_peers' })) as {
    peers: unknown[];
  };
  assert.equal(peers.peers.length, 2);
  assert(!JSON.stringify(await f.service.connections()).includes(registered.token));
});

test('two bound sources ask and reply without model-supplied source or return route', async (t) => {
  const f = await fixture(t);
  const ca = await f.service.enroll(token, f.ea),
    cb = await f.service.enroll(token, f.eb);
  const request = {
    operation: 'ask' as const,
    messageId: randomUUID(),
    to: '@claude/reviewer',
    message: 'Review this',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const ack = (await f.service.call(ca.token, f.ea, request)) as {
    request: string;
    guidance: string;
  };
  assert.equal(ack.request, request.messageId);
  assert.match(ack.guidance, /end.*turn/i);
  assert.deepEqual(f.adapter.calls[0]!.origin.session, f.a);
  assert.deepEqual(f.adapter.calls[0]!.replyTo, f.a);
  assert.equal(f.adapter.calls[0]!.messageKind, 'request');
  await f.service.call(ca.token, f.ea, request);
  assert.equal(f.adapter.calls.length, 1);
  await assert.rejects(
    f.service.call(ca.token, f.ea, {
      operation: 'reply',
      request: ack.request,
      message: 'wrong source',
    }),
    /request|source/i,
  );
  await f.service.call(cb.token, f.eb, {
    operation: 'reply',
    request: ack.request,
    message: 'Reviewed',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.adapter.calls.length, 2);
  assert.equal(f.adapter.calls[1]!.messageKind, 'result');
  assert.deepEqual(f.adapter.calls[1]!.to, f.a);
  await f.service.call(cb.token, f.eb, {
    operation: 'reply',
    request: ack.request,
    message: 'Reviewed',
  });
  assert.equal(f.adapter.calls.length, 2);
  await assert.rejects(
    f.service.call(cb.token, f.eb, {
      operation: 'reply',
      request: ack.request,
      message: 'changed',
    }),
    /reply|recorded/i,
  );
  await assert.rejects(
    f.service.call(ca.token, f.ea, {
      operation: 'reply',
      request: f.adapter.calls[1]!.messageId,
      message: 'loop',
    }),
    /request|result/i,
  );
});

test('expired connector replies fail before acknowledgement while prior replies remain idempotent', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t),
    ca = await f.service.enroll(token, f.ea),
    cb = await f.service.enroll(token, f.eb);
  const request = {
    operation: 'ask',
    messageId: randomUUID(),
    to: f.b,
    message: 'Review',
    expiresAt: new Date(Date.now() + 1000).toISOString(),
  };
  await f.service.call(ca.token, f.ea, request);
  const answered = { ...request, messageId: randomUUID() };
  await f.service.call(ca.token, f.ea, answered);
  await f.service.call(cb.token, f.eb, {
    operation: 'reply',
    request: answered.messageId,
    message: 'On time',
  });
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(1000);
  await assert.rejects(
    f.service.call(cb.token, f.eb, {
      operation: 'reply',
      request: request.messageId,
      message: 'Late',
    }),
    (e: unknown) => e instanceof HubError && e.code === 'request_expired',
  );
  assert.equal(f.hub.receipt(request.messageId).status, 'accepted');
  assert.equal(f.hub.receipt(request.messageId).reply, undefined);
  assert.equal(f.hub.receipt(request.messageId).forwardError, undefined);
  const duplicate = await f.service.call(cb.token, f.eb, {
    operation: 'reply',
    request: answered.messageId,
    message: 'On time',
  });
  assert.deepEqual(duplicate, { request: answered.messageId, accepted: true, duplicate: true });
  assert.equal(f.adapter.calls.length, 3, 'two requests and only the on-time result');
});

test('clear requires fresh lifecycle evidence, retains in-flight address and blocks old result handles', async (t) => {
  const f = await fixture(t);
  const ca = await f.service.enroll(token, f.ea),
    cb = await f.service.enroll(token, f.eb);
  const request = {
    operation: 'ask' as const,
    messageId: randomUUID(),
    to: f.b,
    message: 'old task',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await f.service.call(ca.token, f.ea, request);
  const fresh = { ...f.a, sessionId: randomUUID() };
  const old = f.rows.get(f.a.sessionId)!;
  f.rows.delete(f.a.sessionId);
  f.rows.set(fresh.sessionId, { ...old, address: fresh });
  await assert.rejects(
    f.service.call(ca.token, f.ea, { operation: 'list_peers' }),
    /lifecycle|identity|session/i,
  );
  // The helper can't recover alone: its evidence still carries the old UUID.
  await assert.rejects(f.service.enroll(token, f.ea), /Session changed/);
  await f.service.hook(token, { pid: 10003, event: 'SessionStart', sessionId: fresh.sessionId });
  const changed = (await f.service.call(ca.token, f.ea, { operation: 'identity' })) as {
    binding: { bindingId: string; address: SessionAddress };
  };
  assert.notEqual(changed.binding.bindingId, ca.binding.bindingId);
  assert.deepEqual(changed.binding.address, fresh);
  await f.service.call(cb.token, f.eb, {
    operation: 'reply',
    request: request.messageId,
    message: 'old answer',
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.adapter.calls.length, 1);
  assert(f.hub.receipt(request.messageId).forwardError);
  await f.service.hook(token, { pid: 10003, event: 'SessionEnd', sessionId: f.a.sessionId });
  assert.deepEqual(
    ((await f.service.call(ca.token, f.ea, { operation: 'identity' })) as typeof changed).binding
      .address,
    fresh,
  );
  await f.service.hook(token, { pid: 10003, event: 'SessionEnd', sessionId: fresh.sessionId });
  await assert.rejects(
    f.service.call(ca.token, f.ea, { operation: 'identity' }),
    /ended|lifecycle/,
  );
});

test('credentials survive service restart but not PID reuse, owner rotation or profile disable', async (t) => {
  const f = await fixture(t);
  const c = await f.service.enroll(token, f.ea);
  let service = new ConnectorService(f.hub, f.profiles, { inspect: f.inspect });
  const result = (await service.call(c.token, f.ea, { operation: 'identity' })) as {
    binding: { bindingId: string };
  };
  assert.equal(result.binding.bindingId, c.binding.bindingId);
  f.processes.get(f.ea.pid)!.start = 'reused';
  await assert.rejects(
    service.call(c.token, f.ea, { operation: 'identity' }),
    /process|credential/,
  );
  f.processes.get(f.ea.pid)!.start = 'start-' + f.ea.pid;
  service = new ConnectorService(f.hub, [{ ...f.profiles[0]!, epoch: 2 }], { inspect: f.inspect });
  await assert.rejects(service.call(c.token, f.ea, { operation: 'identity' }), /revoked/);
  service = new ConnectorService(f.hub, [{ ...f.profiles[0]!, enabled: false }], {
    inspect: f.inspect,
  });
  await assert.rejects(service.enroll(token, f.ea), /disabled/);
  await assert.rejects(service.call(c.token, f.ea, { operation: 'identity' }), /disabled/);
});

test('expiry grace preserves error classification without extending validity or bypassing revocation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t),
    c = await f.service.enroll(token, f.ea);
  t.mock.timers.tick(86400000 + 1);
  await f.service.enroll(token, f.eb);
  const restarted = new ConnectorService(f.hub, f.profiles, { inspect: f.inspect });
  await assert.rejects(
    restarted.call(c.token, f.ea, { operation: 'identity' }),
    (e: unknown) => e instanceof HubError && e.code === 'credential_expired',
  );
  const revoked = new ConnectorService(f.hub, [{ ...f.profiles[0]!, epoch: 1 }], {
    inspect: f.inspect,
  });
  await assert.rejects(
    revoked.call(c.token, f.ea, { operation: 'identity' }),
    (e: unknown) => e instanceof HubError && e.code === 'credential_revoked',
  );
  t.mock.timers.tick(59999);
  await f.service.enroll(token, f.eb);
  await assert.rejects(
    restarted.call(c.token, f.ea, { operation: 'identity' }),
    (e: unknown) => e instanceof HubError && e.code === 'invalid_credential',
  );
  assert.equal(f.adapter.calls.length, 0);
});

test('name collisions, policy boundaries and invalid operation payloads fail before dispatch', async (t) => {
  const f = await fixture(t);
  const c = await f.service.enroll(token, f.ea);
  f.rows.get(f.a.sessionId)!.name = 'reviewer';
  const request = {
    operation: 'ask' as const,
    messageId: randomUUID(),
    to: '@claude/reviewer',
    message: 'work',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await assert.rejects(f.service.call(c.token, f.ea, request), /ambiguous/);
  await assert.rejects(
    f.service.call(c.token, f.ea, {
      ...request,
      expiresAt: new Date(Date.now() + 5 * 3600000).toISOString(),
    }),
    /deadline/,
  );
  await assert.rejects(
    f.service.call(c.token, f.ea, { ...request, origin: { session: f.b } }),
    /input|Unrecognized/,
  );
  const restricted = new ConnectorService(f.hub, [{ ...f.profiles[0]!, callerId: 'limited' }], {
    inspect: f.inspect,
  });
  await assert.rejects(restricted.enroll(token, f.ea), /identity|source|session/i);
  const b = await restricted.enroll(token, f.eb);
  await assert.rejects(restricted.call(b.token, f.eb, { ...request, to: f.a }), /authorized/);
  assert.equal(f.adapter.calls.length, 0);
});

test('persistent connector bindings and hashed credentials survive a real SQLite reopen', async (t) => {
  const dir = await mkdtemp('/tmp/ah-connector-store-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  const f = await fixture(t, await openReceiptStore(path)),
    c = await f.service.enroll(token, f.ea);
  await f.hub.close();
  const disk = await readFile(path);
  assert(!disk.includes(c.token));
  assert(!disk.includes(token));
  const hub = new AgentHub([f.adapter], {
    store: await openReceiptStore(path),
    callers: [
      {
        id: 'agents',
        grants: [{ harness: 'claude', instance: 'local', operations: ['read', 'send'] }],
      },
    ],
  });
  t.after(() => hub.close());
  const service = new ConnectorService(hub, f.profiles, { inspect: f.inspect });
  assert.deepEqual(await service.call(c.token, f.ea, { operation: 'identity' }), {
    binding: c.binding,
  });
});

test('identity owner mismatch, process changes and incomplete discovery fail closed', async (t) => {
  const f = await fixture(t);
  f.processes.get(10001)!.uid++;
  await assert.rejects(f.service.enroll(token, f.ea), /owner/);
  f.processes.get(10001)!.uid--;
  let calls = 0;
  const race = new ConnectorService(f.hub, f.profiles, {
    inspect: async (pid) => {
      const p = await f.inspect(pid);
      if (++calls > 2) p.start += 'changed';
      return p;
    },
  });
  await assert.rejects(race.enroll(token, f.ea), /process changed/);
  f.adapter.listSessions = async () => ({ data: [], nextCursor: 'repeat' });
  await assert.rejects(f.service.enroll(token, f.ea), /discovery incomplete/);
  let pages = 0;
  f.adapter.listSessions = async () => ({ data: [], nextCursor: String(++pages) });
  await assert.rejects(f.service.enroll(token, f.ea), /discovery incomplete/);
  assert.equal(pages, 10);
});

test('disabled reply routes and corrupt or saturated registries are explicit failures', async (t) => {
  const f = await fixture(t),
    c = await f.service.enroll(token, f.ea);
  const input = {
    operation: 'ask',
    messageId: randomUUID(),
    to: f.b,
    message: 'work',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  f.rows.get(f.b.sessionId)!.replyReadiness = {
    state: 'missing_tool',
    tool: 'missing',
    listener: 'detached',
    reason: 'test',
  };
  await assert.rejects(f.service.call(c.token, f.ea, input), /not ready/);
  delete f.rows.get(f.b.sessionId)!.replyReadiness;
  f.rows.get(f.b.sessionId)!.capabilities.send = [];
  await assert.rejects(f.service.call(c.token, f.ea, input), /external messages/);
  assert.throws(
    () => new ConnectorService(f.hub, [{ ...f.profiles[0]!, callerId: '@owner' }]),
    /restricted caller/,
  );
  assert.throws(() => new ConnectorService(f.hub, [f.profiles[0]!, f.profiles[0]!]), /unique/);
  const state = f.hub.featureState('connectors'),
    registry = state.get('registry')!;
  const credentials = registry.credentials as Record<string, unknown>;
  const credential = Object.values(credentials)[0];
  for (let i = 0; i < 4097; i++) credentials['entry' + i] = credential;
  state.set('registry', registry);
  await assert.rejects(f.service.enroll(token, f.ea), /capacity/);
  state.set('registry', { version: 99 });
  assert.throws(() => new ConnectorService(f.hub, f.profiles), /refusing recovery/);
});

test('SessionStart binds only a host with a running helper and never revives a disconnect', async (t) => {
  const f = await fixture(t);
  const bound = async () =>
    (await f.service.connections()).bindings.map((b) => b.address.sessionId);
  const start = (sessionId: string) =>
    f.service.hook(token, { pid: 10003, event: 'SessionStart', sessionId });

  await start(f.a.sessionId);
  assert.deepEqual(await bound(), [], 'hook alone proves nothing about MCP');

  await f.service.enroll(token, f.ea);
  const fresh = { ...f.a, sessionId: randomUUID() };
  f.rows.set(fresh.sessionId, { ...f.rows.get(f.a.sessionId)!, address: fresh });
  f.rows.delete(f.a.sessionId);
  assert.equal((await start(fresh.sessionId)).accepted, true);
  assert((await bound()).includes(fresh.sessionId), 'cleared session stays reachable');

  // A disconnected address still gets its lifecycle record, but no binding.
  await f.service.enroll(token, f.eb);
  const second = { ...f.b, sessionId: randomUUID() };
  f.rows.set(second.sessionId, { ...f.rows.get(f.b.sessionId)!, address: second });
  f.rows.delete(f.b.sessionId);
  await f.service.disconnect({ address: second });
  const before = await bound();
  f.processes.set(10004, { pid: 10004, ppid: 20002, uid: process.getuid!(), start: 'hook' });
  const accepted = await f.service.hook(token, {
    pid: 10004,
    event: 'SessionStart',
    sessionId: second.sessionId,
  });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(await bound(), before);
});

test('SessionStart does not bind for a helper that is gone or replaced', async (t) => {
  const f = await fixture(t);
  const worker = f.rows.get(f.a.sessionId)!;
  await f.service.enroll(token, f.ea);
  const clear = async () => {
    const fresh = { ...f.a, sessionId: randomUUID() };
    f.rows.clear();
    f.rows.set(fresh.sessionId, { ...worker, address: fresh });
    const result = await f.service.hook(token, {
      pid: 10003,
      event: 'SessionStart',
      sessionId: fresh.sessionId,
    });
    assert.equal(result.accepted, true);
    const { bindings } = await f.service.connections();
    return bindings.some((b) => b.address.sessionId === fresh.sessionId);
  };
  const helper = f.processes.get(10001)!;

  f.processes.delete(10001);
  assert.equal(await clear(), false, 'exited');

  f.processes.set(10001, { ...helper, start: 'reused-pid' });
  assert.equal(await clear(), false, 'PID reused');

  f.processes.set(10001, { ...helper, ppid: 20002 });
  assert.equal(await clear(), false, 'different parent');

  f.processes.set(10001, helper);
  assert.equal(await clear(), true, 'still running');
});

test('capacity reclaims stale bindings and ended hooks first, then the oldest, and only the excess', async (t) => {
  const f = await fixture(t);
  const c = await f.service.enroll(token, f.ea);
  const state = f.hub.featureState('connectors'),
    registry = state.get('registry')!;
  const bindings = registry.bindings as Record<string, Record<string, unknown>>;
  const live = Object.keys(bindings)[0]!;
  const hook = (ended: boolean, seenAt: string) => ({
    profileId: c.binding.profileId,
    revision: Object.values(registry.credentials as Record<string, { revision: string }>)[0]!
      .revision,
    host: Object.values(registry.credentials as Record<string, { host: unknown }>)[0]!.host,
    sessionId: randomUUID(),
    ended,
    seenAt,
  });
  const hooks = registry.hooks as Record<string, unknown>;
  for (let i = 0; i < 4096; i++) {
    bindings['stale' + i] = { ...c.binding, lastSeenAt: '2026-01-01T00:00:00.000Z' };
    hooks['live' + i] = hook(false, '2026-02-01T00:00:00.000Z');
  }
  hooks.ended = hook(true, '2026-03-01T00:00:00.000Z');
  state.set('registry', registry);
  await f.service.enroll(token, f.ea);
  const after = state.get('registry')!;
  const rows = after.bindings as Record<string, unknown>;
  assert.equal(Object.keys(rows).length, 4096);
  assert(rows[live]);
  assert(!rows.stale0);
  assert.equal(Object.keys(after.hooks as object).length, 4096);
  assert(!(after.hooks as Record<string, unknown>).ended);
});

test('disconnect takes effect without a restart, survives one, and owner connect reverses it', async (t) => {
  const f = await fixture(t);
  const c = await f.service.enroll(token, f.ea);
  const peer = await f.service.enroll(token, f.eb);
  const ask = (to: unknown, from = c.token, evidence: unknown = f.ea) =>
    f.service.call(from, evidence, {
      operation: 'ask',
      messageId: randomUUID(),
      to,
      message: 'hello',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  const result = await f.service.disconnect({ address: f.b });
  assert.equal(result.removed.bindings, 1);
  assert.equal(result.removed.credentials, 1);
  await assert.rejects(f.service.call(peer.token, f.eb, { operation: 'identity' }), /Unknown/);
  await assert.rejects(f.service.enroll(token, f.eb), { code: 'connector_disconnected' });
  await assert.rejects(ask(f.b), { code: 'peer_not_connected' });
  const listed = (await f.service.call(c.token, f.ea, { operation: 'list_peers' })) as {
    peers: { address: { sessionId: string } }[];
  };
  assert(!listed.peers.some((p) => p.address.sessionId === f.b.sessionId));
  const restarted = new ConnectorService(f.hub, f.profiles, { inspect: f.inspect });
  await assert.rejects(restarted.enroll(token, f.eb), { code: 'connector_disconnected' });
  assert.deepEqual(
    (await restarted.connections()).disconnected.map((d) => d.address),
    [f.b],
  );
  await assert.rejects(restarted.connect({ address: f.b }, 3211));
  await assert.rejects(restarted.enroll(token, f.eb), { code: 'connector_disconnected' });
  await assert.rejects(f.service.disconnect({ profileId: 'missing' }), /Unknown/);
  const off = await f.service.disconnect({ profileId: f.profiles[0]!.id });
  assert.equal(off.removed.bindings, 1);
  await assert.rejects(f.service.enroll(token, f.ea), { code: 'connector_disabled' });
  assert.equal((await f.service.connections()).profiles[0]!.enabled, false);
});

test('reconnect restores an MCP session and a disabled profile, and other sessions stay usable', async (t) => {
  const f = await fixture(t);
  await f.service.enroll(token, f.ea);
  await f.service.enroll(token, f.eb);
  assert.equal((await f.service.reconnect({ address: f.b })).changed, false);
  await f.service.disconnect({ address: f.b });
  await assert.rejects(f.service.enroll(token, f.eb), { code: 'connector_disconnected' });
  assert.equal((await f.service.reconnect({ address: f.b })).changed, true);
  assert.equal((await f.service.enroll(token, f.eb)).binding.address.sessionId, f.b.sessionId);
  await f.service.disconnect({ profileId: f.profiles[0]!.id });
  await assert.rejects(f.service.enroll(token, f.ea), { code: 'connector_disabled' });
  await f.service.reconnect({ profileId: f.profiles[0]!.id });
  await f.service.enroll(token, f.ea);
  assert.equal((await f.service.connections()).profiles[0]!.enabled, true);
  await assert.rejects(f.service.reconnect({ profileId: 'missing' }), /Unknown/);
});

test('disconnect records are never evicted, and capacity refuses a new one', async (t) => {
  const f = await fixture(t);
  await f.service.disconnect({ address: f.b });
  const state = f.hub.featureState('connectors'),
    registry = state.get('registry')!;
  const rows = registry.disconnected as Record<string, { address: unknown; at: string }>;
  for (let i = 1; i < 4096; i++)
    rows['entry' + i] = { address: f.a, at: '2026-12-01T00:00:00.000Z' };
  state.set('registry', registry);
  await assert.rejects(
    f.service.disconnect({ address: { ...f.a, sessionId: randomUUID() } }),
    /capacity/,
  );
  await assert.rejects(f.service.enroll(token, f.eb), { code: 'connector_disconnected' });
});

test('a disconnect during ask stops delivery at the boundary, including a late forward', async (t) => {
  const f = await fixture(t);
  const c = await f.service.enroll(token, f.ea);
  await f.service.enroll(token, f.eb);
  const getSession = f.adapter.getSession.bind(f.adapter);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  f.adapter.getSession = async (address) => {
    if (address.sessionId === f.b.sessionId && ++reads === 2) await gate;
    return getSession(address);
  };
  const asking = f.service.call(c.token, f.ea, {
    operation: 'ask',
    messageId: randomUUID(),
    to: f.b,
    message: 'hello',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.service.disconnect({ address: f.b });
  assert.equal(f.adapter.calls.length, 0);
  release();
  await assert.rejects(asking, { code: 'peer_not_connected' });
  assert.equal(f.adapter.calls.length, 0);
});

test('a profile disconnect during ask stops delivery, and owner sends keep their origin', async (t) => {
  const f = await fixture(t);
  const c = await f.service.enroll(token, f.ea);
  const getSession = f.adapter.getSession.bind(f.adapter);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  f.adapter.getSession = async (address) => {
    if (address.sessionId === f.b.sessionId && ++reads === 2) await gate;
    return getSession(address);
  };
  const asking = f.service.call(c.token, f.ea, {
    operation: 'ask',
    messageId: randomUUID(),
    to: f.b,
    message: 'hello',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  await f.service.disconnect({ profileId: f.profiles[0]!.id });
  release();
  await assert.rejects(asking, { code: 'peer_not_connected' });
  assert.equal(f.adapter.calls.length, 0);
  await f.service.reconnect({ profileId: f.profiles[0]!.id });
  const owner = await f.hub.send({
    messageId: randomUUID(),
    to: f.b,
    origin: { name: 'owner', session: f.a },
    text: 'hello',
    delivery: 'peer_message',
    messageKind: 'request',
  });
  assert.equal(owner.status, 'accepted');
});

test('a source disconnected during ask is refused while its target profile stays enabled', async (t) => {
  const f = await fixture(t, undefined, [
    {
      id: 'second',
      callerId: 'agents',
      harness: 'claude',
      instance: 'local',
      enrollmentToken: 'second-token-'.repeat(4),
    },
  ]);
  const service = f.service;
  const c = await service.enroll(token, f.ea);
  // A binding from another profile must not stand in for the revoked one.
  await service.enroll('second-token-'.repeat(4), f.ea);
  const getSession = f.adapter.getSession.bind(f.adapter);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  f.adapter.getSession = async (address) => {
    if (address.sessionId === f.b.sessionId && ++reads === 2) await gate;
    return getSession(address);
  };
  const asking = service.call(c.token, f.ea, {
    operation: 'ask',
    messageId: randomUUID(),
    to: f.b,
    message: 'hello',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  await service.disconnect({ profileId: f.profiles[0]!.id });
  release();
  await assert.rejects(asking, { code: 'connector_disconnected' });
  assert.equal(f.adapter.calls.length, 0);
});

test('connectedPeersOnly hides unbound, stale and disconnected sessions from peers and ask', async (t) => {
  const f = await fixture(t);
  const service = new ConnectorService(f.hub, f.profiles, {
    inspect: f.inspect,
    connectedPeersOnly: true,
  });
  const c = await service.enroll(token, f.ea);
  const ask = (to: unknown) =>
    service.call(c.token, f.ea, {
      operation: 'ask',
      messageId: randomUUID(),
      to,
      message: 'hello',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  const ids = async () =>
    (
      (await service.call(c.token, f.ea, { operation: 'list_peers' })) as {
        peers: { address: { sessionId: string } }[];
      }
    ).peers.map((p) => p.address.sessionId);
  assert(!(await ids()).includes(f.b.sessionId));
  await assert.rejects(ask(f.b), { code: 'peer_not_connected' });
  await service.enroll(token, f.eb);
  assert((await ids()).includes(f.b.sessionId));
  const state = f.hub.featureState('connectors'),
    registry = state.get('registry')!;
  const bindings = registry.bindings as Record<string, unknown>;
  const key = Object.keys(bindings).find(
    (k) => (bindings[k] as { address: { sessionId: string } }).address.sessionId === f.b.sessionId,
  )!;
  bindings['old-revision'] = bindings[key];
  delete bindings[key];
  state.set('registry', registry);
  assert(!(await ids()).includes(f.b.sessionId));
});

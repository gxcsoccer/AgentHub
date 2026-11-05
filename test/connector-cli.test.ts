import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { AgentHub } from '../src/hub.js';
import { ConnectorService } from '../src/connectors/service.js';
import { createHubServer } from '../src/server.js';
import { TestAdapter, testToken } from './helpers.js';
import type { Adapter, PageQuery, SessionAddress, SessionInfo } from '../src/types.js';
import type { ConnectorProfile, ProcessIdentity } from '../src/connectors/types.js';
import { HubError } from '../src/validation.js';

async function fixture(t: test.TestContext, extra: Adapter[] = []) {
  const a = { harness: 'claude', instance: 'local', sessionId: randomUUID() },
    b = { ...a, sessionId: randomUUID() },
    token = randomUUID() + randomUUID();
  const rows: SessionInfo[] = [a, b].map((address, i) => ({
    address,
    status: 'idle',
    metadata: { pid: 300 + i },
    capabilities: {
      send: ['peer_message'],
      history: true,
      liveEvents: false,
      reply: 'native_callback',
    },
  }));
  class Native extends TestAdapter {
    override harness = 'claude';
    override async listSessions() {
      return { data: structuredClone(rows), nextCursor: null };
    }
    override async getSession(address: SessionAddress) {
      const row = rows.find((r) => r.address.sessionId === address.sessionId);
      if (!row) throw Error('Session missing');
      return structuredClone(row);
    }
  }
  const adapter = new Native(),
    hub = new AgentHub([adapter, ...extra], {
      callers: [
        {
          id: 'agents',
          grants: [adapter, ...extra].map(({ harness, instance }) => ({
            harness,
            instance,
            operations: ['read', 'send'],
          })),
        },
      ],
    });
  t.after(() => hub.close());
  const processes = new Map<number, ProcessIdentity>();
  for (const [pid, ppid] of [
    [100, 200],
    [200, 300],
    [300, 1],
    [101, 201],
    [201, 301],
    [301, 1],
  ])
    processes.set(pid!, { pid: pid!, ppid: ppid!, uid: process.getuid!(), start: 'start-' + pid });
  const inspect = async (pid: number) => {
    const p = processes.get(pid);
    if (!p) throw Error('Process missing');
    return { ...p };
  };
  const profile: ConnectorProfile = {
    id: 'cli',
    harness: 'claude',
    instance: 'local',
    callerId: 'agents',
    enrollmentToken: token,
    transport: 'cli',
  };
  const service = new ConnectorService(hub, [profile], { inspect });
  const ea = { pid: 100, startupSessionId: a.sessionId, transport: 'cli' as const },
    eb = { pid: 101, startupSessionId: b.sessionId, transport: 'cli' as const };
  const dir = await mkdtemp('/tmp/ah-cli-test-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'token'), token, { mode: 0o600 });
  const path = join(dir, 'client.json');
  await writeFile(
    path,
    JSON.stringify({
      url: 'http://127.0.0.1:3211',
      harness: 'claude',
      enrollmentTokenFile: 'token',
    }),
    { mode: 0o600 },
  );
  return { a, b, token, rows, processes, profile, adapter, hub, service, ea, eb, path, inspect };
}

test('CLI enrollment independently checks bounded ancestry, native UUID and every process start', async (t) => {
  const f = await fixture(t),
    c = await f.service.enroll(f.token, f.ea);
  assert.deepEqual(c.binding.address, f.a);
  await assert.rejects(
    f.service.enroll(f.token, { ...f.ea, startupSessionId: f.b.sessionId }),
    /identity|session/i,
  );
  f.processes.get(200)!.start = 'reused';
  await assert.rejects(
    f.service.call(c.token, f.ea, { operation: 'identity' }),
    /process|identity/i,
  );
  f.processes.get(200)!.ppid = 200;
  await assert.rejects(f.service.enroll(f.token, f.ea), /ancestor|identity/i);
  f.processes.get(200)!.ppid = 300;
  f.processes.get(200)!.uid++;
  await assert.rejects(f.service.enroll(f.token, f.ea), /owner|identity/i);
  const mcpOnly = new ConnectorService(f.hub, [{ ...f.profile, transport: 'mcp' }], {
    inspect: f.inspect,
  });
  await assert.rejects(mcpOnly.enroll(f.token, f.ea), /transport/i);
});

test('owner CLI activation requires a correlated native child call and never trusts a text reply', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  const pending = await f.service.connect(input, 3211);
  assert.equal(pending.exitCode, 2);
  assert.equal(pending.activationScope, 'session');
  assert.equal(f.adapter.calls.length, 1);
  const activationId = pending.activationId!;
  assert.equal(f.adapter.calls[0]!.messageId, activationId);
  assert(!f.adapter.calls[0]!.text.includes(f.token));
  f.adapter.emit('update', {
    messageId: activationId,
    status: 'replied',
    reply: { text: 'Activation complete' },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.hub.receipt(activationId).status, 'replied');
  await f.service.connect(input, 3211);
  assert.equal(f.adapter.calls.length, 1);
  const wrong = await f.service.enroll(f.token, f.eb);
  await assert.rejects(
    f.service.call(wrong.token, f.eb, { operation: 'activate', activationId }),
    /activation|target/i,
  );
  assert.equal((await f.service.connect(input, 3211)).exitCode, 2);
  const c = await f.service.enroll(f.token, f.ea);
  await f.service.call(c.token, f.ea, { operation: 'activate', activationId });
  const ready = await f.service.connect(input, 3211);
  assert.equal(ready.exitCode, 0);
  assert.equal(ready.capabilities.toolsConnected, false);
  assert.equal(ready.capabilities.cliVerified, true);
  const activationState = f.hub.featureState('connector-cli-activation');
  const legacy = activationState.get('registry')!;
  legacy.version = 1;
  for (const record of Object.values(legacy.records as Record<string, Record<string, unknown>>))
    delete record.submission;
  activationState.set('registry', legacy);
  const reopened = new ConnectorService(f.hub, [f.profile], { inspect: f.inspect });
  assert.equal((await reopened.connect(input, 3211)).exitCode, 0);
  assert.equal(activationState.get('registry')!.version, 2);
  assert.equal(f.adapter.calls.length, 1);
  f.processes.get(300)!.start = 'new-host';
  assert.equal((await f.service.connect(input, 3211)).exitCode, 2);
  assert.equal(f.adapter.calls.length, 2);
});

test('CLI activation expiry, revocation and corrupt state never produce readiness or a resend', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  const pending = await f.service.connect(input, 3211),
    c = await f.service.enroll(f.token, f.ea);
  const state = f.hub.featureState('connector-cli-activation');
  const registry = state.get('registry')!;
  const records = registry.records as Record<string, { expires: number }>;
  Object.values(records)[0]!.expires = Date.now() - 1;
  state.set('registry', registry);
  await assert.rejects(
    f.service.call(c.token, f.ea, { operation: 'activate', activationId: pending.activationId }),
    /expired/,
  );
  const expired = await f.service.connect(input, 3211);
  assert.equal(expired.exitCode, 2);
  assert.match(expired.nextAction!, /expired/);
  assert.equal(f.adapter.calls.length, 1);
  const renewed = await f.service.connect({ ...input, retryActivation: true }, 3211);
  assert.notEqual(renewed.activationId, pending.activationId);
  assert.equal(f.adapter.calls.length, 2);
  await assert.rejects(f.service.connect({ ...input, retryActivation: true }, 3211), /deadline/);
  const revoked = new ConnectorService(f.hub, [{ ...f.profile, epoch: 1 }], { inspect: f.inspect });
  await assert.rejects(revoked.call(c.token, f.ea, { operation: 'identity' }), /revoked/);
  state.set('registry', { version: 99, records: {} });
  assert.throws(
    () => new ConnectorService(f.hub, [f.profile], { inspect: f.inspect }),
    /activation registry/,
  );
});

test('agent CLI entrypoint uses inferred identity and exposes only the restricted operations', async (t) => {
  const f = await fixture(t),
    app = createHubServer({ hub: f.hub, token: testToken, connectors: f.service });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  await writeFile(
    f.path,
    JSON.stringify({ url: `http://127.0.0.1:${address.port}`, enrollmentTokenFile: 'token' }),
    { mode: 0o600 },
  );
  const pending = await f.service.connect(
    { address: f.a, clientProfilePath: f.path },
    address.port,
  );
  const run = async (args: string[]) => {
    const child = spawn(
      process.execPath,
      [
        new URL('../src/cli.js', import.meta.url).pathname,
        'agent',
        '--connector-profile',
        f.path,
        ...args,
      ],
      {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: f.a.sessionId },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    f.processes.set(child.pid!, {
      pid: child.pid!,
      ppid: 200,
      uid: process.getuid!(),
      start: 'child-' + child.pid,
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  };
  const activation = await run(['activate', '--activation-id', pending.activationId!]);
  assert.equal(activation.code, 0, activation.stderr);
  assert.equal(JSON.parse(activation.stdout).transport, 'cli');
  const commands = JSON.parse(activation.stdout).commands;
  assert.match(commands.ask_agent, /--message='/);
  assert.match(commands.reply_agent, /--message='/);
  const peers = await run(['list-peers']);
  assert.equal(peers.code, 0, peers.stderr);
  assert.equal(JSON.parse(peers.stdout).peers.length, 2);
  const ask = await run(['ask', '--to', '@claude/' + f.b.sessionId, '--message', 'Review']);
  assert.equal(ask.code, 0, ask.stderr);
  const request = JSON.parse(ask.stdout).request;
  assert.deepEqual(f.adapter.calls.at(-1)!.origin.session, f.a);
  const denied = await run(['reply', '--request', request, '--message', 'Spoof']);
  assert.equal(denied.code, 1);
  assert.match(denied.stderr, /request_not_found/);
  const bullet = await run(['ask', '--to', '@claude/' + f.a.sessionId, '--message=- fixed X']);
  assert.equal(bullet.code, 0, bullet.stderr);
  assert.equal(f.adapter.calls.at(-1)!.text, '- fixed X');
  const answer = await run([
    'reply',
    '--request',
    JSON.parse(bullet.stdout).request,
    '--message=- reviewed X',
  ]);
  assert.equal(answer.code, 0, answer.stderr);
  assert.equal(f.adapter.calls.at(-1)!.text, '- reviewed X');
  const invalid = await run(['approve']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Expected agent/);
});

test('large unrelated instances report discovery gaps without blocking Claude aliases or activation', async (t) => {
  const extra = new TestAdapter();
  extra.harness = 'codex';
  let pages = 0;
  extra.listSessions = async (_q: PageQuery = {}) => ({
    data: Array.from({ length: 100 }, () => ({
      address: { harness: 'codex', instance: 'local', sessionId: randomUUID() },
      status: 'notLoaded',
      capabilities: { send: [], history: true, liveEvents: false },
    })),
    nextCursor: String(++pages),
  });
  const f = await fixture(t, [extra]),
    input = { address: f.a, clientProfilePath: f.path };
  const pending = await f.service.connect(input, 3211),
    c = await f.service.enroll(f.token, f.ea);
  const listing = (await f.service.call(c.token, f.ea, { operation: 'list_peers' })) as {
    peers: unknown[];
    gaps: unknown[];
  };
  assert.equal(listing.peers.length, 2);
  assert.deepEqual(listing.gaps, [
    { harness: 'codex', instance: 'local', code: 'discovery_limit' },
  ]);
  assert.equal(pages, 10);
  const ask = {
    operation: 'ask',
    messageId: randomUUID(),
    to: '@claude/' + f.b.sessionId,
    message: 'Task',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await f.service.call(c.token, f.ea, ask);
  await f.service.call(c.token, f.ea, {
    operation: 'activate',
    activationId: pending.activationId,
  });
  assert.equal((await f.service.connect(input, 3211)).exitCode, 0);
  assert.equal(pages, 10, 'Claude operations never query the unrelated instance');
  await assert.rejects(
    f.service.call(c.token, f.ea, { ...ask, to: '@codex/worker' }),
    /discovery incomplete/,
  );
  assert.equal(f.adapter.calls.length, 2);
});

test('an unavailable same-harness instance prevents ambiguous alias resolution but not canonical delivery', async (t) => {
  const extra = new TestAdapter();
  extra.harness = 'claude';
  extra.instance = 'offline';
  extra.listSessions = async () => {
    throw Error('offline');
  };
  const f = await fixture(t, [extra]),
    c = await f.service.enroll(f.token, f.ea);
  const request = {
    operation: 'ask',
    messageId: randomUUID(),
    to: '@claude/' + f.b.sessionId,
    message: 'Task',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await assert.rejects(f.service.call(c.token, f.ea, request), /discovery incomplete/);
  await f.service.call(c.token, f.ea, { ...request, to: f.b });
  assert.equal(f.adapter.calls.length, 1);
});

test('CLI identity shares one native snapshot per phase and still rechecks before sending', async (t) => {
  const f = await fixture(t),
    list = f.adapter.listSessions.bind(f.adapter);
  let calls = 0;
  f.adapter.listSessions = async () => {
    calls++;
    return list();
  };
  const c = await f.service.enroll(f.token, f.ea);
  const request = {
    operation: 'ask',
    messageId: randomUUID(),
    to: f.b,
    message: 'Task',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await f.service.call(c.token, f.ea, request);
  assert.equal(calls, 3, 'one enrollment snapshot and two fresh authorization snapshots');
  calls = 0;
  f.adapter.listSessions = async () => {
    if (++calls === 2) f.rows[0]!.address.sessionId = randomUUID();
    return list();
  };
  await assert.rejects(
    f.service.call(c.token, f.ea, { ...request, messageId: randomUUID() }),
    /Session changed/,
  );
  assert.equal(f.adapter.calls.length, 1, 'identity changed between phases, no new submission');
});

test('activation exposes definite failures, permits explicit retry, and retains uncertain intents', async (t) => {
  for (const status of ['failed', 'rejected', 'unknown'] as const)
    await t.test(status, async (t) => {
      const f = await fixture(t),
        input = { address: f.a, clientProfilePath: f.path, waitMs: 1000 };
      f.adapter.send = async (e) => {
        f.adapter.calls.push(e);
        return { status };
      };
      const first = await f.service.connect({ ...input, waitMs: 0 }, 3211);
      const reopened = new ConnectorService(f.hub, [f.profile], { inspect: f.inspect });
      const second = await reopened.connect({ ...input, waitMs: 0 }, 3211);
      assert.equal(second.activationId, first.activationId);
      assert.equal(second.activationStatus, status);
      assert.equal(f.adapter.calls.length, 1);
      if (status === 'unknown') {
        assert.equal(second.phase, 'awaiting_identity');
        await assert.rejects(
          reopened.connect({ ...input, retryActivation: true }, 3211),
          /deadline/,
        );
      } else {
        assert.equal(second.phase, 'activation_failed');
        assert.match(second.nextAction!, /--retry-activation/);
        const retried = await reopened.connect({ ...input, retryActivation: true }, 3211);
        assert.notEqual(retried.activationId, first.activationId);
        assert.equal(retried.phase, 'activation_failed');
        assert.equal(f.adapter.calls.length, 2);
      }
    });
});

test('activation exceptions remain visible on subsequent connect', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  f.hub.send = async () => {
    throw new HubError('forbidden', 'Policy denied', 403);
  };
  const failure = await f.service.connect(input, 3211);
  assert.equal(failure.phase, 'activation_failed');
  assert.equal(failure.activationError?.code, 'forbidden');
  assert.equal((await f.service.connect(input, 3211)).phase, 'activation_failed');
  f.hub.send = async () => {
    throw Error('transport interrupted');
  };
  assert.equal(
    (await f.service.connect({ ...input, retryActivation: true }, 3211)).activationStatus,
    'unknown',
  );
  await assert.rejects(f.service.connect({ ...input, retryActivation: true }, 3211), /deadline/);
});

test('activation collection frees expired records and retains replay protection across restart', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  await f.service.connect(input, 3211);
  const state = f.hub.featureState('connector-cli-activation'),
    registry = state.get('registry')!;
  const records = registry.records as Record<string, { expires: number; id: string }>;
  const template = Object.values(records)[0]!;
  template.expires = Date.now() - 1;
  for (let i = 1; i < 256; i++) records['old-' + i] = { ...template, id: randomUUID() };
  state.set('registry', registry);
  await f.service.connect({ ...input, address: f.b }, 3211);
  const collected = state.get('registry')!;
  assert.equal(
    Object.keys(collected.records as object).length,
    256,
    'only one expired record is collected',
  );
  assert.equal(String(collected.retired).length, 131072);
  const reopened = new ConnectorService(f.hub, [f.profile], { inspect: f.inspect });
  await assert.rejects(reopened.connect(input, 3211), /--retry-activation/);
  assert.equal(f.adapter.calls.length, 2);
  await reopened.connect({ ...input, retryActivation: true }, 3211);
  assert.equal(f.adapter.calls.length, 3);
  await reopened.connect(input, 3211);
  assert.equal(f.adapter.calls.length, 3);
  const saturated = state.get('registry')!;
  saturated.retired = 'ff'.repeat(65536);
  state.set('registry', saturated);
  f.processes.get(300)!.start = 'new-host';
  await assert.rejects(reopened.connect(input, 3211), /--retry-activation/);
  assert.equal(f.adapter.calls.length, 3, 'even a saturated filter never silently replays');
  await reopened.connect({ ...input, retryActivation: true }, 3211);
  assert.equal(f.adapter.calls.length, 4);
});

test('activation collection prioritizes unverified records and preserves live verified readiness', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  const activation = await f.service.connect(input, 3211),
    c = await f.service.enroll(f.token, f.ea);
  await f.service.call(c.token, f.ea, {
    operation: 'activate',
    activationId: activation.activationId,
  });
  const state = f.hub.featureState('connector-cli-activation'),
    registry = state.get('registry')!;
  const records = registry.records as Record<
    string,
    { id: string; expires: number; verifiedAt?: string }
  >;
  const key = Object.keys(records)[0]!,
    original = records[key]!;
  original.expires = Date.now() - 10000;
  for (let i = 1; i < 256; i++) records['old-' + i] = { ...original, id: randomUUID() };
  delete records['old-255']!.verifiedAt;
  records['old-255']!.expires = Date.now() - 1;
  state.set('registry', registry);
  await f.service.connect({ ...input, address: f.b }, 3211);
  const after = state.get('registry')!.records as typeof records;
  assert.equal(Object.keys(after).length, 256);
  assert.equal(after['old-255'], undefined, 'unverified expiration is preferred even when newer');
  assert.equal(after[key]?.id, activation.activationId);
  assert.equal((await f.service.connect(input, 3211)).phase, 'ready');
  assert.equal(f.adapter.calls.length, 2, 'verified reconnect does not wake the model');
});

test('retry replaces its own record at capacity without collecting other verified activations', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  await f.service.connect(input, 3211);
  const state = f.hub.featureState('connector-cli-activation'),
    registry = state.get('registry')!;
  const records = registry.records as Record<
    string,
    { id: string; expires: number; verifiedAt?: string }
  >;
  const key = Object.keys(records)[0]!,
    original = records[key]!;
  original.expires = Date.now() - 1;
  for (let i = 1; i < 256; i++)
    records['verified-' + i] = {
      ...original,
      id: randomUUID(),
      verifiedAt: new Date().toISOString(),
    };
  state.set('registry', registry);
  const retry = await f.service.connect({ ...input, retryActivation: true }, 3211);
  const after = state.get('registry')!.records as typeof records;
  assert.equal(Object.keys(after).length, 256);
  assert.notEqual(retry.activationId, original.id);
  assert.equal(after['verified-1']?.id, records['verified-1']!.id);
  assert.equal(state.get('registry')!.retired, undefined, 'replacement needs no collection');
});

test('later failed receipts stop activation waiting and nonexpired records retain the capacity bound', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  const initial = await f.service.connect(input, 3211);
  f.adapter.emit('update', {
    messageId: initial.activationId!,
    status: 'failed',
    error: { code: 'refused', message: 'Native delivery refused' },
  });
  const failure = await f.service.connect(input, 3211);
  assert.equal(failure.phase, 'activation_failed');
  assert.equal(failure.activationError?.code, 'refused');
  const state = f.hub.featureState('connector-cli-activation'),
    registry = state.get('registry')!;
  const records = registry.records as Record<string, { id: string }>;
  const template = Object.values(records)[0]!;
  for (let i = 1; i < 256; i++) records['pending-' + i] = { ...template, id: randomUUID() };
  state.set('registry', registry);
  await assert.rejects(f.service.connect({ ...input, address: f.b }, 3211), /capacity/);
  assert.equal(f.adapter.calls.length, 1);
});

test('CLI sources refresh without lifecycle hooks and cannot move a pending activation across clear', async (t) => {
  const f = await fixture(t),
    pending = await f.service.connect({ address: f.a, clientProfilePath: f.path }, 3211);
  const c = await f.service.enroll(f.token, f.ea);
  const fresh = randomUUID();
  f.rows[0]!.address = { ...f.a, sessionId: fresh };
  await assert.rejects(
    f.service.call(c.token, f.ea, { operation: 'identity' }),
    /identity|session/i,
  );
  const evidence = { ...f.ea, startupSessionId: fresh },
    next = await f.service.enroll(f.token, evidence);
  await assert.rejects(
    f.service.call(next.token, evidence, {
      operation: 'activate',
      activationId: pending.activationId,
    }),
    /activation|target/i,
  );
  const request = randomUUID();
  await f.service.call(next.token, evidence, {
    operation: 'ask',
    messageId: request,
    to: f.b,
    message: 'Task',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(f.adapter.calls.at(-1)!.origin.session!.sessionId, fresh);
});

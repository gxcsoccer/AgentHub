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
import type { SessionAddress, SessionInfo } from '../src/types.js';
import type { ConnectorProfile, ProcessIdentity } from '../src/connectors/types.js';

async function fixture(t: test.TestContext) {
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
    hub = new AgentHub([adapter], {
      callers: [
        {
          id: 'agents',
          grants: [{ harness: 'claude', instance: 'local', operations: ['read', 'send'] }],
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
  const reopened = new ConnectorService(f.hub, [f.profile], { inspect: f.inspect });
  assert.equal((await reopened.connect(input, 3211)).exitCode, 0);
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
  const invalid = await run(['approve']);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Expected agent/);
});

test('failed peer discovery cannot commit CLI activation readiness', async (t) => {
  const f = await fixture(t),
    input = { address: f.a, clientProfilePath: f.path };
  const pending = await f.service.connect(input, 3211),
    c = await f.service.enroll(f.token, f.ea);
  const list = f.adapter.listSessions.bind(f.adapter);
  let calls = 0;
  f.adapter.listSessions = async () => {
    if (++calls === 3) throw Error('Discovery unavailable');
    return list();
  };
  await assert.rejects(
    f.service.call(c.token, f.ea, { operation: 'activate', activationId: pending.activationId }),
    /Discovery unavailable/,
  );
  assert.equal((await f.service.connect(input, 3211)).exitCode, 2);
  f.adapter.listSessions = list;
  await f.service.call(c.token, f.ea, {
    operation: 'activate',
    activationId: pending.activationId,
  });
  assert.equal((await f.service.connect(input, 3211)).exitCode, 0);
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

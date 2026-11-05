import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createHubServer } from '../src/server.js';
import { AgentHubClient } from '../src/client.js';
import { AgentHub } from '../src/hub.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { ConnectorService } from '../src/connectors/service.js';
import { FakeRpc, testToken } from './helpers.js';
import type { SessionInfo } from '../src/types.js';

async function fixture(t: test.TestContext, scoped = false) {
  const a = randomUUID(),
    b = randomUUID(),
    connectionId = randomUUID(),
    rpc = new FakeRpc();
  let active: string[] = [a, b];
  let nonce: string = connectionId;
  let child = false;
  rpc.handlers.set('thread/loaded/list', () => ({ data: active, nextCursor: null }));
  rpc.handlers.set('thread/list', () => ({
    data: active.map((id) => ({ id, status: { type: 'idle' }, canAcceptDirectInput: true })),
    nextCursor: null,
  }));
  rpc.handlers.set('thread/read', (p) => ({
    thread: {
      id: p.threadId,
      status: { type: 'idle' },
      canAcceptDirectInput: !child,
      parentThreadId: child ? 'parent' : null,
    },
  }));
  rpc.handlers.set('mcpServerStatus/list', () => ({
    data: [
      {
        name: 'agenthub',
        runtimeStatus: 'connected',
        serverInfo: { name: 'agenthub-connector', version: '0.1.0+' + nonce },
        tools: Object.fromEntries(
          ['list_peers', 'ask_agent', 'reply_agent'].map((name) => [name, { name }]),
        ),
      },
    ],
    nextCursor: null,
  }));
  rpc.handlers.set('turn/start', () => ({ turn: { id: randomUUID() } }));
  const adapter = new CodexAdapter({ rpc }),
    hub = new AgentHub([adapter], {
      callers: [
        {
          id: 'agents',
          grants: [
            {
              harness: 'codex',
              instance: 'local',
              operations: ['read', 'send'],
              ...(scoped ? { sessions: [a] } : {}),
            },
          ],
        },
      ],
    });
  t.after(() => hub.close());
  const token = 'codex-enrollment-'.repeat(3);
  const service = new ConnectorService(
    hub,
    [
      {
        id: 'codex',
        harness: 'codex',
        instance: 'local',
        callerId: 'agents',
        enrollmentToken: token,
      },
    ],
    {
      inspect: async (pid) => ({
        pid,
        ppid: pid === 201 ? 301 : 201,
        uid: process.getuid!(),
        start: 'start-' + pid,
      }),
    },
  );
  const evidence = (threadId = a) => ({
    harness: 'codex' as const,
    pid: 101,
    threadId,
    sessionId: threadId,
    connectionId,
  });
  return {
    a,
    b,
    rpc,
    hub,
    service,
    adapter,
    token,
    evidence,
    setActive: (ids: string[]) => (active = ids),
    setNonce: (id: string) => (nonce = id),
    setChild: () => (child = true),
  };
}
test('Codex peer discovery pages loaded roots independently of historical threads and resolves aliases', async (t) => {
  const f = await fixture(t),
    child = randomUUID(),
    unloaded = randomUUID();
  const history = Array.from({ length: 1100 }, () => randomUUID());
  f.rpc.handlers.set('thread/list', (p) => {
    const offset = Number(p.cursor ?? 0),
      end = offset + Number(p.limit ?? 100);
    return {
      data: history.slice(offset, end).map((id) => ({ id, status: { type: 'notLoaded' } })),
      nextCursor: end < history.length ? String(end) : null,
    };
  });
  f.rpc.handlers.set('thread/loaded/list', (p) =>
    p.cursor
      ? { data: [f.b, unloaded], nextCursor: null }
      : { data: [f.a, child], nextCursor: 'second' },
  );
  f.rpc.handlers.set('thread/read', (p) => ({
    thread: {
      id: p.threadId,
      name: p.threadId === f.b ? 'reviewer' : 'source',
      status: { type: p.threadId === unloaded ? 'notLoaded' : 'idle' },
      canAcceptDirectInput: p.threadId !== child,
      parentThreadId: p.threadId === child ? f.a : null,
    },
  }));
  const c = await f.service.enroll(f.token, f.evidence());
  const listing = (await f.service.call(c.token, f.evidence(), { operation: 'list_peers' })) as {
    peers: SessionInfo[];
    gaps: unknown[];
  };
  assert.deepEqual(
    listing.peers.map((s) => s.address.sessionId),
    [f.a, f.b],
  );
  assert.deepEqual(listing.gaps, []);
  await f.service.call(c.token, f.evidence(), {
    operation: 'ask',
    messageId: randomUUID(),
    to: '@codex/reviewer',
    message: 'Review',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(f.rpc.calls.filter((c) => c.method === 'turn/start').length, 1);
  assert(!f.rpc.calls.some((c) => c.method === 'thread/list'), 'collaboration never scans history');
  const historical = await f.hub.listSessions(
    { harness: 'codex', instance: 'local' },
    { limit: 2 },
    'agents',
  );
  assert.equal(historical.data.length, 2);
  assert(
    historical.data.every((s) => s.status === 'notLoaded'),
    'normal history listing remains unchanged',
  );
  assert(
    !f.rpc.calls.some((c) =>
      ['thread/resume', 'thread/start', 'config/mcpServer/reload'].includes(c.method),
    ),
  );
});

test('Codex peer discovery retains session allowlists without reading unauthorized metadata', async (t) => {
  const f = await fixture(t, true),
    c = await f.service.enroll(f.token, f.evidence());
  f.rpc.calls.length = 0;
  const listing = (await f.service.call(c.token, f.evidence(), { operation: 'list_peers' })) as {
    peers: SessionInfo[];
  };
  assert.deepEqual(
    listing.peers.map((s) => s.address.sessionId),
    [f.a],
  );
  assert(
    f.rpc.calls.filter((c) => c.method === 'thread/read').every((c) => c.params.threadId === f.a),
  );
  assert(!f.rpc.calls.some((c) => c.method === 'thread/list'));
});
test('Codex binds per-call metadata to the exact native MCP connection and rechecks each operation', async (t) => {
  const f = await fixture(t),
    enrolled = await f.service.enroll(f.token, f.evidence());
  assert.equal(enrolled.binding.address.sessionId, f.a);
  const listing = (await f.service.call(enrolled.token, f.evidence(), {
    operation: 'list_peers',
  })) as { peers: SessionInfo[] };
  assert.equal(
    listing.peers.find((s) => s.address.sessionId === f.a)?.replyReadiness?.state,
    'ready',
  );
  assert.equal(
    listing.peers.find((s) => s.address.sessionId === f.b)?.replyReadiness?.state,
    'unknown',
  );
  const second = (await f.service.call(enrolled.token, f.evidence(f.b), {
    operation: 'identity',
  })) as { binding: { address: { sessionId: string } } };
  assert.equal(second.binding.address.sessionId, f.b);
  await assert.rejects(
    f.service.call(enrolled.token, { ...f.evidence(), sessionId: f.b }, { operation: 'identity' }),
    /identity|metadata/,
  );
  f.setNonce(randomUUID());
  await assert.rejects(
    f.service.call(enrolled.token, f.evidence(), { operation: 'identity' }),
    /connection/,
  );
  f.setNonce(f.evidence().connectionId);
  f.setActive([]);
  await assert.rejects(
    f.service.call(enrolled.token, f.evidence(), { operation: 'identity' }),
    /loaded/,
  );
  f.setActive([f.a]);
  f.setChild();
  await assert.rejects(
    f.service.call(enrolled.token, f.evidence(), { operation: 'identity' }),
    /root/,
  );
  assert(
    !f.rpc.calls.some((c) =>
      ['thread/resume', 'thread/start', 'config/mcpServer/reload'].includes(c.method),
    ),
  );
});
test('MCP-connected Codex replies without a dynamic reply tool or resume attachment', async (t) => {
  const f = await fixture(t),
    c = await f.service.enroll(f.token, f.evidence());
  const request = randomUUID();
  await f.service.call(c.token, f.evidence(), {
    operation: 'ask',
    messageId: request,
    to: { harness: 'codex', instance: 'local', sessionId: f.b },
    message: 'Review',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  const payload = JSON.parse(
    (f.rpc.calls.find((c) => c.method === 'turn/start')!.params.toolOutput as { output: string })
      .output,
  );
  assert.equal(payload.reply.preferredTool, 'reply_agent');
  await f.service.call(c.token, f.evidence(f.b), { operation: 'reply', request, message: 'Done' });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.hub.receipt(request).status, 'replied');
  assert.equal(f.rpc.calls.filter((c) => c.method === 'turn/start').length, 2);
  assert(!f.rpc.calls.some((c) => c.method === 'thread/resume'));
});

test('Codex target readiness tries all distinct enabled profile servers', async (t) => {
  const f = await fixture(t),
    names: string[] = [],
    original = f.adapter.connectorSession.bind(f.adapter);
  f.adapter.connectorSession = async (address, name, nonce) => {
    if (address.sessionId === f.b) names.push(name);
    return original(address, name, nonce);
  };
  const service = new ConnectorService(
    f.hub,
    [
      {
        id: 'disabled',
        harness: 'codex',
        instance: 'local',
        callerId: 'agents',
        enrollmentToken: 'disabled-'.repeat(8),
        enabled: false,
        mcpServerName: 'disabled',
      },
      {
        id: 'absent',
        harness: 'codex',
        instance: 'local',
        callerId: 'agents',
        enrollmentToken: 'absent-'.repeat(8),
        mcpServerName: 'absent',
      },
      {
        id: 'duplicate',
        harness: 'codex',
        instance: 'local',
        callerId: 'agents',
        enrollmentToken: 'duplicate-'.repeat(8),
        mcpServerName: 'absent',
      },
      {
        id: 'codex',
        harness: 'codex',
        instance: 'local',
        callerId: 'agents',
        enrollmentToken: f.token,
      },
    ],
    {
      inspect: async (pid) => ({
        pid,
        ppid: pid === 201 ? 301 : 201,
        uid: process.getuid!(),
        start: 'start-' + pid,
      }),
    },
  );
  const c = await service.enroll(f.token, f.evidence());
  await service.call(c.token, f.evidence(), {
    operation: 'ask',
    messageId: randomUUID(),
    to: { harness: 'codex', instance: 'local', sessionId: f.b },
    message: 'Review',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  assert.deepEqual(names, ['absent', 'agenthub']);
  assert.equal(f.rpc.calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('pending Codex installations coalesce reloads, including uncertain reload outcomes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t),
    address = { harness: 'codex', instance: 'local', sessionId: f.a },
    config = { command: '/node', args: ['/cli', 'mcp'] };
  f.rpc.handlers.set('config/read', () => ({
    config: { mcp_servers: { agenthub: config } },
    layers: [
      {
        name: { type: 'user', file: '/private/config.toml' },
        version: 'v1',
        config: { mcp_servers: { agenthub: config } },
      },
    ],
  }));
  f.rpc.handlers.set('mcpServerStatus/list', () => ({ data: [], nextCursor: null }));
  let reloads = 0;
  f.rpc.handlers.set('config/mcpServer/reload', () => {
    reloads++;
    return {};
  });
  const first = await Promise.all([
    f.adapter.installConnector(address, 'agenthub', config),
    f.adapter.installConnector(address, 'agenthub', config),
  ]);
  assert.deepEqual(
    first.map((x) => x.reloaded),
    [true, false],
  );
  assert.equal(reloads, 1);
  assert.equal((await f.adapter.installConnector(address, 'agenthub', config)).reloaded, false);
  t.mock.timers.tick(30000);
  f.rpc.handlers.set('config/mcpServer/reload', () => {
    reloads++;
    throw Error('Lost reload response');
  });
  await assert.rejects(
    f.adapter.installConnector(address, 'agenthub', config),
    /Lost reload response/,
  );
  assert.equal((await f.adapter.installConnector(address, 'agenthub', config)).reloaded, false);
  assert.equal(reloads, 2);
});

test('Codex installation uses versioned native config writes, preserves conflicts and skips a ready reinstall', async (t) => {
  const f = await fixture(t),
    address = { harness: 'codex', instance: 'local', sessionId: f.a },
    config = { command: '/node', args: ['/cli', 'mcp'] };
  let stored: unknown;
  f.rpc.handlers.set('config/read', () => ({
    config: { mcp_servers: stored ? { agenthub: stored } : {} },
    layers: [
      {
        name: { type: 'user', file: '/private/config.toml' },
        version: 'v1',
        config: { mcp_servers: stored ? { agenthub: stored } : {} },
      },
    ],
  }));
  f.rpc.handlers.set('config/value/write', (p) => {
    assert.equal(p.expectedVersion, 'v1');
    assert.equal(p.mergeStrategy, 'replace');
    stored = p.value;
    return { status: 'ok', version: 'v2' };
  });
  f.rpc.handlers.set('config/mcpServer/reload', () => ({}));
  assert.deepEqual(await f.adapter.installConnector(address, 'agenthub', config), {
    changed: true,
    activationScope: 'instance',
    reloaded: true,
  });
  assert.equal(f.rpc.calls.filter((c) => c.method === 'config/mcpServer/reload').length, 1);
  assert.equal((await f.adapter.installConnector(address, 'agenthub', config)).reloaded, false);
  await assert.rejects(
    f.adapter.installConnector(address, 'agenthub', { ...config, command: '/other' }),
    /conflict|differs/,
  );
  assert.equal(f.rpc.calls.filter((c) => c.method === 'config/value/write').length, 1);
  stored = undefined;
  f.rpc.handlers.set('config/value/write', () => {
    throw Error('Concurrent config edit');
  });
  await assert.rejects(f.adapter.installConnector(address, 'agenthub', config), /Concurrent/);
  assert.equal(f.rpc.calls.filter((c) => c.method === 'config/mcpServer/reload').length, 1);
});

test('official MCP transport keeps concurrent Codex call identities separate and ignores inherited IDs', async (t) => {
  const f = await fixture(t),
    app = createHubServer({ hub: f.hub, token: testToken, connectors: f.service });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const addr = app.server.address();
  assert(addr && typeof addr !== 'string');
  const baseUrl = 'http://127.0.0.1:' + addr.port;
  const dir = await mkdtemp('/tmp/ah-codex-mcp-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'token'), f.token, { mode: 0o600 });
  const profile = join(dir, 'client.json');
  await writeFile(
    profile,
    JSON.stringify({ url: baseUrl, harness: 'codex', enrollmentTokenFile: 'token' }),
    { mode: 0o600 },
  );
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        new URL('../src/cli.js', import.meta.url).pathname,
        'mcp',
        '--connector-profile',
        profile,
      ],
      env: {
        ...(process.env as Record<string, string>),
        CODEX_THREAD_ID: randomUUID(),
        CLAUDE_CODE_SESSION_ID: randomUUID(),
      },
    }),
  );
  f.setNonce(client.getServerVersion()!.version.slice(6));
  assert((await client.callTool({ name: 'list_peers', arguments: {} })).isError);
  const responses = await Promise.all(
    [f.a, f.b].map((id, i) =>
      client.callTool({
        name: 'ask_agent',
        arguments: {
          to: { harness: 'codex', instance: 'local', sessionId: i ? f.a : f.b },
          message: 'TASK_' + i,
        },
        _meta: { threadId: id, sessionId: id },
      }),
    ),
  );
  assert(
    responses.every((r) => !r.isError),
    JSON.stringify(responses),
  );
  const messages = f.rpc.calls
    .filter((c) => c.method === 'turn/start')
    .map((c) => JSON.parse((c.params.toolOutput as { output: string }).output).message);
  assert.deepEqual(messages.map((m) => m.origin.session.sessionId).sort(), [f.a, f.b].sort());
  assert(messages.every((m) => m.origin.session.sessionId === m.replyTo.sessionId));
  assert.equal(
    (await new AgentHubClient({ baseUrl, token: testToken }).connections()).bindings.length,
    2,
  );
});

test('owner connect validates profiles and requires current native identity, not historical bindings', async (t) => {
  const f = await fixture(t),
    dir = await mkdtemp('/tmp/ah-codex-onboarding-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'token'), f.token, { mode: 0o600 });
  const profile = join(dir, 'client.json'),
    address = { harness: 'codex', instance: 'local', sessionId: f.a };
  await writeFile(
    profile,
    JSON.stringify({
      url: 'http://127.0.0.1:3211',
      harness: 'codex',
      enrollmentTokenFile: 'token',
    }),
    { mode: 0o600 },
  );
  let config: unknown;
  f.rpc.handlers.set('config/read', () => ({
    config: { mcp_servers: config ? { agenthub: config } : {} },
    layers: [
      {
        name: { type: 'user', file: '/private/config.toml' },
        version: 'v1',
        config: { mcp_servers: config ? { agenthub: config } : {} },
      },
    ],
  }));
  f.rpc.handlers.set('config/value/write', (p) => {
    config = p.value;
    return { status: 'ok' };
  });
  f.rpc.handlers.set('config/mcpServer/reload', () => ({}));
  await assert.rejects(
    f.service.connect({ address, clientProfilePath: profile }, 9999),
    /this local Hub/,
  );
  f.rpc.handlers.set('mcpServer/tool/call', () => ({ isError: true }));
  const pending = await f.service.connect({ address, clientProfilePath: profile }, 3211);
  assert.equal(pending.phase, 'awaiting_identity');
  assert.equal(pending.exitCode, 2);
  f.rpc.handlers.set('mcpServer/tool/call', async (p) => {
    assert.equal(p.tool, 'list_peers');
    assert.equal(p.threadId, f.a);
    assert.deepEqual(p.arguments, {});
    await f.service.enroll(f.token, { ...f.evidence(), sessionId: undefined });
    return { isError: false };
  });
  const ready = await f.service.connect({ address, clientProfilePath: profile }, 3211);
  assert.equal(ready.exitCode, 0);
  assert.equal(ready.verificationMethod, 'native_mcp_readonly_call');
  f.rpc.handlers.set('mcpServer/tool/call', () => ({ isError: false }));
  f.setNonce(randomUUID());
  const renewed = await f.service.connect({ address, clientProfilePath: profile }, 3211);
  assert.equal(renewed.exitCode, 2, 'historical binding must not prove a new MCP connection');
  assert.equal(f.rpc.calls.filter((c) => c.method === 'config/value/write').length, 1);
  await assert.rejects(
    f.service.connect({ address, clientProfilePath: profile, waitMs: 60001 }, 3211),
    /parameters/,
  );
});

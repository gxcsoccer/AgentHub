import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AgentHub } from '../src/hub.js';
import { AgentHubClient, HubApiError } from '../src/client.js';
import { ConnectorClient } from '../src/connectors/client.js';
import { ConnectorService } from '../src/connectors/service.js';
import { loadConnectorProfiles, loadConnectorClientProfile } from '../src/connectors/config.js';
import { createHubServer } from '../src/server.js';
import { TestAdapter, testToken } from './helpers.js';
import type { SessionAddress } from '../src/types.js';
const token = 'connector-enrollment-'.repeat(3),
  restricted = 'restricted-http-'.repeat(3);
const cli = new URL('../src/cli.js', import.meta.url).pathname;
const exec = promisify(execFile);
async function setup(t: test.TestContext) {
  const a = { harness: 'claude', instance: 'local', sessionId: randomUUID() },
    b = { ...a, sessionId: randomUUID() };
  class Native extends TestAdapter {
    override harness = 'claude';
    override async listSessions() {
      return { data: [await this.getSession(a), await this.getSession(b)], nextCursor: null };
    }
    override async getSession(address: SessionAddress) {
      return {
        address,
        name: address.sessionId === a.sessionId ? 'worker' : 'reviewer',
        status: 'idle',
        capabilities: {
          send: ['peer_message' as const],
          history: true,
          liveEvents: false,
          reply: 'native_callback' as const,
        },
        metadata: { pid: address.sessionId === a.sessionId ? 20001 : 20002 },
      };
    }
  }
  const adapter = new Native();
  const hub = new AgentHub([adapter], {
    callers: [
      {
        id: 'agents',
        grants: [{ harness: 'claude', instance: 'local', operations: ['read', 'send'] }],
      },
    ],
  });
  const profiles = [
    {
      id: 'test',
      callerId: 'agents',
      harness: 'claude' as const,
      instance: 'local',
      enrollmentToken: token,
    },
  ];
  const service = new ConnectorService(hub, profiles, {
    inspect: async (pid) => ({
      pid,
      ppid: pid === 20001 || pid === 20002 ? 30001 : pid === 10002 ? 20002 : 20001,
      uid: process.getuid!(),
      start: 'start-' + pid,
    }),
  });
  const app = createHubServer({
    hub,
    token: testToken,
    callers: [{ id: 'agents', token: restricted }],
    connectors: service,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { a, b, hub, adapter, service, baseUrl, profiles };
}

test('connector HTTP credentials cannot access owner APIs and owner token cannot enroll', async (t) => {
  const f = await setup(t),
    ea = { pid: 10001, startupSessionId: f.a.sessionId };
  assert.throws(() => f.service.assertCredentialSeparation([token]), /must differ/);
  const enrollment = new AgentHubClient({ baseUrl: f.baseUrl, token }),
    c = await enrollment.enrollConnector(ea),
    business = new AgentHubClient({ baseUrl: f.baseUrl, token: c.token });
  await assert.rejects(enrollment.instances(), /token|Unauthorized/i);
  await assert.rejects(business.instances(), /token|Unauthorized/i);
  const owner = new AgentHubClient({ baseUrl: f.baseUrl, token: testToken });
  await assert.rejects(owner.enrollConnector(ea), /credential/);
  assert.equal((await owner.connections()).bindings.length, 1);
  await assert.rejects(owner.connectSession(f.a), /automatic activation/);
  await assert.rejects(
    new AgentHubClient({ baseUrl: f.baseUrl, token: restricted }).connectSession(f.a),
    /owner/,
  );
  assert.equal(f.adapter.calls.length, 0);
  await assert.rejects(
    new AgentHubClient({ baseUrl: f.baseUrl, token: restricted }).connections(),
    /owner/,
  );
  await assert.rejects(
    business.connectorCall(ea, { operation: 'reply', request: randomUUID(), message: 'bad' }),
    /request/,
  );
  const bad = await fetch(f.baseUrl + '/v1/connector/call', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ evidence: ea, operation: { operation: 'identity' }, extra: 1 }),
  });
  assert.equal(bad.status, 400);
  const origin = await fetch(f.baseUrl + '/v1/connector/enroll', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(ea),
  });
  assert.equal(origin.status, 403);
  const missing = await fetch(f.baseUrl + '/v1/connector/enroll', { method: 'POST' });
  assert.equal(missing.status, 401);
  await enrollment.connectorHook({ pid: 10003, event: 'SessionStart', sessionId: f.a.sessionId });
});

test('bound MCP CLI exposes exactly three tools and executes ask/reply through HTTP', async (t) => {
  const f = await setup(t),
    dir = await mkdtemp('/tmp/ah-connector-test-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'enrollment'), token, { mode: 0o600 });
  const profile = join(dir, 'profile.json');
  await writeFile(profile, JSON.stringify({ url: f.baseUrl, enrollmentTokenFile: 'enrollment' }), {
    mode: 0o600,
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--connector-profile', profile],
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_CODE_SESSION_ID: f.a.sessionId,
      AGENTHUB_TOKEN_FILE: join(dir, 'MUST_NOT_READ_OWNER'),
    },
  });
  const mcp = new Client({ name: 'test', version: '1' });
  t.after(() => mcp.close());
  await mcp.connect(transport);
  // Bound by the helper itself: no tool has been called yet.
  for (let i = 0; i < 200 && !(await f.service.connections()).bindings.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(
    (await f.service.connections()).bindings.map((b) => b.address),
    [f.a],
  );
  const tools = await mcp.listTools();
  assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
    'ask_agent',
    'list_peers',
    'reply_agent',
  ]);
  const listed = await mcp.callTool({ name: 'list_peers', arguments: {} });
  assert(!listed.isError);
  const invalid = await mcp.callTool({
    name: 'ask_agent',
    arguments: { to: f.b, message: 'work', origin: f.a },
  });
  assert(invalid.isError);
  assert.equal(f.adapter.calls.length, 0);
  const sent = await mcp.callTool({
    name: 'ask_agent',
    arguments: { to: '@claude/reviewer', message: 'work', deadlineSeconds: 60 },
  });
  assert(!sent.isError, JSON.stringify(sent));
  const envelope = f.adapter.calls[0]!;
  assert.deepEqual(envelope.origin.session, f.a);
  const recipient = new ConnectorClient({
    baseUrl: f.baseUrl,
    enrollmentToken: token,
    evidence: { pid: 10002, startupSessionId: f.b.sessionId },
  });
  await recipient.reply({ request: envelope.messageId, message: 'done' });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.adapter.calls[1]?.messageKind, 'result');
  const wrong = await mcp.callTool({
    name: 'reply_agent',
    arguments: { request: envelope.messageId, message: 'wrong' },
  });
  assert(wrong.isError);
  const info = JSON.parse(
    (
      await exec(process.execPath, [cli, 'connections', '--url', f.baseUrl], {
        env: { ...process.env, AGENTHUB_TOKEN: testToken },
      })
    ).stdout,
  );
  assert.equal(info.bindings.length, 2);
  const hook = await exec(process.execPath, [
    '--input-type=module',
    '-e',
    `import {spawn} from 'node:child_process';const c=spawn(process.execPath,${JSON.stringify([cli, 'connector-hook', '--connector-profile', profile])},{stdio:['pipe','inherit','inherit']});c.stdin.end(${JSON.stringify(JSON.stringify({ hook_event_name: 'SessionStart', session_id: f.a.sessionId }))});c.on('exit',code=>process.exitCode=code);`,
  ]);
  assert.equal(JSON.parse(hook.stdout).accepted, true);
});

test('connector profiles require private files, restrict configuration and resolve relative token paths', async (t) => {
  const dir = await mkdtemp('/tmp/ah-connector-config-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = join(dir, 'config.json');
  await writeFile(join(dir, 'token'), token, { mode: 0o600 });
  await writeFile(
    filename,
    JSON.stringify({
      profiles: [
        {
          id: 'local',
          callerId: 'agents',
          harness: 'claude',
          instance: 'local',
          enrollmentTokenFile: 'token',
        },
      ],
    }),
    { mode: 0o600 },
  );
  assert.equal((await loadConnectorProfiles(filename))[0]!.enrollmentToken, token);
  await writeFile(
    filename,
    JSON.stringify({ url: 'http://127.0.0.1:3211', enrollmentTokenFile: 'token' }),
  );
  assert.equal((await loadConnectorClientProfile(filename)).enrollmentToken, token);
  await chmod(filename, 0o644);
  await assert.rejects(loadConnectorClientProfile(filename), /private owner/);
  await chmod(filename, 0o600);
  await writeFile(
    filename,
    JSON.stringify({ url: 'https://example.com', enrollmentTokenFile: 'token', ownerToken: 'bad' }),
  );
  await assert.rejects(loadConnectorClientProfile(filename), /configuration/);
});

test('a credential removed by disconnect re-enrolls once on the next call', async () => {
  let enrollments = 0,
    calls = 0,
    removed = false;
  const fake: typeof fetch = async (url) => {
    if (String(url).endsWith('/enroll')) {
      enrollments++;
      removed = false;
      return Response.json({ token: 'business-'.repeat(8), binding: {} });
    }
    calls++;
    return removed
      ? Response.json(
          { error: { code: 'invalid_credential', message: 'Unknown connector credential' } },
          { status: 401 },
        )
      : Response.json({ ok: true });
  };
  const client = new ConnectorClient({
    baseUrl: 'http://localhost:3211',
    enrollmentToken: token,
    evidence: { pid: 10001, startupSessionId: randomUUID() },
    fetch: fake,
  });
  await client.identity();
  removed = true;
  await client.listPeers();
  assert.equal(enrollments, 2);
  assert.equal(calls, 3);
});

test('reply retries a Hub outage with the same text, and ask and refusals are not retried', async () => {
  const bodies: { operation: string; request?: string; message?: string }[] = [];
  let outage = 2;
  let refusal: Response | undefined;
  const fake: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/enroll'))
      return Response.json({ token: 'business-'.repeat(8), binding: {} });
    bodies.push(JSON.parse(String(init?.body)).operation);
    if (outage > 0) {
      outage--;
      throw new TypeError('fetch failed');
    }
    if (refusal) return refusal;
    return Response.json({ request: 'r', accepted: true, duplicate: bodies.length > 3 });
  };
  const options = {
    baseUrl: 'http://localhost:3211',
    enrollmentToken: token,
    evidence: { pid: 10001, startupSessionId: randomUUID() },
    fetch: fake,
  };
  const client = new ConnectorClient({ ...options, replyRetryMs: 5000 });
  const request = randomUUID();
  await client.reply({ request, message: 'answer' });
  assert.equal(bodies.length, 3);
  assert(bodies.every((b) => b.request === request && b.message === 'answer'));
  bodies.length = 0;
  refusal = Response.json(
    { error: { code: 'reply_conflict', message: 'different' } },
    { status: 409 },
  );
  await assert.rejects(client.reply({ request, message: 'other' }), /different/);
  assert.equal(bodies.length, 1);
  bodies.length = 0;
  refusal = undefined;
  outage = 100;
  const short = new ConnectorClient({ ...options, replyRetryMs: 300 });
  await assert.rejects(
    short.reply({ request, message: 'answer' }),
    (e: unknown) =>
      e instanceof Error &&
      (e as { code?: string }).code === 'connector_request_failed' &&
      e.message.includes(request) &&
      e.message.includes('identical text'),
  );
  assert(bodies.length >= 2);
  bodies.length = 0;
  await assert.rejects(short.ask({ to: '@claude/reviewer', message: 'work' }));
  assert.equal(bodies.length, 1);
});

test('connector client coalesces enrollment and never automatically retries a failed write', async () => {
  let enrollments = 0,
    calls = 0,
    fail = false;
  const e = { pid: 10001, startupSessionId: randomUUID() };
  const fake: typeof fetch = async (_url, init) => {
    const url = String(_url);
    if (url.endsWith('/enroll')) {
      enrollments++;
      return Response.json({ token: 'business-'.repeat(8), binding: {} });
    }
    calls++;
    if (fail)
      return Response.json(
        { error: { code: 'credential_revoked', message: 'revoked' } },
        { status: 401 },
      );
    return Response.json({ ok: true, operation: JSON.parse(String(init?.body)).operation });
  };
  const client = new ConnectorClient({
    baseUrl: 'http://localhost:3211',
    enrollmentToken: token,
    evidence: e,
    fetch: fake,
  });
  await Promise.all([client.listPeers(), client.identity()]);
  assert.equal(enrollments, 1);
  assert.equal(calls, 2);
  fail = true;
  await assert.rejects(client.ask({ to: '@claude/reviewer', message: 'work' }), /revoked/);
  await assert.rejects(
    client.ask({ to: '@claude/reviewer', message: 'work' }),
    (e: unknown) =>
      e instanceof Error &&
      e.message.includes('not submitted') &&
      !e.message.includes('do not submit it again'),
  );
  assert.equal(calls, 4);
  assert.equal(enrollments, 2);
  fail = false;
  await client.identity();
  assert.equal(enrollments, 3);
  assert.throws(
    () => client.ask({ to: '@claude/reviewer', message: 'work', deadlineSeconds: 14401 }),
    /deadline/,
  );
  await assert.rejects(
    new ConnectorClient({
      baseUrl: 'http://localhost:3211',
      enrollmentToken: token,
      evidence: { ...e, startupSessionId: '' },
      fetch: fake,
    }).identity(),
    /startup/,
  );
});

test('HTTP credential expiry renews once and submits the exact original request only once', async (t) => {
  const f = await setup(t),
    operations: unknown[] = [];
  let enrollments = 0;
  const client = new ConnectorClient({
    baseUrl: f.baseUrl,
    enrollmentToken: token,
    evidence: { pid: 10001, startupSessionId: f.a.sessionId },
    fetch: async (url, init) => {
      if (String(url).endsWith('/enroll')) enrollments++;
      if (String(url).endsWith('/call')) operations.push(JSON.parse(String(init?.body)).operation);
      return fetch(url, init);
    },
  });
  await client.identity();
  const state = f.hub.featureState('connectors'),
    registry = state.get('registry')!;
  for (const c of Object.values(registry.credentials as Record<string, { expires: number }>))
    c.expires = Date.now() - 1;
  state.set('registry', registry);
  await client.ask({ to: f.b, message: 'Review once' });
  assert.equal(enrollments, 2);
  assert.deepEqual(
    operations[1],
    operations[2],
    'ID, payload and deadline survive refresh unchanged',
  );
  assert.equal(f.adapter.calls.length, 1);
});

test('credential refresh is bounded, coalesced and never retries uncertain delivery', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let enrollments = 0,
    calls = 0,
    mode = 'ok';
  const client = new ConnectorClient({
    baseUrl: 'http://localhost:3211',
    enrollmentToken: token,
    evidence: { pid: 10001, startupSessionId: randomUUID() },
    fetch: async (url, init) => {
      if (String(url).endsWith('/enroll')) {
        enrollments++;
        return Response.json({
          token: 'business-' + enrollments,
          expiresAt: new Date(Date.now() + 1000).toISOString(),
          binding: {},
        });
      }
      calls++;
      if (mode === 'unknown') throw Error('Connection reset after dispatch');
      if (mode === 'expired')
        return Response.json(
          { error: { code: 'credential_expired', message: 'Expired before dispatch' } },
          { status: 401 },
        );
      return Response.json(JSON.parse(String(init?.body)).operation);
    },
  });
  await client.identity();
  t.mock.timers.tick(1001);
  await Promise.all([client.identity(), client.listPeers()]);
  assert.equal(enrollments, 2, 'expired cached credential proactively renewed once');
  assert.equal(calls, 3, 'no expired business call attempted');
  mode = 'expired';
  await assert.rejects(client.ask({ to: '@claude/reviewer', message: 'Task' }), /not submitted/);
  assert.equal(enrollments, 3);
  assert.equal(calls, 5, 'at most one retry');
  mode = 'unknown';
  await assert.rejects(
    client.ask({ to: '@claude/reviewer', message: 'Task' }),
    /do not submit it again/,
  );
  assert.equal(calls, 6, 'network uncertainty is never replayed');
});

test('a credential expiring in flight survives unrelated registry writes long enough for one safe refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await setup(t),
    evidence = { pid: 10001, startupSessionId: f.a.sessionId },
    operations: unknown[] = [];
  let crossExpiry = false,
    enrollments = 0;
  const client = new ConnectorClient({
    baseUrl: f.baseUrl,
    enrollmentToken: token,
    evidence,
    fetch: async (url, init) => {
      if (String(url).endsWith('/enroll')) enrollments++;
      if (String(url).endsWith('/call')) {
        operations.push(JSON.parse(String(init?.body)).operation);
        if (crossExpiry) {
          crossExpiry = false;
          t.mock.timers.tick(2);
          await f.service.enroll(token, { pid: 10002, startupSessionId: f.b.sessionId });
        }
      }
      return fetch(url, init);
    },
  });
  await client.identity();
  t.mock.timers.tick(86400000 - 1);
  crossExpiry = true;
  await client.ask({ to: f.b, message: 'Review once' });
  assert.equal(enrollments, 2);
  assert.deepEqual(operations[1], operations[2]);
  assert.equal(f.adapter.calls.length, 1);
});

test('serve CLI loads connector profiles with restricted access and rejects credential reuse', async (t) => {
  const dir = await mkdtemp('/tmp/ah-connector-serve-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({
    'hub.json': JSON.stringify({ claude: false, codex: false }),
    'access.json': JSON.stringify({
      callers: [
        {
          id: 'agents',
          tokenFile: 'api.token',
          grants: [{ harness: 'claude', instance: 'local', operations: ['read', 'send'] }],
        },
      ],
    }),
    'profiles.json': JSON.stringify({
      profiles: [
        {
          id: 'test',
          harness: 'claude',
          instance: 'local',
          callerId: 'agents',
          enrollmentTokenFile: 'enrollment.token',
        },
      ],
    }),
    'api.token': restricted,
    'enrollment.token': token,
  }))
    await writeFile(join(dir, name), value, { mode: 0o600 });
  const args = [
    cli,
    'serve',
    '--config',
    join(dir, 'hub.json'),
    '--access-file',
    join(dir, 'access.json'),
    '--connector-file',
    join(dir, 'profiles.json'),
    '--ephemeral',
    '--port',
    '0',
  ];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, AGENTHUB_TOKEN: testToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGTERM');
      await exit;
    }
  });
  const line = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(Error('serve startup timeout')), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('\n')) {
        clearTimeout(timer);
        resolve(output.split('\n')[0]!);
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(Error('early serve exit'));
    });
  });
  const baseUrl = JSON.parse(line).url as string;
  const client = new AgentHubClient({ baseUrl, token: testToken });
  assert.equal((await client.connections()).bindings.length, 0);
  await assert.rejects(
    new AgentHubClient({ baseUrl, token }).enrollConnector({
      pid: process.pid,
      startupSessionId: randomUUID(),
    }),
    (error: unknown) => error instanceof HubApiError && error.code === 'adapter_not_found',
  );
  await writeFile(join(dir, 'enrollment.token'), testToken);
  await assert.rejects(
    exec(process.execPath, args, {
      env: { ...process.env, AGENTHUB_TOKEN: testToken },
      timeout: 10000,
    }),
    /must differ/,
  );
});

test('startup binding waits out the Hub and native directory, then stops', async () => {
  const startup = (fake: typeof fetch, extra = {}) =>
    new ConnectorClient({
      baseUrl: 'http://localhost:3211',
      enrollmentToken: token,
      evidence: { pid: 10001, startupSessionId: randomUUID() },
      fetch: fake,
      startupRetryMs: 1,
      ...extra,
    });
  const refused = (code: string, status: number) =>
    Response.json({ error: { code, message: code } }, { status });
  let attempts = 0;
  const outcomes: (() => Response)[] = [
    () => {
      throw new TypeError('fetch failed');
    },
    () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    },
    () => refused('storage_failed', 503),
    () => refused('identity_pending', 409),
    () => Response.json({ token: 'business-'.repeat(8), binding: {} }),
  ];
  const recovering = startup(async () => outcomes[attempts++]!());
  assert.equal(await recovering.bindAtStartup(), undefined);
  assert.equal(attempts, 5);

  // A bound helper reuses the credential: the first tool call doesn't enroll again.
  const calls: string[] = [];
  const reused = startup(async (url) => {
    calls.push(String(url));
    return String(url).endsWith('/enroll')
      ? Response.json({ token: 'business-'.repeat(8), binding: {} })
      : Response.json({ ok: true });
  });
  await reused.bindAtStartup();
  await reused.listPeers();
  assert.equal(calls.filter((url) => url.endsWith('/enroll')).length, 1);

  for (const [code, status] of [
    ['connector_disconnected', 403],
    ['invalid_credential', 401],
    ['identity_unavailable', 409],
    ['connector_capacity', 429],
  ] as const) {
    let tries = 0;
    const final = startup(async () => {
      tries++;
      return refused(code, status);
    });
    assert.equal(await final.bindAtStartup(), code);
    assert.equal(tries, 1, code);
  }

  let pending = 0;
  const bounded = startup(
    async () => {
      pending++;
      return refused('identity_pending', 409);
    },
    { startupIdentityMs: 40 },
  );
  assert.equal(await bounded.bindAtStartup(), 'identity_pending');
  assert(pending > 1);

  // None of these can enroll without per-call metadata or a live handshake.
  const untouched: typeof fetch = async () => assert.fail('must not enroll');
  assert.equal(await startup(untouched, { harness: 'codex' }).bindAtStartup(), undefined);
  assert.equal(await startup(untouched, { transport: 'cli' }).bindAtStartup(), undefined);
  assert.equal(
    await startup(untouched, {
      evidence: { pid: 10001, startupSessionId: '' },
    }).bindAtStartup(),
    undefined,
  );
});

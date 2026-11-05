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
  assert.equal(calls, 3);
  assert.equal(enrollments, 1);
  fail = false;
  await client.identity();
  assert.equal(enrollments, 2);
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

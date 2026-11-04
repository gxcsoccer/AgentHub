import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentHubClient } from '../src/client.js';
import { TestAdapter, httpFixture, testAddress, testToken } from './helpers.js';
import type { SessionInfo } from '../src/types.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;
const exec = promisify(execFile);
function fixture(
  options: {
    instances?: { harness: string; instance: string }[];
    info?: SessionInfo;
    fail?: string;
  } = {},
) {
  const calls: { path: string; method: string }[] = [];
  const client = new AgentHubClient({
    baseUrl: 'http://localhost',
    token: 'PRIVATE_TOKEN',
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: String(init?.method) });
      assert.equal(init?.method, 'GET');
      if (path === options.fail)
        return Response.json(
          {
            error: {
              code: 'backend_timeout',
              message: 'SECRET_PATH PRIVATE_TOKEN PRIVATE_HISTORY',
            },
          },
          { status: 503 },
        );
      if (path === '/v1/instances')
        return Response.json({
          data: options.instances ?? [{ harness: 'codex', instance: 'local' }],
          eventCursor: 'unused',
        });
      if (path === '/v1/sessions')
        return Response.json({ data: [options.info ?? codex()], nextCursor: 'another-page' });
      if (path === '/v1/session') return Response.json(options.info ?? codex());
      throw Error('Unexpected ' + path);
    },
  });
  return { client, calls };
}
const target = { harness: 'codex', instance: 'local', sessionId: 'test-session' };
function codex(state: NonNullable<SessionInfo['replyReadiness']>['state'] = 'ready'): SessionInfo {
  return {
    address: target,
    status: 'idle',
    name: 'PRIVATE_NAME',
    cwd: '/PRIVATE_PATH',
    capabilities: {
      send: ['tool_output'],
      reply: 'registered_tool',
      history: true,
      liveEvents: false,
    },
    replyReadiness: {
      state,
      tool: 'present',
      listener: state === 'ready' ? 'attached' : 'detached',
      reason: 'PRIVATE_REASON',
    },
    metadata: { secret: 'PRIVATE_METADATA' },
  };
}

test('doctor uses bounded read-only discovery and does not infer target readiness or print private session fields', async () => {
  const { client, calls } = fixture();
  const report = await client.doctor();
  assert.equal(report.status, 'ok');
  assert.equal(report.deliveryTested, false);
  assert.deepEqual(
    calls.map((x) => x.path),
    ['/v1/instances', '/v1/sessions'],
  );
  assert.equal(report.checks.find((x) => x.id === 'discovery')?.details?.hasMore, true);
  assert(!JSON.stringify(report).includes('PRIVATE'));
  assert(!report.checks.some((x) => x.id === 'send' || x.id === 'reply'));
});

test('target diagnosis keeps send capability separate from missing or detached reply readiness', async () => {
  for (const state of [
    'ready',
    'needs_attach',
    'missing_tool',
    'unknown',
    'unavailable',
  ] as const) {
    const { client, calls } = fixture({ info: codex(state) });
    const report = await client.doctor({ scope: target, sessionId: target.sessionId });
    assert.equal(report.checks.find((x) => x.id === 'reply')?.code, `reply_${state}`);
    assert.equal(
      report.checks.find((x) => x.id === 'send')?.status,
      state === 'unavailable' ? 'error' : 'ok',
    );
    assert.equal(
      report.status,
      state === 'ready' ? 'ok' : state === 'unavailable' ? 'error' : 'warning',
    );
    assert.deepEqual(
      calls.map((x) => x.path),
      ['/v1/instances', '/v1/session'],
    );
  }
});

test('Claude diagnosis identifies opt-out, unvalidated version and missing inbox without claiming process version verification', async () => {
  const scope = { harness: 'claude', instance: 'local' };
  const info: SessionInfo = {
    address: { ...scope, sessionId: 'test' },
    status: 'idle',
    capabilities: {
      send: ['peer_message'],
      reply: 'native_callback',
      history: true,
      liveEvents: false,
    },
    metadata: {
      nativeMessagingEnabled: true,
      cliVersion: '2.1.318',
      validatedCliVersion: '2.1.318',
      processVersionVerified: false,
      socketAvailable: true,
    },
  };
  for (const [metadata, expected] of [
    [{ nativeMessagingEnabled: false }, 'native_messaging_disabled'],
    [{ cliVersion: 'unvalidated' }, 'unsupported_version'],
    [{ installedCliVersion: 'unvalidated' }, 'unsupported_version'],
    [
      { cliVersion: 'unvalidated', validatedCliVersions: ['2.1.317', '2.1.318'] },
      'unsupported_version',
    ],
    [
      {
        cliVersion: '2.1.317',
        validatedCliVersions: ['2.1.317', '2.1.318'],
        socketAvailable: false,
      },
      'socket_unavailable',
    ],
    [{ socketAvailable: false }, 'socket_unavailable'],
  ] as const) {
    const { client } = fixture({
      instances: [scope],
      info: {
        ...info,
        capabilities: { ...info.capabilities, send: [] },
        metadata: { ...info.metadata, ...metadata },
      },
    });
    const report = await client.doctor({ scope, sessionId: 'test' });
    assert.equal(report.checks.find((x) => x.id === 'send')?.code, expected);
  }
  const report = await fixture({ instances: [scope], info }).client.doctor({
    scope,
    sessionId: 'test',
  });
  assert.equal(report.checks.find((x) => x.id === 'reply')?.code, 'callback_supported');
  assert.equal(report.checks.find((x) => x.id === 'send')?.details?.processVersionVerified, false);
  assert.equal(report.checks.find((x) => x.id === 'send')?.details?.installedCliVersion, '2.1.318');
});

test('doctor reports failed dependencies and unknown scopes without leaking backend error text or silently skipping other instances', async () => {
  const service = fixture({ fail: '/v1/instances' });
  const failed = await service.client.doctor();
  assert.equal(failed.status, 'error');
  assert.equal(service.calls.length, 1);
  assert(!JSON.stringify(failed).includes('PRIVATE'));
  const selected = fixture();
  assert.equal(
    (await selected.client.doctor({ scope: { harness: 'missing', instance: 'local' } })).status,
    'error',
  );
  assert.equal(selected.calls.length, 1);
  await assert.rejects(selected.client.doctor({ sessionId: 'missing-scope' }), /scope/);
  const partial = fixture({
    instances: [
      { harness: 'codex', instance: 'local' },
      { harness: 'claude', instance: 'local' },
    ],
    fail: '/v1/sessions',
  });
  const report = await partial.client.doctor();
  assert.equal(report.checks.filter((x) => x.id === 'discovery').length, 2);
  assert.equal(report.status, 'error');
  assert.equal((await fixture({ instances: [] }).client.doctor()).status, 'warning');
});

test('doctor CLI returns JSON and distinct exit codes while leaving the adapter untouched', async (t) => {
  const adapter = new TestAdapter(),
    { baseUrl, app } = await httpFixture(t, adapter),
    methods: string[] = [];
  app.server.on('request', (req) => methods.push(req.method!));
  const args = [cli, 'doctor', '--url', baseUrl],
    env = { ...process.env, AGENTHUB_TOKEN: testToken };
  const normal = await exec(process.execPath, args, { env });
  assert.equal(JSON.parse(normal.stdout).status, 'ok');
  const target = await exec(
    process.execPath,
    [...args, '--harness', 'test', '--session-id', testAddress.sessionId],
    { env },
  ).catch((e) => e);
  assert.equal(target.code, 2);
  assert.equal(JSON.parse(target.stdout).status, 'warning');
  const denied = await exec(process.execPath, args, {
    env: { ...env, AGENTHUB_TOKEN: 'incorrect' },
  }).catch((e) => e);
  assert.equal(denied.code, 1);
  assert.equal(JSON.parse(denied.stdout).checks[0].code, 'unauthorized');
  const invalid = await exec(process.execPath, [...args, '--timeout-ms', '0'], { env }).catch(
    (e) => e,
  );
  assert.equal(invalid.code, 1);
  assert(methods.every((x) => x === 'GET'));
  assert.equal(adapter.calls.length, 0);
});

test('a bounded client request aborts a hanging read and doctor never retries it', async (t) => {
  // Keep the event loop alive while AbortSignal.timeout uses an unref timer.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let count = 0;
  const client = new AgentHubClient({
    baseUrl: 'http://localhost',
    token: 'test',
    timeoutMs: 15,
    fetch: async (_url, init) => {
      count++;
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
      );
    },
  });
  const report = await client.doctor();
  assert.equal(report.status, 'error');
  assert.equal(report.checks[0]?.code, 'timeout');
  assert.equal(count, 1);
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.1, 120001])
    assert.throws(
      () => new AgentHubClient({ baseUrl: 'http://localhost', token: 'test', timeoutMs }),
      /timeoutMs/,
    );
});

test('discovery limits instance count and concurrency, and one failed backend does not mask healthy ones', async () => {
  let active = 0,
    peak = 0,
    reads = 0;
  const client = new AgentHubClient({
    baseUrl: 'http://localhost',
    token: 'test',
    fetch: async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/v1/instances')
        return Response.json({
          data: Array.from({ length: 40 }, (_, i) => ({
            harness: 'test',
            instance: String(i),
            secret: 'PRIVATE',
          })),
        });
      reads++;
      active++;
      peak = Math.max(peak, active);
      assert.equal(parsed.searchParams.get('limit'), '10');
      await new Promise((r) => setImmediate(r));
      active--;
      return parsed.searchParams.get('instance') === '0'
        ? Response.json({ error: { code: 'unavailable', message: 'PRIVATE' } }, { status: 503 })
        : Response.json({ data: [], nextCursor: null });
    },
  });
  const result = await client.doctor();
  assert.equal(reads, 32);
  assert.equal(peak, 4);
  assert(result.checks.some((x) => x.code === 'instance_limit'));
  assert.equal(result.checks.filter((x) => x.code === 'no_sessions').length, 31);
  assert(!JSON.stringify(result).includes('PRIVATE'));
});

test('malformed read responses, generic delivery rejection and absent reply evidence remain explicit', async () => {
  for (const value of [{}, { data: [{}] }]) {
    const client = new AgentHubClient({
      baseUrl: 'http://localhost',
      token: 'test',
      fetch: async () => Response.json(value),
    });
    assert.equal((await client.doctor()).checks[0]?.code, 'invalid_response');
  }
  const client = new AgentHubClient({
    baseUrl: 'http://localhost',
    token: 'test',
    fetch: async (url) =>
      Response.json(
        new URL(String(url)).pathname === '/v1/instances'
          ? { data: [{ harness: 'codex', instance: 'local' }] }
          : {},
      ),
  });
  assert.equal((await client.doctor()).checks[1]?.code, 'invalid_response');
  assert.equal(
    (await client.doctor({ scope: target, sessionId: 'test' })).checks[1]?.code,
    'invalid_response',
  );
  const info = codex();
  delete info.replyReadiness;
  info.capabilities.send = [];
  delete info.capabilities.reply;
  const report = await fixture({ info }).client.doctor({ scope: target, sessionId: 'test' });
  assert.equal(report.checks.find((x) => x.id === 'send')?.code, 'send_unavailable');
  assert.equal(report.checks.find((x) => x.id === 'reply')?.code, 'reply_unverified');
  await assert.rejects(client.doctor({ scope: { harness: '', instance: 'local' } }), /scope/);
  await assert.rejects(client.doctor({ scope: target, sessionId: ' ' }), /nonempty/);
  for (const error of [
    new TypeError('PRIVATE'),
    new SyntaxError('PRIVATE'),
    new Error('PRIVATE'),
  ]) {
    const broken = new AgentHubClient({
      baseUrl: 'http://localhost',
      token: 'test',
      fetch: async () => {
        throw error;
      },
    });
    assert.equal((await broken.doctor()).status, 'error');
    assert(!JSON.stringify(await broken.doctor()).includes('PRIVATE'));
  }
});

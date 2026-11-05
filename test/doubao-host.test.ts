import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HubError } from '../src/validation.js';
import { configureDoubaoHost, setupDoubao, loadSetup, uninstallSetup } from '../src/setup.js';
import {
  openDoubaoHost,
  doubaoRequestExpression,
  type DoubaoConnector,
  type DoubaoHostApi,
} from '../src/doubao-host.js';
const exec = promisify(execFile);
const cli = new URL('../src/cli.js', import.meta.url).pathname;
class Host implements DoubaoHostApi {
  entries: DoubaoConnector[] = [];
  creates = 0;
  connects = 0;
  removes = 0;
  lostCreate = false;
  loseBeforeCreate = false;
  pretendRemove = false;
  listError: Error | undefined;
  createError: Error | undefined;
  connectError: Error | undefined;
  async list() {
    if (this.listError) throw this.listError;
    return structuredClone(this.entries);
  }
  async detail(id: string) {
    const entry = this.entries.find((e) => e.connector_id === id);
    if (!entry) throw new HubError('host_api_rejected', 'Missing connector');
    return structuredClone(entry);
  }
  async create(name: string, command: string) {
    this.creates++;
    if (this.createError) throw this.createError;
    if (this.loseBeforeCreate) throw Error('lost request');
    const entry = {
      connector_id: String(this.creates),
      name,
      enabled: true,
      mcp_config: { transport_type: 3, stdio_config: { command, params: [], env: {} } },
    };
    this.entries.push(entry);
    if (this.lostCreate) throw Error('lost response');
    return structuredClone(entry);
  }
  async connect() {
    this.connects++;
    if (this.connectError) throw this.connectError;
  }
  async enabled(id: string, enabled: boolean) {
    this.entries.find((e) => e.connector_id === id)!.enabled = enabled;
  }
  async remove(id: string) {
    this.removes++;
    if (!this.pretendRemove) this.entries = this.entries.filter((e) => e.connector_id !== id);
  }
  close() {}
}
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ah-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'setup');
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  await setupDoubao({
    directory,
    port,
    targets: [{ harness: 'claude', instance: 'local', sessionId: randomUUID() }],
  });
  const host = new Host();
  const run = (op: 'install' | 'remove' | 'disable' | 'enable') =>
    configureDoubaoHost(directory, op, 9224, async () => host);
  return { directory, host, run };
}
test('host lifecycle operates only on recorded matching configuration and verifies removal', async (t) => {
  const { directory, host, run } = await fixture(t);
  host.entries.push({ connector_id: '999', name: 'unrelated' });
  const installed = await run('install');
  assert.equal(installed.phase, 'installed');
  assert.equal(installed.hostLoadingVerified, false);
  await run('install');
  assert.equal(host.creates, 1);
  assert.equal(host.connects, 1);
  await run('disable');
  assert.equal(host.entries[1]!.enabled, false);
  await run('enable');
  assert.equal(host.entries[1]!.enabled, true);
  await assert.rejects(uninstallSetup(directory), /host-remove/);
  await run('remove');
  assert.equal((await loadSetup(directory)).doubaoHost?.phase, 'removed');
  assert.deepEqual(host.entries, [{ connector_id: '999', name: 'unrelated' }]);
  assert.equal((await run('remove')).changed, false);
  const manifest = await readFile(join(directory, 'setup.json'), 'utf8');
  assert(!manifest.includes('cookie'));
  assert(!manifest.includes('msToken'));
  const result = JSON.parse(
    (await exec(process.execPath, [cli, 'setup', 'uninstall', '--directory', directory])).stdout,
  );
  assert.equal(result.hostCleanupRequired, false);
  assert.equal(result.cleanup.doubao.status, 'removed');
  assert.equal(result.cleanup.doubao.connectorId, installed.connectorId);
  assert.equal(result.cleanup.nativeConnectors.status, 'unchecked');
  assert.equal(result.cleanup.nativeConnectors.checkRequired, true);
  assert(!result.nextAction.includes('host UI'));
  assert.deepEqual((await uninstallSetup(directory)).cleanup, result.cleanup);
});
test('lost create response recovers by unique name and exact configuration without another write', async (t) => {
  const { host, run } = await fixture(t);
  host.lostCreate = true;
  await assert.rejects(run('install'), /lost response/);
  assert.equal((await run('install')).phase, 'installed');
  assert.equal(host.creates, 1);
});
test('uncertain missing create is never retried or discarded during uninstall', async (t) => {
  const { directory, host, run } = await fixture(t);
  host.loseBeforeCreate = true;
  await assert.rejects(run('install'), /lost request/);
  await assert.rejects(run('install'), /no create is retried/);
  await assert.rejects(run('remove'), /outcome is unknown/);
  await assert.rejects(uninstallSetup(directory), /host-remove/);
  assert.equal(host.creates, 1);
});
test('user edits prevent host mutation; success flags alone do not remove state', async (t) => {
  const { directory, host, run } = await fixture(t);
  await run('install');
  host.entries[0]!.mcp_config!.stdio_config!.params = ['user edit'];
  await assert.rejects(run('remove'), /no longer matches/);
  assert.equal(host.removes, 0);
  host.entries[0]!.mcp_config!.stdio_config!.params = [];
  host.pretendRemove = true;
  await assert.rejects(run('remove'), /still lists/);
  assert.equal((await loadSetup(directory)).doubaoHost?.phase, 'installed');
  host.pretendRemove = false;
  await run('remove');
});
test('unattempted host registration can be removed offline or directly uninstalled', async (t) => {
  for (const action of ['remove', 'uninstall'] as const) {
    const { directory, host, run } = await fixture(t);
    host.listError = new HubError('unsupported_host_context', 'Unsupported version');
    await assert.rejects(run('install'), { code: 'unsupported_host_context' });
    assert.equal((await loadSetup(directory)).doubaoHost?.attempted, false);
    if (action === 'remove') {
      const removed = await configureDoubaoHost(directory, 'remove', 9224, async () => {
        throw Error('Must not connect to offline Doubao');
      });
      assert.equal(removed.phase, 'removed');
    }
    const result = await uninstallSetup(directory);
    assert.equal(result.uninstalled, true);
    assert.equal(result.hostCleanupRequired, false);
    assert.equal(result.cleanup.doubao.status, 'not_created');
    assert.equal((await loadSetup(directory)).doubaoHost?.phase, 'removed');
    assert.equal(host.creates, 0);
  }
});
for (const scenario of [
  'rejected-create',
  'lost-create-response',
  'deleted-after-connect-failure',
  'upgraded-host',
] as const) {
  test(`explicit offline forget unlocks uninstall for ${scenario} while retaining an accurate recovery record`, async (t) => {
    const { directory, host, run } = await fixture(t);
    if (scenario === 'rejected-create')
      host.createError = new HubError('host_api_rejected', 'Rejected create');
    else if (scenario === 'lost-create-response') host.lostCreate = true;
    else if (scenario === 'deleted-after-connect-failure')
      host.connectError = new HubError('doubao_not_connected', 'Failed connect');
    if (scenario === 'upgraded-host') await run('install');
    else await assert.rejects(run('install'));
    if (scenario === 'deleted-after-connect-failure') host.entries = [];
    if (scenario === 'upgraded-host')
      host.listError = new HubError('unsupported_host_context', 'Upgraded host');
    if (scenario !== 'lost-create-response') await assert.rejects(run('remove'));
    await assert.rejects(uninstallSetup(directory), { code: 'host_cleanup_required' });
    const record = (await loadSetup(directory)).doubaoHost!;
    const hostEntries = structuredClone(host.entries);
    const forget = (...args: string[]) =>
      exec(process.execPath, [cli, 'setup', 'host-forget', '--directory', directory, ...args]);
    await assert.rejects(forget(), /confirm-host-name/);
    await assert.rejects(
      forget('--confirm-host-name', 'agenthub-' + randomUUID()),
      /confirm-host-name/,
    );
    assert.deepEqual((await loadSetup(directory)).doubaoHost, record);
    const forgotten = JSON.parse((await forget('--confirm-host-name', record.name)).stdout);
    assert.equal(forgotten.phase, 'forgotten');
    assert.equal(forgotten.remoteCleanupVerified, false);
    assert.equal(forgotten.hostCleanupRequired, true);
    assert.equal((await loadSetup(directory)).doubaoHost?.connectorId, record.connectorId);
    assert.equal(
      JSON.parse((await forget('--confirm-host-name', record.name)).stdout).changed,
      false,
    );
    await assert.rejects(run('install'), { code: 'host_registration_forgotten' });
    assert.deepEqual(host.entries, hostEntries);
    const result = await uninstallSetup(directory);
    assert.equal(result.uninstalled, true);
    assert.equal(result.hostCleanupRequired, true);
    assert.equal(result.cleanup.doubao.status, 'forgotten');
    assert.equal(result.cleanup.doubao.name, record.name);
    assert.equal(result.cleanup.doubao.connectorId, record.connectorId);
    assert.match(result.nextAction, /Doubao/);
    assert.equal((await loadSetup(directory)).doubaoHost?.phase, 'forgotten');
    assert.equal(host.creates, 1);
  });
}
test('request expression reuses desktop metadata but never exports or copies authentication values', async () => {
  let called = 0;
  const environment = {
    URL,
    AbortSignal,
    performance: {
      getEntriesByType: () => [
        {
          name: 'https://www.doubao.com/alice/read?pc_version=2.35.15&device_id=123&msToken=secret&a_bogus=secret',
        },
      ],
    },
    fetch: async (url: URL, options: { credentials: string; body: string }) => {
      called++;
      assert.equal(url.origin, 'https://www.doubao.com');
      assert.equal(url.searchParams.get('device_id'), '123');
      assert(!url.searchParams.has('msToken'));
      assert(!url.searchParams.has('a_bogus'));
      assert.equal(options.credentials, 'include');
      assert.equal(JSON.parse(options.body).connector_id, '42');
      return { ok: true, json: async () => ({ code: 0, data: { enabled: false } }) };
    },
  };
  const result = await runInNewContext(
    doubaoRequestExpression('set_enabled', { connector_id: '42' }),
    environment,
  );
  assert.equal(result.data.enabled, false);
  assert.equal(called, 1);
  const unsupported = await runInNewContext(doubaoRequestExpression('connect', {}), {
    ...environment,
    performance: { getEntriesByType: () => [] },
  });
  assert.equal(unsupported.error, 'unsupported_host_context');
  assert.equal(called, 1);
});
test('real CDP socket routes all connector operations and rejects unexpected targets', async (t) => {
  let targetMode = 'valid';
  let port = 0;
  const paths: string[] = [];
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify([
        {
          type: 'page',
          url:
            targetMode === 'valid'
              ? 'doubaowork://doubaowork-chat/chat'
              : 'https://unrelated.example/',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/test`,
        },
      ]),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) =>
    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      const value = await runInNewContext(msg.params.expression, {
        URL,
        AbortSignal,
        performance: {
          getEntriesByType: () => [
            { name: 'https://www.doubao.com/alice/read?pc_version=2.35.15&device_id=test' },
          ],
        },
        fetch: async (url: URL) => {
          const path = url.pathname.split('/').at(-1)!;
          paths.push(path);
          const payload =
            path === 'list_by_user'
              ? { items: [], has_more: false }
              : path === 'create_personal' || path === 'get_detail'
                ? { connector: { connector_id: '123', name: 'test' } }
                : path === 'connect'
                  ? { connected: true }
                  : path === 'set_enabled'
                    ? { enabled: false }
                    : { disconnected: true };
          return { ok: true, json: async () => ({ code: 0, data: payload }) };
        },
      });
      ws.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
    }),
  );
  t.after(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as { port: number }).port;
  const api = await openDoubaoHost(port);
  try {
    assert.deepEqual(await api.list(), []);
    assert.equal((await api.create('test', 'command')).connector_id, '123');
    await api.detail('123');
    await api.connect('123');
    await api.enabled('123', false);
    await api.remove('123');
  } finally {
    api.close();
  }
  assert.deepEqual(paths, [
    'list_by_user',
    'create_personal',
    'get_detail',
    'connect',
    'set_enabled',
    'disconnect',
  ]);
  targetMode = 'other';
  await assert.rejects(openDoubaoHost(port), /native Doubao/);
  await assert.rejects(openDoubaoHost(0), /Invalid/);
});

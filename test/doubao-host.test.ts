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
import { configureDoubaoHost, setupDoubao, loadSetup, uninstallSetup } from '../src/setup.js';
import {
  openDoubaoHost,
  doubaoRequestExpression,
  type DoubaoConnector,
  type DoubaoHostApi,
} from '../src/doubao-host.js';
class Host implements DoubaoHostApi {
  entries: DoubaoConnector[] = [];
  creates = 0;
  connects = 0;
  removes = 0;
  lostCreate = false;
  loseBeforeCreate = false;
  pretendRemove = false;
  async list() {
    return structuredClone(this.entries);
  }
  async detail(id: string) {
    return structuredClone(this.entries.find((e) => e.connector_id === id)!);
  }
  async create(name: string, command: string) {
    this.creates++;
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
  await setupDoubao({
    directory,
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

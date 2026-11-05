import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  rm,
  stat,
  chmod,
  symlink,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  setupDoubao,
  loadSetup,
  setSetupEnabled,
  uninstallSetup,
  diagnoseSetup,
} from '../src/setup.js';
import { AgentHubClient } from '../src/client.js';
const exec = promisify(execFile);
const cli = new URL('../src/cli.js', import.meta.url).pathname;
const target = { harness: 'claude', instance: 'local', sessionId: randomUUID() };
async function folder(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ah-setup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'private config');
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}
async function start(t: test.TestContext, args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const ready = await new Promise<{ url: string }>((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(Error('Startup timed out: ' + stderr)), 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(Error('Startup exited: ' + stderr));
    });
    child.stdout.on('data', (b) => {
      data += b.toString();
      if (data.includes('\n')) {
        clearTimeout(timer);
        resolve(JSON.parse(data.split('\n')[0]!));
      }
    });
  });
  return { child, exited, ready };
}
test('packaged setup creates a private executable launcher, scoped targets and a managed manifest', async (t) => {
  const directory = await folder(t);
  const result = await setupDoubao({ directory, targets: [target], port: 3244 });
  assert.equal((await loadSetup(directory)).enabled, true);
  assert.equal((await stat(result.launcherPath)).mode & 0o777, 0o700);
  const owner = (await readFile(join(directory, 'owner.token'), 'utf8')).trim();
  assert(!JSON.stringify(result).includes(owner));
  assert(!(await readFile(result.launcherPath, 'utf8')).includes(owner));
  await assert.rejects(setupDoubao({ directory, targets: [target] }), { code: 'EEXIST' });
});
test('disable and enable persist across invocations; uninstall preserves state and unrelated files', async (t) => {
  const directory = await folder(t);
  await setupDoubao({ directory, targets: [target], port: await freePort() });
  await writeFile(join(directory, 'state.sqlite'), 'private historical state', { mode: 0o600 });
  await writeFile(join(directory, 'notes.txt'), 'keep this');
  assert.equal((await setSetupEnabled(directory, false)).enabled, false);
  assert.equal((await loadSetup(directory)).enabled, false);
  assert.equal((await setSetupEnabled(directory, true)).enabled, true);
  const result = await uninstallSetup(directory);
  assert.equal(result.uninstalled, true);
  assert.equal(result.hostCleanupRequired, true);
  assert.equal(result.cleanup.doubao.status, 'untracked');
  assert.deepEqual(result.cleanup.nativeConnectors, {
    status: 'unchecked',
    checkRequired: true,
    harnesses: ['claude'],
  });
  assert.equal(await readFile(join(directory, 'state.sqlite'), 'utf8'), 'private historical state');
  assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'keep this');
  await assert.rejects(readFile(join(directory, 'caller.token')), { code: 'ENOENT' });
  assert.deepEqual((await uninstallSetup(directory)).cleanup, result.cleanup);
  await assert.rejects(setSetupEnabled(directory, true), /uninstalled/i);
});
test('modified files and forged ownership manifests are refused without deleting user configuration', async (t) => {
  const directory = await folder(t);
  await setupDoubao({ directory, targets: [target] });
  await writeFile(join(directory, 'mcp.json'), 'user-edited config');
  await assert.rejects(uninstallSetup(directory), /modified/i);
  assert.equal(await readFile(join(directory, 'mcp.json'), 'utf8'), 'user-edited config');
  const manifest = JSON.parse(await readFile(join(directory, 'setup.json'), 'utf8'));
  manifest.files['../outside'] = '0'.repeat(64);
  await writeFile(join(directory, 'setup.json'), JSON.stringify(manifest));
  await assert.rejects(loadSetup(directory), /manifest/i);
});
test('unified CLI initialization selects an explicit target without reading default owner credentials', async (t) => {
  const directory = await folder(t);
  const r = await exec(
    process.execPath,
    [
      cli,
      'setup',
      'init',
      '--directory',
      directory,
      '--harness',
      'claude',
      '--session-id',
      target.sessionId,
      '--port',
      String(await freePort()),
    ],
    { env: { ...process.env, AGENTHUB_TOKEN_FILE: '/DO_NOT_READ' } },
  );
  const result = JSON.parse(r.stdout);
  assert.equal(result.started, false);
  const disabled = await exec(process.execPath, [
    cli,
    'setup',
    'disable',
    '--directory',
    directory,
  ]);
  assert.equal(JSON.parse(disabled.stdout).enabled, false);
  const doctor = await exec(process.execPath, [
    cli,
    'setup',
    'doctor',
    '--directory',
    directory,
  ]).catch((e) => e);
  assert.equal(JSON.parse(doctor.stdout).hostLoadingVerified, false);
  await assert.rejects(
    exec(process.execPath, [cli, 'setup', 'serve', '--directory', directory]),
    /disabled/i,
  );
});
test('managed Hub, generated MCP launcher, disable and restart exercise real process boundaries', async (t) => {
  const directory = await folder(t);
  const config = await setupDoubao({ directory, targets: [target], port: await freePort() });
  const { child, exited, ready } = await start(t, ['setup', 'serve', '--directory', directory]);
  const caller = (await readFile(join(directory, 'caller.token'), 'utf8')).trim();
  const api = new AgentHubClient({ baseUrl: ready.url, token: caller, timeoutMs: 1000 });
  assert.deepEqual(
    (await api.instances()).data.map((x) => x.harness),
    ['claude'],
  );
  await assert.rejects(
    exec(process.execPath, [cli, 'setup', 'serve', '--directory', directory]),
    /in use/,
  );
  const mcp = new Client({ name: 'setup-launcher-test', version: '1' });
  t.after(() => mcp.close());
  await mcp.connect(
    new StdioClientTransport({
      command: config.launcherPath,
      env: { AGENTHUB_TOKEN: 'wrong-inherited-owner' },
      stderr: 'pipe',
    }),
  );
  assert.equal((await mcp.listTools()).tools.length, 7);
  assert(!(await mcp.callTool({ name: 'list_instances', arguments: {} })).isError);
  await setSetupEnabled(directory, false);
  await exited;
  assert.equal(child.exitCode, 0);
  await assert.rejects(api.instances());
  assert((await mcp.callTool({ name: 'list_instances', arguments: {} })).isError);
  await mcp.close();
  await assert.rejects(exec(config.launcherPath), /disabled/);
  await setSetupEnabled(directory, true);
  await assert.rejects(api.instances()); // enable is not a daemon launcher
  const restarted = await start(t, ['setup', 'serve', '--directory', directory]);
  assert.equal((await api.instances()).data.length, 1);
  await uninstallSetup(directory);
  await restarted.exited;
  assert.equal(restarted.child.exitCode, 0);
  assert((await stat(join(directory, 'state.sqlite'))).isFile());
});
test('only the owned managed child is killed; OS lock recovery permits a fresh server', async (t) => {
  const directory = await folder(t);
  await setupDoubao({ directory, targets: [target], port: await freePort() });
  const first = await start(t, ['setup', 'serve', '--directory', directory]);
  first.child.kill('SIGKILL');
  await first.exited;
  const second = await start(t, ['setup', 'serve', '--directory', directory]);
  second.child.kill('SIGTERM');
  await second.exited;
  assert.equal(second.child.exitCode, 0);
  await setSetupEnabled(directory, false);
});
test('disable refuses a running legacy daemon without changing or signaling it', async (t) => {
  const directory = await folder(t);
  const setup = await setupDoubao({ directory, targets: [target], port: await freePort() });
  const args = setup.startArgv.slice(setup.startArgv.indexOf('serve'));
  const live = await start(t, args);
  await assert.rejects(setSetupEnabled(directory, false), /outside setup serve/);
  assert.equal((await loadSetup(directory)).enabled, true);
  assert.equal(live.child.exitCode, null);
  const owner = (await readFile(join(directory, 'owner.token'), 'utf8')).trim();
  assert.equal(
    (await new AgentHubClient({ baseUrl: live.ready.url, token: owner }).instances()).data.length,
    1,
  );
  live.child.kill('SIGTERM');
  await live.exited;
});
test('uninstall retries refuse edited remaining files; missing ownership entries and unsafe files fail closed', async (t) => {
  const directory = await folder(t);
  await setupDoubao({ directory, targets: [target], port: await freePort() });
  const manifest = await loadSetup(directory);
  manifest.enabled = false;
  manifest.uninstalled = true;
  await writeFile(join(directory, 'setup.json'), JSON.stringify(manifest));
  await unlink(join(directory, 'owner.token'));
  await writeFile(join(directory, 'mcp.json'), 'keep my changes');
  await assert.rejects(uninstallSetup(directory), /modified/);
  assert((await stat(join(directory, 'caller.token'))).isFile());
  delete manifest.files['mcp.json'];
  await writeFile(join(directory, 'setup.json'), JSON.stringify(manifest));
  await assert.rejects(loadSetup(directory), /manifest/);
  await chmod(directory, 0o755);
  await assert.rejects(loadSetup(directory), /private/);
});
test('setup refuses symlinked credentials and parent paths and reports offline diagnostics without sending', async (t) => {
  const directory = await folder(t);
  await setupDoubao({ directory, targets: [target], port: await freePort() });
  const report = await diagnoseSetup(directory);
  assert.equal(report.status, 'error');
  assert.equal(report.deliveryTested, false);
  assert.equal(report.hostLoadingVerified, false);
  await unlink(join(directory, 'caller.token'));
  await symlink(join(directory, 'owner.token'), join(directory, 'caller.token'));
  await assert.rejects(loadSetup(directory));
  const parentLink = directory + '-link';
  await symlink(directory, parentLink);
  await assert.rejects(
    setupDoubao({ directory: join(parentLink, 'child'), targets: [target] }),
    /canonical/,
  );
});

test('initialization and manifest loading share UUID validation before writing credentials', async (t) => {
  const directory = await folder(t);
  await assert.rejects(
    setupDoubao({
      directory,
      targets: [{ ...target, sessionId: '11111111-1111-1111-1111-111111111111' }],
    }),
    /UUID/,
  );
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await setupDoubao({
    directory,
    targets: [
      target,
      { ...target, harness: 'codex', sessionId: '018f6f84-7c29-7d68-9d82-641471570d3c' },
    ],
  });
  assert.equal((await loadSetup(directory)).targets.length, 2);
});

for (const response of ['unauthorized', 'html', 'other-json'] as const) {
  test(`unrelated ${response} service on the configured port does not block disable or uninstall`, async (t) => {
    const directory = await folder(t);
    const server = createHttpServer((_req, res) => {
      if (response === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'other Hub' } }));
      } else if (response === 'html') res.end('<html>other service</html>');
      else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    await setupDoubao({
      directory,
      targets: [target],
      port: (server.address() as { port: number }).port,
    });
    await setSetupEnabled(directory, false);
    assert.equal((await loadSetup(directory)).enabled, false);
    assert.equal((await uninstallSetup(directory)).uninstalled, true);
    assert.equal(server.listening, true);
  });
}

test('an unresponsive port has unknown ownership and preserves credentials for explicit operator recovery', async (t) => {
  const directory = await folder(t);
  const server = createHttpServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  await setupDoubao({
    directory,
    targets: [target],
    port: (server.address() as { port: number }).port,
  });
  const owner = await readFile(join(directory, 'owner.token'), 'utf8');
  await assert.rejects(setSetupEnabled(directory, false), { code: 'setup_hub_unknown' });
  await assert.rejects(uninstallSetup(directory), { code: 'setup_hub_unknown' });
  assert.equal((await loadSetup(directory)).uninstalled, false);
  assert.equal(await readFile(join(directory, 'owner.token'), 'utf8'), owner);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  assert.equal((await uninstallSetup(directory)).uninstalled, true);
});

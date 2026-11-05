import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
const exec = promisify(execFile),
  directory = await mkdtemp(join(tmpdir(), 'ah-package-'));
const node = process.argv[2] ?? process.execPath;
try {
  const metadata = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const packed = await exec('npm', ['pack', '--json', '--pack-destination', directory], {
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const info = JSON.parse(packed.stdout)[0];
  if (info.files.some((f) => /(^|\/)(\.local|test|node_modules)\//.test(f.path)))
    throw Error('Unexpected private/test package content');
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await exec(
    'npm',
    [
      'install',
      '--prefer-offline',
      '--fetch-timeout=15000',
      '--fetch-retries=1',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org',
      join(directory, info.filename),
    ],
    { cwd: directory, timeout: 60000 },
  );
  await writeFile(
    join(directory, 'verify.mjs'),
    `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { once } from 'node:events';
    const core = await import(${JSON.stringify(metadata.name)});
    assert.equal(core.openApi.info.version, ${JSON.stringify(metadata.version)});
    assert.equal(typeof core.ConnectorService, 'function');
    assert.equal(typeof core.ConnectorClient, 'function');
    const mcp = await import(${JSON.stringify(metadata.name + '/mcp')});
    assert.equal(typeof mcp.createConnectorMcpServer, 'function');
    for (const suffix of ['/client', '/mcp', '/codex-bridge', '/codex-bridge/client']) await import(${JSON.stringify(metadata.name)} + suffix);
    const stateFile = join(process.cwd(), 'private-state', 'state.sqlite');
    const hub = await core.openLocalHub({ codex: false, claude: false }, { stateFile });
    const cursor = hub.events.cursor;
    const app = core.createHubServer({ hub, token: 'package-test-token'.repeat(4) });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const client = new core.AgentHubClient({ baseUrl: 'http://127.0.0.1:' + app.server.address().port, token: 'package-test-token'.repeat(4) });
    assert.deepEqual((await client.instances()).data, []); await app.close();
    const restored = await core.openLocalHub({ codex: false, claude: false }, { stateFile });
    assert.equal(restored.events.cursor, cursor); await restored.close();
    console.log(JSON.stringify({ node: process.version, exports: 5, http: true, sqlite: true, emptyEventCursorRestored: true }));
  `,
  );
  const result = await exec(node, ['verify.mjs'], { cwd: directory, timeout: 20000 });
  for (const [name, file] of Object.entries(metadata.bin)) {
    const help = await exec(
      node,
      [join(directory, 'node_modules', metadata.name, file), '--help'],
      {
        cwd: directory,
        timeout: 10000,
      },
    );
    if (name === 'agenthub') assert(help.stdout.startsWith(`AgentHub ${metadata.version}\n`));
  }
  if (process.platform !== 'win32') {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    const setupDir = join(await realpath(directory), 'package-setup');
    const cli = join(directory, 'node_modules', metadata.name, metadata.bin.agenthub);
    const run = (...args) =>
      exec(node, [cli, 'setup', ...args, '--directory', setupDir], { timeout: 10000 });
    const initialized = JSON.parse(
      (
        await run(
          'init',
          '--harness',
          'claude',
          '--session-id',
          '11111111-1111-4111-8111-111111111111',
          '--port',
          String(port),
        )
      ).stdout,
    );
    assert.equal(initialized.started, false);
    assert.equal(JSON.parse((await run('disable')).stdout).enabled, false);
    assert.equal(JSON.parse((await run('uninstall')).stdout).uninstalled, true);
  }
  console.log(
    JSON.stringify({
      package: metadata.name,
      version: metadata.version,
      bytes: info.size,
      files: info.files.length,
      binaries: Object.keys(metadata.bin),
      check: JSON.parse(result.stdout),
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  for (const file of Object.values(metadata.bin))
    await exec(node, [join(directory, 'node_modules', metadata.name, file), '--help'], {
      cwd: directory,
      timeout: 10000,
    });
  console.log(
    JSON.stringify({
      package: metadata.name,
      bytes: info.size,
      files: info.files.length,
      binaries: Object.keys(metadata.bin),
      check: JSON.parse(result.stdout),
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

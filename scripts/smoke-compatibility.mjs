import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { exec, cleanEnv, startCodex, stopOwned } from './live-processes.mjs';
if (!process.argv.includes('--run')) {
  console.log(
    'Add --run --config PATH. Each JSON array row has name, claude and codex executable paths. Only newly spawned backends/sessions are used.',
  );
  process.exit(0);
}
const configIndex = process.argv.indexOf('--config');
assert(configIndex >= 0 && process.argv[configIndex + 1], '--config is required');
const rows = JSON.parse(await readFile(resolve(process.argv[configIndex + 1]), 'utf8'));
assert(Array.isArray(rows) && rows.length > 0 && rows.length <= 8);
const names = new Set();
for (const row of rows) {
  assert(/^[a-z0-9-]{1,64}$/.test(row.name));
  assert(typeof row.claude === 'string' && typeof row.codex === 'string');
  assert(!names.has(row.name));
  names.add(row.name);
}
const reportDir = resolve('.local/verification');
await mkdir(reportDir, { recursive: true, mode: 0o700 });
let failed = false;
for (const row of rows) {
  const dir = await mkdtemp('/tmp/ah-compat-');
  let backend, run;
  try {
    backend = await startCodex(join(dir, 'backend'), row.codex);
    run = exec(
      process.execPath,
      [
        resolve('scripts/smoke-isolated.mjs'),
        '--run',
        '--matrix',
        '--default-inbox',
        '--report',
        join(reportDir, `compat-${row.name}.json`),
      ],
      {
        env: {
          ...cleanEnv(),
          CODEX_BRIDGE_SOCKET: backend.socketPath,
          AGENTHUB_TEST_CLAUDE: row.claude,
          AGENTHUB_TEST_CODEX: row.codex,
        },
        timeout: 600000,
        maxBuffer: 4 * 1024 * 1024,
        detached: true,
      },
    );
    run.child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    const result = await run;
    await writeFile(join(reportDir, `compat-${row.name}.log`), result.stdout + result.stderr, {
      mode: 0o600,
    });
    const report = JSON.parse(await readFile(join(reportDir, `compat-${row.name}.json`), 'utf8'));
    assert(report.passed);
    console.log(
      JSON.stringify({
        name: row.name,
        versions: report.versions,
        checks: report.checks.length,
        passed: report.passed,
      }),
    );
  } catch (e) {
    failed = true;
    await writeFile(
      join(reportDir, `compat-${row.name}.error.log`),
      String(e.stack ?? e) + '\n' + (e.stdout ?? '') + '\n' + (e.stderr ?? ''),
      { mode: 0o600 },
    );
    console.error(JSON.stringify({ name: row.name, passed: false, error: String(e.message) }));
  } finally {
    if (run?.child?.pid) await stopOwned(run.child);
    await backend?.stop();
    backend?.rpc.close();
    await rm(dir, { recursive: true, force: true });
  }
}
if (failed) process.exitCode = 1;

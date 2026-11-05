import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { openDoubaoHost } from '../dist/src/doubao-host.js';
import { loadSetup } from '../dist/src/setup.js';
if (!process.argv.includes('--run')) {
  console.log(
    'No host writes. Use --run --cdp-port PORT against an already running Doubao 2.35.15; this creates and removes one temporary connector without sending a model message.',
  );
  process.exit(0);
}
const port = Number(process.argv[process.argv.indexOf('--cdp-port') + 1]);
if (!process.argv.includes('--cdp-port') || !Number.isInteger(port) || port < 1 || port > 65535)
  throw Error('--cdp-port PORT is required');
const exec = promisify(execFile),
  cli = resolve('dist/src/cli.js');
const api = await openDoubaoHost(port);
let before;
try {
  before = (await api.list()).map((e) => e.connector_id).sort();
} catch (error) {
  api.close();
  throw error;
}
const root = await realpath(await mkdtemp(join(tmpdir(), 'ah-doubao-host-'))),
  directory = join(root, 'setup');
const report = {
  hostVersion: '2.35.15',
  startedAt: new Date().toISOString(),
  checks: [],
  scope: 'Internal desktop API lifecycle only. No model turn, host reply or automatic app restart.',
};
let initialized = false,
  cleanupVerified = false;
const run = async (...args) =>
  JSON.parse(
    (
      await exec(process.execPath, [cli, 'setup', ...args, '--directory', directory], {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout,
  );
const host = (op) => run('host-' + op, '--doubao-cdp-port', String(port));
const check = (name) => {
  report.checks.push({ name, passed: true });
  console.log(JSON.stringify({ name, passed: true }));
};
try {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const hubPort = listener.address().port;
  await new Promise((r) => listener.close(r));
  await run('init', '--harness', 'claude', '--session-id', randomUUID(), '--port', String(hubPort));
  initialized = true;
  const installed = await host('install');
  assert.equal(installed.phase, 'installed');
  assert.equal(installed.hostLoadingVerified, false);
  const detail = await api.detail(installed.connectorId);
  assert.equal(detail.mcp_config.stdio_config.command, join(directory, 'agenthub-mcp'));
  check('create_and_readback_exact_launcher');
  assert.equal((await host('install')).connectorId, installed.connectorId);
  check('repeat_install_reuses_recorded_connector');
  await host('disable');
  assert.equal((await api.detail(installed.connectorId)).enabled, false);
  await host('enable');
  assert.equal((await api.detail(installed.connectorId)).enabled, true);
  check('disable_and_enable_readback');
  await host('remove');
  assert.deepEqual((await api.list()).map((e) => e.connector_id).sort(), before);
  cleanupVerified = true;
  check('remove_preserves_all_prior_local_connectors');
  await run('uninstall');
  check('generated_setup_uninstalled');
  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (initialized && !cleanupVerified) {
    try {
      await host('remove');
      assert.deepEqual((await api.list()).map((e) => e.connector_id).sort(), before);
      cleanupVerified = true;
    } catch (error) {
      report.cleanupError = error.message;
    }
  }
  api.close();
  if (!initialized || cleanupVerified) {
    await rm(root, { recursive: true, force: true });
    report.temporaryFilesRemoved = true;
  } else {
    report.retainedPrivateDirectory = directory;
    report.pendingRegistration = (await loadSetup(directory)).doubaoHost;
  }
  report.finishedAt = new Date().toISOString();
  await mkdir('.local/verification', { recursive: true });
  await writeFile(
    '.local/verification/doubao-host-api-live.json',
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ outcome: report.outcome, checks: report.checks.length, cleanupVerified }),
  );
}

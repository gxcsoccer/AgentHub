// This harness opens a temporary, in-memory HTTP service and permits only
// native reads. It never creates, resumes, sends to or interrupts sessions.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { once } from 'node:events';
import { CodexRpc } from '../dist/vendor/codex-bridge/src/rpc.js';
import {
  HarnessHub,
  CodexAdapter,
  ClaudeAdapter,
  HarnessHubClient,
  createHubServer,
} from '../dist/src/index.js';

if (!process.argv.includes('--run')) {
  console.log(
    'No harness reads performed. Add --run to check installed backends without session mutations.',
  );
  process.exit(0);
}
const arg = process.argv.indexOf('--report');
const reportPath = resolve(
  arg < 0 ? '.local/verification/doctor-readonly.json' : process.argv[arg + 1],
);
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  nativeMethods: [],
  httpMethods: [],
  scope: 'read-only native discovery and target details; no delivery test',
};
const rpc = new CodexRpc({
  socketPath:
    process.env.CODEX_BRIDGE_SOCKET ??
    join(
      process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      'app-server-control/app-server-control.sock',
    ),
});
const raw = rpc.request.bind(rpc);
rpc.request = async (method, params) => {
  report.nativeMethods.push(method);
  assert(
    ['thread/list', 'thread/loaded/list', 'thread/read'].includes(method),
    'Native write or unexpected read refused',
  );
  return raw(method, params);
};
const codex = new CodexAdapter({ rpc }),
  claude = new ClaudeAdapter({ nativeMessaging: true });
codex.send = claude.send = async () => {
  throw Error('Delivery forbidden in read-only diagnostic acceptance');
};
const hub = new HarnessHub([codex, claude]),
  token = randomUUID() + randomUUID();
const app = createHubServer({ hub, token });
const exec = promisify(execFile);
try {
  app.server.on('request', (request) => report.httpMethods.push(request.method));
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`,
    client = new HarnessHubClient({ baseUrl, token });
  const run = async (name, args = []) => {
    const result = await exec(
      process.execPath,
      [
        new URL('../dist/src/cli.js', import.meta.url).pathname,
        'doctor',
        '--url',
        baseUrl,
        ...args,
      ],
      { env: { ...process.env, HARNESSHUB_TOKEN: token }, timeout: 60000 },
    ).catch((error) => {
      if (typeof error.code === 'number' && [1, 2].includes(error.code) && error.stdout)
        return { stdout: error.stdout, code: error.code };
      throw error;
    });
    const diagnosis = JSON.parse(result.stdout);
    assert.equal(diagnosis.readOnly, true);
    assert.equal(diagnosis.deliveryTested, false);
    assert(!result.stdout.includes(token));
    assert.equal(
      result.code ?? 0,
      diagnosis.status === 'ok' ? 0 : diagnosis.status === 'warning' ? 2 : 1,
    );
    report.checks.push({ name, diagnosis });
  };
  await run('configured_instances');
  assert(
    report.checks[0].diagnosis.checks
      .filter((x) => x.id === 'discovery')
      .every((x) => x.status !== 'error'),
    'A real backend discovery failed',
  );
  const loaded = await rpc.request('thread/loaded/list', { limit: 5 });
  let selected;
  for (const id of loaded.data) {
    const candidate = await client.getSession({
      harness: 'codex',
      instance: 'local',
      sessionId: id,
    });
    if (candidate.metadata.canAcceptDirectInput !== false && !candidate.metadata.parentThreadId) {
      selected = id;
      break;
    }
  }
  if (selected) await run('codex_target', ['--harness', 'codex', '--session-id', selected]);
  else report.checks.push({ name: 'codex_target', skipped: 'No loaded root in bounded sample' });
  const peers = await client.listSessions({ harness: 'claude', instance: 'local' }, { limit: 1 });
  if (peers.data[0])
    await run('claude_target', [
      '--harness',
      'claude',
      '--session-id',
      peers.data[0].address.sessionId,
    ]);
  else report.checks.push({ name: 'claude_target', skipped: 'No live Claude session' });
  assert(report.httpMethods.every((method) => method === 'GET'));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await app.close();
  report.finishedAt = new Date().toISOString();
  await mkdir(resolve(reportPath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.map((x) => ({
        name: x.name,
        status: x.diagnosis?.status,
        skipped: x.skipped,
      })),
      nativeMethods: [...new Set(report.nativeMethods)],
      reportPath,
    }),
  );
}

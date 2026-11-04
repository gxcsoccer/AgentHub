import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { AcpAdapter, AgentHub, AgentHubClient, createHubServer } from '../dist/src/index.js';
import { exec, cleanEnv, isolatedCodexHome, until } from './live-processes.mjs';

if (!process.argv.includes('--run')) {
  console.log(
    'Add --run to exercise pinned, locally installed ACP backends using fresh sessions and existing authentication.',
  );
  process.exit(0);
}
const runtime = resolve(process.env.AGENTHUB_TEST_ACP_RUNTIME ?? '.local/acceptance/runtime');
const cli = process.env.AGENTHUB_TEST_CLAUDE ?? (await exec('which', ['claude'])).stdout.trim();
const codex = process.env.AGENTHUB_TEST_CODEX ?? (await exec('which', ['codex'])).stdout.trim();
const dir = await mkdtemp('/tmp/ah-acp-');
const reportPath = resolve(process.env.AGENTHUB_TEST_REPORT ?? '.local/verification/acp-live.json');
const report = {
  startedAt: new Date().toISOString(),
  scope:
    'Real ACP backends, owned managed sessions, no live attach. Claude tools/hooks/MCP disabled by test executable; Codex isolated home and read-only mode. No remote-host acceptance.',
  checks: [],
  cleanup: [],
  passed: false,
};
let app, hub, failure;
async function descendants() {
  const rows = (await exec('ps', ['-ax', '-o', 'pid=,ppid='])).stdout
    .trim()
    .split('\n')
    .map((s) => s.trim().split(/\s+/).map(Number));
  const owned = new Set([process.pid]);
  for (let i = 0; i < rows.length; i++)
    for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid);
  owned.delete(process.pid);
  return [...owned];
}
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
    return true;
  }
};
let ownedPids = [];
const check = (name, evidence = {}) => {
  report.checks.push({ name, passed: true, evidence });
  console.log(JSON.stringify({ name, ...evidence }));
};
try {
  const packageInfo = async (name, expected) => {
    const p = JSON.parse(
      await readFile(
        join(runtime, 'node_modules/@agentclientprotocol', name, 'package.json'),
        'utf8',
      ),
    );
    assert.equal(p.version, expected, 'Use the documented pinned acceptance dependencies');
    return p.version;
  };
  report.versions = {
    node: process.version,
    claude: (await exec(cli, ['--version'])).stdout.trim(),
    codex: (await exec(codex, ['--version'])).stdout.trim(),
    claudeAcp: await packageInfo('claude-agent-acp', '0.100.0'),
    codexAcp: await packageInfo('codex-acp', '2.5.0'),
  };
  const env = cleanEnv();
  const wrapper = resolve('scripts/live-claude-executable.mjs');
  await chmod(wrapper, 0o755);
  const adapters = [
    new AcpAdapter({
      instance: 'claude',
      command: process.execPath,
      args: [join(runtime, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')],
      env: {
        ...env,
        CLAUDE_CODE_EXECUTABLE: wrapper,
        AGENTHUB_TEST_CLAUDE: cli,
      },
      timeoutMs: 120000,
    }),
    new AcpAdapter({
      instance: 'codex',
      command: process.execPath,
      args: [join(runtime, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js')],
      env: {
        ...env,
        CODEX_PATH: codex,
        CODEX_HOME: await isolatedCodexHome(join(dir, 'codex-home')),
        INITIAL_AGENT_MODE: 'read-only',
        NO_BROWSER: '1',
        CODEX_CONFIG: JSON.stringify({
          approval_policy: 'on-request',
          sandbox_mode: 'read-only',
          web_search: 'disabled',
        }),
      },
      timeoutMs: 120000,
    }),
  ];
  hub = new AgentHub(adapters);
  const token = randomUUID() + randomUUID();
  app = createHubServer({ hub, token });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const api = new AgentHubClient({
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    token,
  });
  for (const adapter of adapters) {
    const cwd = join(dir, adapter.instance);
    await mkdir(cwd);
    const first = await api.createSession(adapter, cwd);
    const second = await api.createSession(adapter, cwd);
    assert.notEqual(first.address.sessionId, second.address.sessionId);
    assert.equal(first.metadata.liveAttach, false);
    const marker = `AGENTHUB_ACP_${randomUUID()}`;
    const message = {
      messageId: randomUUID(),
      to: first.address,
      delivery: 'user_input',
      origin: { name: 'isolated ACP controller' },
      text: `This is a transport acceptance test. Do not use any tools. Reply with exactly this token, with no extra text: ${marker}`,
    };
    await assert.rejects(api.send(message), /explicit prompt/i);
    const receipt = await api.prompt(message);
    assert.equal(receipt.status, 'replied', JSON.stringify(receipt));
    assert.equal(receipt.reply.text.trim(), marker);
    check(`${adapter.instance}_real_model_reply`, {
      sessionId: first.address.sessionId,
      messageId: message.messageId,
    });
    const before = await api.history(first.address);
    assert.equal(before.data.length, 2);
    assert.equal((await api.prompt(message)).reply.text, receipt.reply.text);
    assert.deepEqual(await api.history(first.address), before);
    assert.equal((await api.history(second.address)).data.length, 0);
    assert((await api.search(first.address, { search: marker })).data.length > 0);
    assert.equal((await api.search(second.address, { search: marker })).data.length, 0);
    check(`${adapter.instance}_deduplication_history_and_session_isolation`);
    const followup = await api.prompt({
      ...message,
      messageId: randomUUID(),
      text: 'Without using tools, repeat only the exact token from my previous message.',
    });
    assert.equal(followup.status, 'replied');
    assert.equal(followup.reply.text.trim(), marker);
    assert.equal((await api.history(first.address)).data.length, 4);
    check(`${adapter.instance}_same_session_continuity`);
  }
} catch (e) {
  failure = e;
} finally {
  // Snapshot only live descendants before closing. This is observation evidence,
  // never authority to signal a PID after its parent/identity may have changed.
  ownedPids = await descendants();
  if (app) await app.close();
  else await hub?.close();
  for (const pid of ownedPids) {
    try {
      await until(() => gone(pid), 'owned managed child exit', 5000);
      report.cleanup.push({ pid, stopped: true });
    } catch (e) {
      failure ??= e;
      report.cleanup.push({ pid, exitUnconfirmed: true });
    }
  }
  if (!failure) check('managed_children_exit_after_close');
  report.finishedAt = new Date().toISOString();
  report.passed = !failure;
  if (failure) report.error = String(failure.stack ?? failure);
  await mkdir(resolve(reportPath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  if (report.cleanup.some((entry) => entry.exitUnconfirmed)) {
    report.retainedDirectory = dir;
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  } else await rm(dir, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}

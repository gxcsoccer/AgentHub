// Opt-in: only two fresh PTY processes and their exact native PIDs are visible to this Hub.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AgentHub,
  ClaudeAdapter,
  ConnectorService,
  createHubServer,
  openReceiptStore,
} from '../dist/src/index.js';
import { cleanEnv, spawnOwned, stopOwned, exec, until } from './live-processes.mjs';
if (!process.argv.includes('--run')) {
  console.log('No live actions. Add --run to test two newly created Claude sessions.');
  process.exit(0);
}
const cli = resolve('dist/src/cli.js'),
  roots = [],
  children = [],
  report = {
    startedAt: new Date().toISOString(),
    checks: [],
    cleanup: [],
    scope:
      'Two owned Claude PTY processes only; no existing-session writes; MCP and hooks installed at launch, not hot activation.',
  };
const reportPath = resolve('.local/verification/connector-claude-live.json');
await mkdir(resolve('.local/verification'), { recursive: true });
const env = cleanEnv();
for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CONFIG_DIR'])
  delete env[key];
let hub, app, store, service, port;
const enrollment = randomUUID() + randomUUID(),
  owner = randomUUID() + randomUUID(),
  ids = [randomUUID(), randomUUID()];
const q = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const check = (name, evidence = {}) => {
  report.checks.push({ name, passed: true, evidence });
  console.log(JSON.stringify({ name, passed: true, ...evidence }));
};
const nativeRows = async () =>
  JSON.parse(
    (await exec('claude', ['agents', '--json'], { env, timeout: 10000, maxBuffer: 1024 * 1024 }))
      .stdout,
  );
const ownedRows = async () => {
  const pids = await Promise.all(
    roots.map((root) =>
      readFile(join(root, 'interactive-pid.json'), 'utf8')
        .then(JSON.parse)
        .then((x) => x.pid)
        .catch(() => null),
    ),
  );
  return (await nativeRows()).filter(
    (r) =>
      pids.includes(r.pid) &&
      roots.some((root) => r.cwd?.replace(/^\/private\/tmp\//, '/tmp/') === join(root, 'work')),
  );
};
const row = async (i) =>
  (await ownedRows()).find(
    (r) => r.cwd?.replace(/^\/private\/tmp\//, '/tmp/') === join(roots[i], 'work'),
  );
const terminal = async (i) =>
  (await readFile(join(roots[i], 'interactive-terminal.bin'), 'utf8').catch(() => ''))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
const type = (i, text) =>
  appendFile(join(roots[i], 'interactive-input.ndjson'), JSON.stringify({ text }) + '\n', {
    mode: 0o600,
  });
const input = async (i, text) => {
  await type(i, text);
  await delay(200);
  await type(i, '\r');
};
const idle = (i) =>
  until(async () => (await row(i))?.status === 'idle', 'owned Claude idle', 60000);
const turn = async (i, text) => {
  await input(i, text);
  await until(async () => (await row(i))?.status === 'busy', 'owned model turn started', 20000);
  await idle(i);
};
const profiles = [
  {
    id: 'live-test',
    callerId: 'agents',
    harness: 'claude',
    instance: 'local',
    enrollmentToken: enrollment,
  },
];
const open = async () => {
  store = await openReceiptStore(join(roots[0], 'state.sqlite'));
  hub = new AgentHub([new ClaudeAdapter({ discover: ownedRows, nativeMessaging: true })], {
    store,
    callers: [
      {
        id: 'agents',
        grants: [{ harness: 'claude', instance: 'local', operations: ['read', 'send'] }],
      },
    ],
  });
  service = new ConnectorService(hub, profiles);
  app = createHubServer({ hub, token: owner, connectors: service });
  app.server.listen(port ?? 0, '127.0.0.1');
  await once(app.server, 'listening');
  port = app.server.address().port;
};
const requests = () => store.load().filter((r) => r.envelope.messageKind === 'request');
const observed = async (i, marker) => {
  const r = await row(i);
  if (!r) return false;
  return JSON.stringify(
    await hub.history(
      { harness: 'claude', instance: 'local', sessionId: r.sessionId },
      { limit: 100 },
    ),
  ).includes(marker);
};
try {
  report.version = (await exec('claude', ['--version'], { env })).stdout.trim();
  for (let i = 0; i < 2; i++) {
    const root = await mkdtemp('/tmp/ah-life-');
    roots.push(root);
    await mkdir(join(root, 'work/.claude'), { recursive: true });
  }
  await open();
  const system =
    'You are an isolated AgentHub acceptance fixture. Only use list_peers, ask_agent and reply_agent from the agenthub MCP server when explicitly directed. No other tools, files, shell, settings, permissions, web or sessions. Incoming AgentHub messageKind=request: if text is HOLD_TEST, say WAITING_TEST and wait for a user instruction without replying; otherwise call reply_agent once with request=message.messageId, message=ANSWER_TEST:<message.text>. Incoming messageKind=result: output RESULT_OBSERVED:<message.inReplyTo>:<message.text>, call no tool and do not reply. On user request use exact arguments supplied, then say DONE_TEST. Tool errors: output the error, do not invent success or change configuration.';
  for (let i = 0; i < 2; i++) {
    const root = roots[i],
      profile = join(root, 'profile.json');
    await writeFile(join(root, 'enrollment'), enrollment, { mode: 0o600 });
    await writeFile(
      profile,
      JSON.stringify({ url: `http://127.0.0.1:${port}`, enrollmentTokenFile: 'enrollment' }),
      { mode: 0o600 },
    );
    const mcp = join(root, 'mcp.json');
    await writeFile(
      mcp,
      JSON.stringify({
        mcpServers: {
          agenthub: {
            command: process.execPath,
            args: [cli, 'mcp', '--connector-profile', profile],
          },
        },
      }),
      { mode: 0o600 },
    );
    const hook = `exec ${q(process.execPath)} ${q(cli)} connector-hook --connector-profile ${q(profile)}`;
    const settings = join(root, 'work/.claude/settings.json');
    await writeFile(
      settings,
      JSON.stringify({
        crossSessionInbound: 'accept',
        language: 'English',
        hooks: Object.fromEntries(
          ['SessionStart', 'SessionEnd'].map((event) => [
            event,
            [{ hooks: [{ type: 'command', command: hook, timeout: 20 }] }],
          ]),
        ),
      }),
      { mode: 0o600 },
    );
    const args = [
      'claude',
      '--session-id',
      ids[i],
      '--name',
      i ? 'connector-reviewer' : 'connector-worker',
      '--setting-sources',
      'project',
      '--settings',
      settings,
      '--strict-mcp-config',
      '--mcp-config',
      mcp,
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--allowedTools',
      'mcp__agenthub__list_peers,mcp__agenthub__ask_agent,mcp__agenthub__reply_agent',
      '--no-chrome',
      '--system-prompt',
      system,
    ];
    await writeFile(join(root, 'interactive-command.json'), JSON.stringify(args), { mode: 0o600 });
    await writeFile(join(root, 'interactive-input.ndjson'), '');
    const child = spawnOwned('python3', [resolve('scripts/fixtures/claude-pty.py'), root], {
      env: { ...env, TERM: 'xterm-256color' },
      cwd: join(root, 'work'),
    });
    children.push(child);
    child.stdout.resume();
    child.stderr.resume();
    let trusted = false;
    await until(
      async () => {
        const t = await terminal(i);
        if (!trusted && (t.includes('trustthisfolder') || t.includes('trust this folder'))) {
          trusted = true;
          await delay(1200);
          await type(i, '\x1b[B');
          await delay(400);
          await type(i, '\r');
        }
        return row(i);
      },
      'owned Claude startup',
      45000,
    );
    await idle(i);
    await turn(i, 'Call list_peers once. Then say DONE_TEST.');
  }
  const initial = await service.connections();
  assert.equal(initial.bindings.length, 2);
  check('two_real_claude_mcp_processes_enrolled', {
    bindings: initial.bindings.map((b) => b.address.sessionId),
  });
  await turn(
    0,
    'Call ask_agent with to=@claude/connector-reviewer, message=ROUNDTRIP_TEST, deadlineSeconds=120.',
  );
  const request = await until(
    () => requests().find((r) => r.envelope.text === 'ROUNDTRIP_TEST'),
    'request receipt',
    15000,
  );
  await until(
    () => hub.receipt(request.envelope.messageId).status === 'replied',
    'MCP business reply',
    60000,
  );
  await until(
    () => observed(0, 'RESULT_OBSERVED:' + request.envelope.messageId),
    'result consumed by source',
    60000,
  );
  const receipt = hub.receipt(request.envelope.messageId);
  assert.equal(receipt.reply.text, 'ANSWER_TEST:ROUNDTRIP_TEST');
  assert(!receipt.forwardError);
  check('ask_reply_result_through_production_cli_and_native_inbox');
  await idle(0);
  await idle(1);
  const bindingIds = initial.bindings.map((b) => b.bindingId).sort();
  await app.close();
  app = undefined;
  await open();
  await turn(0, 'Call list_peers once. Then say DONE_TEST.');
  assert.deepEqual(
    (await service.connections()).bindings.map((b) => b.bindingId).sort(),
    bindingIds,
  );
  check('hub_restart_preserves_binding_and_live_mcp_credential');
  await turn(
    1,
    'Call ask_agent with to=@claude/connector-worker, message=HOLD_TEST, deadlineSeconds=240.',
  );
  const reverse = await until(
    () =>
      requests().find(
        (r) => r.envelope.text === 'HOLD_TEST' && r.envelope.origin.session.sessionId === ids[1],
      ),
    'reverse request',
    15000,
  );
  await until(() => observed(0, 'WAITING_TEST'), 'worker holds reverse request', 60000);
  await idle(0);
  await idle(1);
  await turn(
    1,
    'This is a separate user request while the peer task is pending: say exactly USER_TURN_OBSERVED. Do not call tools or treat the pending task as my answer.',
  );
  assert(await observed(1, 'USER_TURN_OBSERVED'));
  assert.notEqual(hub.receipt(reverse.envelope.messageId).status, 'replied');
  await turn(
    0,
    `Call reply_agent with request=${reverse.envelope.messageId}, message=USER_WAIT_ANSWER.`,
  );
  await until(
    () => observed(1, 'RESULT_OBSERVED:' + reverse.envelope.messageId),
    'reverse result after user turn',
    60000,
  );
  check('second_claude_initiates_and_receives_correlated_result');
  check('intervening_user_turn_and_later_peer_result_remain_separate');
  await idle(0);
  await idle(1);
  await turn(
    0,
    'Call ask_agent with to=@claude/connector-reviewer, message=HOLD_TEST, deadlineSeconds=240.',
  );
  const pending = await until(
    () =>
      requests().find(
        (r) => r.envelope.text === 'HOLD_TEST' && r.envelope.origin.session.sessionId === ids[0],
      ),
    'held request',
    15000,
  );
  await until(() => observed(1, 'WAITING_TEST'), 'recipient holds request', 60000);
  await idle(0);
  await idle(1);
  const old = await row(0);
  await input(0, '/clear');
  const fresh = await until(
    async () => {
      const r = await row(0);
      return r && r.sessionId !== old.sessionId ? r : null;
    },
    'new UUID after clear',
    20000,
  );
  assert.equal(fresh.pid, old.pid);
  await turn(0, 'Call list_peers once. Then say DONE_TEST.');
  assert(
    (await service.connections()).bindings.some((b) => b.address.sessionId === fresh.sessionId),
  );
  check('clear_refreshes_binding_via_real_session_start_hook', {
    oldSession: old.sessionId,
    newSession: fresh.sessionId,
  });
  await turn(
    1,
    `Call reply_agent with request=${pending.envelope.messageId}, message=OLD_ANSWER_TEST.`,
  );
  await until(
    () => hub.receipt(pending.envelope.messageId).forwardError,
    'old destination rejected',
    15000,
  );
  assert(!store.load().some((r) => r.envelope.inReplyTo === pending.envelope.messageId));
  check('old_inflight_reply_does_not_follow_clear_to_new_uuid');
  await turn(
    0,
    'Call ask_agent with to=@claude/connector-reviewer, message=AFTER_CLEAR_TEST, deadlineSeconds=120.',
  );
  const after = await until(
    () => requests().find((r) => r.envelope.text === 'AFTER_CLEAR_TEST'),
    'post-clear request',
    15000,
  );
  assert.equal(after.envelope.replyTo.sessionId, fresh.sessionId);
  await until(
    () => observed(0, 'RESULT_OBSERVED:' + after.envelope.messageId),
    'post-clear result',
    60000,
  );
  check('new_request_roundtrip_after_clear');
  const resultRows = store.load().filter((r) => r.envelope.messageKind === 'result');
  assert.equal(resultRows.length, 3);
  assert(resultRows.every((r) => r.receipt.status !== 'replied' && !r.receipt.reply));
  check('results_do_not_generate_business_replies');
  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  for (let i = 0; i < children.length; i++) {
    await writeFile(
      resolve(`.local/verification/connector-claude-terminal-${i}.txt`),
      await terminal(i),
      { mode: 0o600 },
    );
    await stopOwned(children[i])
      .then(() => report.cleanup.push({ index: i, stopped: true }))
      .catch((e) => report.cleanup.push({ index: i, error: e.message }));
  }
  if (app) await app.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  report.cleanup.push({ temporaryRootsRemoved: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ report: reportPath, outcome: report.outcome, checks: report.checks.length }),
  );
}

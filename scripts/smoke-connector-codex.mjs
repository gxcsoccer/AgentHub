import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { setupDoubao } from './setup-doubao.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AgentHub,
  CodexAdapter,
  ClaudeAdapter,
  ConnectorService,
  createHubServer,
  openReceiptStore,
} from '../dist/src/index.js';
import {
  cleanEnv,
  spawnOwned,
  stopOwned,
  exec,
  until,
  startCodex,
  codexModelTurn,
} from './live-processes.mjs';
if (!process.argv.includes('--run')) {
  console.log(
    'No live actions. Add --run for isolated Codex/Claude connector acceptance; --doubao-host also waits for independent Doubao UI observation.',
  );
  process.exit(0);
}
const doubaoCli = process.argv.includes('--doubao-cli');
const doubaoHost = process.argv.includes('--doubao-host');
const doubaoMcp = process.argv.includes('--doubao-mcp') || doubaoHost;
const doubao = doubaoCli || doubaoMcp;
const claudeCli = process.argv.includes('--claude-cli') || doubao;
const root = await mkdtemp('/tmp/ah-life-'),
  work = join(root, 'work'),
  cli = resolve('dist/src/cli.js'),
  reportPath = resolve(
    doubaoHost
      ? '.local/verification/doubao-host-live.json'
      : doubaoMcp
        ? '.local/verification/doubao-mcp-backends-live.json'
        : doubaoCli
          ? '.local/verification/doubao-cli-backends-live.json'
          : claudeCli
            ? '.local/verification/connector-codex-claude-cli-live.json'
            : '.local/verification/connector-codex-live.json',
  );
await mkdir(work);
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  cleanup: [],
  scope: doubaoHost
    ? 'Owned independent App Server and fresh Claude PTY, plus independent Doubao UI request/reply observation; no busy/disconnect/user-interleaving host claim.'
    : 'Owned independent App Server and fresh Claude PTY only; no native dynamic reply tool or resume. --doubao-cli / --doubao-mcp test the external CLI / stdio MCP workflow, not the Doubao host runtime.',
};
const owner = randomUUID() + randomUUID(),
  codexToken = randomUUID() + randomUUID(),
  claudeToken = randomUUID() + randomUUID();
const doubaoToken = randomUUID() + randomUUID();
const env = cleanEnv();
for (const key of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CONFIG_DIR'])
  delete env[key];
let backend, claude, hub, app, store, service, url, mcpClient;
const owned = new Set(),
  nativeCalls = [];
const check = (name, detail = {}) => {
  report.checks.push({ name, passed: true, detail });
  console.log(JSON.stringify({ name, passed: true, ...detail }));
};
const q = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const discover = async () => {
  const pid = await readFile(join(root, 'interactive-pid.json'), 'utf8')
    .then(JSON.parse)
    .then((x) => x.pid)
    .catch(() => null);
  return JSON.parse(
    (await exec('claude', ['agents', '--json'], { env, timeout: 15000 })).stdout,
  ).filter((r) => r.pid === pid && r.cwd?.replace(/^\/private\/tmp\//, '/tmp/') === work);
};
const type = (text) =>
  appendFile(join(root, 'interactive-input.ndjson'), JSON.stringify({ text }) + '\n', {
    mode: 0o600,
  });
const input = async (text) => {
  await type(text);
  await delay(200);
  await type('\r');
};
const terminal = async () =>
  (await readFile(join(root, 'interactive-terminal.bin'), 'utf8').catch(() => ''))
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
const idle = () =>
  until(async () => (await discover())[0]?.status === 'idle', 'Claude idle', 60000);
const claudeTurn = async (text) => {
  await input(text);
  await until(async () => (await discover())[0]?.status === 'busy', 'Claude turn started', 15000);
  await idle();
};
const request = (text) =>
  store.load().find((r) => r.envelope.messageKind === 'request' && r.envelope.text === text);
async function connect(id, harness = 'codex') {
  try {
    return JSON.parse(
      (
        await exec(
          process.execPath,
          [
            cli,
            'connect',
            '--url',
            url,
            '--harness',
            harness,
            '--session-id',
            id,
            '--connector-profile',
            join(root, harness + '-client.json'),
            '--wait-ms',
            harness === 'claude' ? '60000' : '0',
          ],
          { env: { ...env, AGENTHUB_TOKEN: owner }, timeout: 70000 },
        )
      ).stdout,
    );
  } catch (error) {
    if (error.code === 2) return JSON.parse(error.stdout);
    throw error;
  }
}
const system =
  'Isolated AgentHub connector acceptance. Only use the AgentHub list_peers, ask_agent and reply_agent tools, plus host discovery/code wrappers to find and invoke them. No shell, files, web, settings, permissions or other sessions. For an incoming messageKind=request, call reply_agent once with request=message.messageId and message=ANSWER_TEST:<message.text>. For messageKind=result, output RESULT_OBSERVED:<message.inReplyTo>:<message.text> and call no tool. On user request call only the stated tool. Errors must be reported, not hidden. Never reply to a result.';
try {
  report.claudeVersion = (await exec('claude', ['--version'], { env })).stdout.trim();
  backend = await startCodex(join(root, 'backend'));
  report.codexVersion = backend.version;
  const rpc = backend.rpc,
    raw = rpc.request.bind(rpc);
  rpc.request = async (method, params = {}) => {
    assert(
      [
        'thread/loaded/list',
        'thread/read',
        'thread/list',
        'thread/items/list',
        'thread/search',
        'config/read',
        'config/value/write',
        'config/mcpServer/reload',
        'mcpServerStatus/list',
        'mcpServer/tool/call',
      ].includes(method) ||
        method === 'thread/start' ||
        owned.has(params?.threadId),
      'Non-owned write denied',
    );
    nativeCalls.push({ method, threadId: params?.threadId });
    const value = await raw(method, params);
    if (method === 'thread/start') owned.add(value.thread.id);
    return value;
  };
  const { thread } = await rpc.request('thread/start', {
    cwd: work,
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    developerInstructions: system,
  });
  await rpc.request('thread/name/set', { threadId: thread.id, name: 'connector-codex' });
  const codexTurn = (text) => codexModelTurn(rpc, thread.id, text);
  store = await openReceiptStore(join(root, 'state.sqlite'));
  hub = new AgentHub(
    [new CodexAdapter({ rpc }), new ClaudeAdapter({ discover, nativeMessaging: true })],
    {
      store,
      callers: [
        ...(doubao
          ? [
              {
                id: 'doubao-plugin',
                grants: [
                  {
                    harness: 'codex',
                    instance: 'local',
                    sessions: [thread.id],
                    operations: ['read', 'send'],
                  },
                  // discover() is restricted to the exact owned Claude PID and test workspace.
                  { harness: 'claude', instance: 'local', operations: ['read', 'send'] },
                ],
              },
            ]
          : []),
        {
          id: 'agents',
          grants: [
            {
              harness: 'codex',
              instance: 'local',
              sessions: [thread.id],
              operations: ['read', 'send'],
            },
            { harness: 'claude', instance: 'local', operations: ['read', 'send'] },
          ],
        },
      ],
    },
  );
  service = new ConnectorService(hub, [
    {
      id: 'codex',
      callerId: 'agents',
      harness: 'codex',
      instance: 'local',
      enrollmentToken: codexToken,
    },
    {
      id: 'claude',
      ...(claudeCli ? { transport: 'cli' } : {}),
      callerId: 'agents',
      harness: 'claude',
      instance: 'local',
      enrollmentToken: claudeToken,
    },
  ]);
  app = createHubServer({
    hub,
    token: owner,
    connectors: service,
    ...(doubao ? { callers: [{ id: 'doubao-plugin', token: doubaoToken }] } : {}),
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  url = 'http://127.0.0.1:' + app.server.address().port;
  for (const [harness, token] of [
    ['codex', codexToken],
    ['claude', claudeToken],
  ]) {
    await writeFile(join(root, harness + '.token'), token, { mode: 0o600 });
    await writeFile(
      join(root, harness + '-client.json'),
      JSON.stringify({ url, harness, enrollmentTokenFile: harness + '.token' }),
      { mode: 0o600 },
    );
  }
  const installed = await connect(thread.id);
  report.installation = installed;
  assert.equal(installed.activationScope, 'instance');
  assert.equal(installed.exitCode, 0);
  assert.equal((await service.connections()).bindings.length, 1);
  assert.equal(nativeCalls.filter((c) => c.method === 'turn/start').length, 0);
  check('existing_codex_thread_activated_and_bound_without_model_turn_or_resume');
  const discoveryStart = nativeCalls.length;
  const livePeers = await hub.listPeerSessions({ harness: 'codex', instance: 'local' });
  assert.deepEqual(
    livePeers.data.map((peer) => peer.address.sessionId),
    [thread.id],
  );
  assert(nativeCalls.slice(discoveryStart).some((call) => call.method === 'thread/loaded/list'));
  assert(!nativeCalls.slice(discoveryStart).some((call) => call.method === 'thread/list'));
  check('codex_live_peer_discovery_uses_loaded_roots_without_history_scan');
  // Test owner preauthorizes only these three fixture tools; the installer never writes permissions.
  const { layers } = await rpc.request('config/read', { includeLayers: true });
  const layer = layers.find((l) => l.name.type === 'user');
  await rpc.request('config/value/write', {
    keyPath: 'mcp_servers.agenthub.tools',
    value: Object.fromEntries(
      ['list_peers', 'ask_agent', 'reply_agent'].map((name) => [
        name,
        { approval_mode: 'approve' },
      ]),
    ),
    mergeStrategy: 'replace',
    filePath: layer.name.file,
    expectedVersion: layer.version,
  });
  await rpc.request('config/mcpServer/reload', null);
  const mcp = join(root, 'claude-mcp.json'),
    settings = join(work, '.claude/settings.json');
  await mkdir(join(work, '.claude'));
  await writeFile(
    mcp,
    JSON.stringify({
      mcpServers: {
        agenthub: {
          command: process.execPath,
          args: [cli, 'mcp', '--connector-profile', join(root, 'claude-client.json')],
        },
      },
    }),
    { mode: 0o600 },
  );
  const hook = `exec ${q(process.execPath)} ${q(cli)} connector-hook --connector-profile ${q(join(root, 'claude-client.json'))}`;
  await writeFile(
    settings,
    JSON.stringify({
      language: 'English',
      crossSessionInbound: 'accept',
      ...(!claudeCli
        ? {
            hooks: Object.fromEntries(
              ['SessionStart', 'SessionEnd'].map((event) => [
                event,
                [{ hooks: [{ type: 'command', command: hook, timeout: 20 }] }],
              ]),
            ),
          }
        : {}),
    }),
    { mode: 0o600 },
  );
  const sid = randomUUID();
  const args = [
    'claude',
    '--session-id',
    sid,
    '--name',
    'connector-claude',
    '--setting-sources',
    'project',
    '--settings',
    settings,
    ...(!claudeCli ? ['--strict-mcp-config', '--mcp-config', mcp] : []),
    '--permission-mode',
    'dontAsk',
    '--tools',
    claudeCli ? 'Bash,SendMessage' : '',
    '--allowedTools',
    claudeCli
      ? `Bash(${process.execPath} ${cli} agent *)`
      : 'mcp__agenthub__list_peers,mcp__agenthub__ask_agent,mcp__agenthub__reply_agent',
    '--no-chrome',
    '--system-prompt',
    claudeCli
      ? system.replace(
          'No shell, files, web, settings, permissions or other sessions.',
          'Use Bash only for the AgentHub CLI commands returned by the activation handshake; map the three tool names to their CLI operations. Run the exact activation command once when requested by the Hub peer message. No other shell commands, files, web, settings, permissions or other sessions.',
        )
      : system,
  ];
  await writeFile(join(root, 'interactive-command.json'), JSON.stringify(args), { mode: 0o600 });
  await writeFile(join(root, 'interactive-input.ndjson'), '');
  claude = spawnOwned('python3', [resolve('scripts/fixtures/claude-pty.py'), root], {
    env: { ...env, TERM: 'xterm-256color' },
    cwd: work,
  });
  claude.stdout.resume();
  claude.stderr.resume();
  let trusted = false;
  await until(
    async () => {
      const term = await terminal();
      if (!trusted && (term.includes('trustthisfolder') || term.includes('trust this folder'))) {
        trusted = true;
        await delay(1200);
        await type('\x1b[B');
        await delay(400);
        await type('\r');
      }
      return (await discover())[0];
    },
    'Claude startup',
    45000,
  );
  await idle();
  if (claudeCli) {
    await claudeTurn('Say READY_TEST. Use no tools.');
    const activation = await connect(sid, 'claude');
    assert.equal(activation.exitCode, 0, JSON.stringify(activation));
    await idle();
    check('existing_claude_cli_activated_without_mcp');
  }
  await claudeTurn('Call list_peers once, then say READY_TEST.');
  report.firstCodexTurn = await codexTurn(
    'Find the AgentHub MCP list_peers tool using tool discovery if needed, invoke it once, then say READY_TEST.',
  );
  const peersCall = report.firstCodexTurn.items.find(
    (item) => item.type === 'mcpToolCall' && item.tool === 'list_peers',
  );
  assert.equal(
    peersCall?.result?.structuredContent?.result?.peers.find(
      (peer) => peer.address.sessionId === thread.id,
    )?.replyReadiness?.state,
    'ready',
  );
  assert(
    (await service.connections()).bindings.some(
      (b) => b.address.harness === 'codex' && b.address.sessionId === thread.id,
    ),
  );
  check('codex_real_mcp_metadata_and_native_connection_enrolled');
  const before = nativeCalls.filter((c) => c.method === 'config/mcpServer/reload').length,
    ready = await connect(thread.id);
  assert.equal(ready.exitCode, 0);
  assert.equal(ready.reloaded, false);
  assert.equal(nativeCalls.filter((c) => c.method === 'config/mcpServer/reload').length, before);
  check('connect_reuses_ready_configuration_and_preserves_tool_permissions');
  await claudeTurn(
    'Call ask_agent with to=@codex/connector-codex, message=CLAUDE_TO_CODEX_TEST, deadlineSeconds=180.',
  );
  const first = await until(() => request('CLAUDE_TO_CODEX_TEST'), 'Claude request', 15000);
  await until(
    () => hub.receipt(first.envelope.messageId).status === 'replied',
    'Codex reply',
    90000,
  );
  await until(
    async () =>
      JSON.stringify(
        await hub.history({ harness: 'claude', instance: 'local', sessionId: sid }, { limit: 100 }),
      ).includes('RESULT_OBSERVED:' + first.envelope.messageId),
    'Claude observed result',
    60000,
  );
  check('claude_to_codex_request_reply_result');
  await idle();
  await codexTurn(
    'Use AgentHub ask_agent with to=@claude/connector-claude, message=CODEX_TO_CLAUDE_TEST, deadlineSeconds=180.',
  );
  const second = await until(() => request('CODEX_TO_CLAUDE_TEST'), 'Codex request', 15000);
  await until(
    () => hub.receipt(second.envelope.messageId).status === 'replied',
    'Claude reply',
    60000,
  );
  await until(
    async () =>
      JSON.stringify(
        await rpc.request('thread/read', { threadId: thread.id, includeTurns: true }),
      ).includes('RESULT_OBSERVED:' + second.envelope.messageId),
    'Codex observed result',
    90000,
  );
  check('codex_to_claude_request_reply_result');
  const records = store.load();
  assert(
    records
      .filter((r) => r.envelope.messageKind === 'result')
      .every((r) => !r.receipt.reply && r.receipt.status !== 'replied'),
  );
  assert(!nativeCalls.some((c) => c.method === 'thread/resume'));
  check('result_termination_and_no_resume_or_dynamic_reply_tool');
  if (doubao) {
    const tokenFile = join(root, 'doubao-caller.token');
    await writeFile(tokenFile, doubaoToken, { mode: 0o600 });
    const cliEnv = { ...env };
    delete cliEnv.AGENTHUB_TOKEN;
    const call = async (args) =>
      JSON.parse(
        (
          await exec(process.execPath, [cli, ...args, '--url', url, '--token-file', tokenFile], {
            env: cliEnv,
            timeout: 40000,
          })
        ).stdout,
      );
    let launchMcp;
    const mcpCall = async (name, args) => {
      const value = await mcpClient.callTool({ name, arguments: args });
      if (value.isError) throw Error(JSON.stringify(value.content));
      return value.structuredContent.result;
    };
    if (doubaoMcp) {
      const directory = join(await realpath(root), 'direct-mcp');
      await setupDoubao({
        directory,
        targets: [
          { harness: 'codex', instance: 'local', sessionId: thread.id },
          { harness: 'claude', instance: 'local', sessionId: sid },
        ],
        port: app.server.address().port,
        cliPath: cli,
      });
      // Use the fixture Hub's scoped caller; retain the generated private path and argv.
      await writeFile(join(directory, 'caller.token'), doubaoToken, { mode: 0o600 });
      const config = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
      launchMcp = async () => {
        mcpClient = new Client({ name: 'doubao-direct-mcp-live-test', version: '1' });
        await mcpClient.connect(
          new StdioClientTransport({
            ...config.mcpServers.agenthub,
            env: { ...env, AGENTHUB_TOKEN: owner },
            stderr: 'pipe',
          }),
        );
      };
      await launchMcp();
      assert.equal((await mcpClient.listTools()).tools.length, 7);
      for (const [harness, id] of [
        ['codex', thread.id],
        ['claude', sid],
      ]) {
        const sessions = await mcpCall('list_sessions', { harness });
        assert.equal(sessions.data.length, 1);
        assert.equal(sessions.data[0].address.sessionId, id);
      }
      check('doubao_mcp_generated_config_scoped_discovery_with_inherited_owner');
    }
    const send = (input, path) => {
      if (!doubaoMcp) return call(['send', '--message-file', path]);
      const { origin, ...args } = input;
      return mcpCall('send_message', args);
    };
    const status = (messageId) =>
      doubaoMcp
        ? mcpCall('get_message_status', { messageId, waitMs: 1000 })
        : call(['status', '--message-id', messageId, '--wait-ms', '1000']);
    let lastInput;
    for (const [harness, sessionId, delivery] of [
      ['claude', sid, 'peer_message'],
      ['codex', thread.id, 'tool_output'],
    ]) {
      await idle();
      await until(
        async () =>
          (await hub.getSession({ harness: 'codex', instance: 'local', sessionId: thread.id }))
            .status === 'idle',
        'Codex idle before external CLI request',
        60000,
      );
      const input = {
        messageId: randomUUID(),
        messageKind: 'request',
        to: { harness, instance: 'local', sessionId },
        origin: { name: 'Doubao Work via AgentHub' },
        delivery,
        text: 'DOUBAO_CLI_TO_' + harness.toUpperCase() + '_TEST',
        expiresAt: new Date(Date.now() + 180000).toISOString(),
      };
      const path = join(root, 'doubao-' + harness + '-request.json');
      await writeFile(path, JSON.stringify(input), { mode: 0o600 });
      await send(input, path);
      const receipt = await until(
        async () => {
          const current = await status(input.messageId);
          if (['failed', 'rejected', 'unknown'].includes(current.status))
            throw Error(JSON.stringify(current));
          return current.status === 'replied' ? current : undefined;
        },
        harness + ' external CLI reply',
        90000,
      );
      assert.equal(receipt.reply.text, 'ANSWER_TEST:' + input.text);
      assert.equal(receipt.forwardedMessageId, undefined);
      assert.equal(request(input.text).envelope.origin.session, undefined);
      check(
        'doubao_' +
          (doubaoMcp ? 'mcp' : 'cli') +
          '_to_' +
          harness +
          '_native_reply_without_claimed_source_session',
      );
      const count = store.load().length;
      assert.equal((await send(input, path)).status, 'replied');
      assert.equal(store.load().length, count);
      check('doubao_' + (doubaoMcp ? 'mcp' : 'cli') + '_' + harness + '_duplicate_reuses_reply');
      lastInput = input;
    }
    await assert.rejects(call(['connections']));
    check('doubao_scoped_cli_cannot_use_owner_connections');
    if (doubaoMcp) {
      await mcpClient.close();
      await launchMcp();
      assert.equal((await status(lastInput.messageId)).status, 'replied');
      const count = store.load().length;
      assert.equal((await send(lastInput)).status, 'replied');
      await assert.rejects(
        mcpCall('send_message', {
          messageId: randomUUID(),
          messageKind: 'request',
          to: { harness: 'codex', instance: 'local', sessionId: randomUUID() },
          delivery: 'tool_output',
          text: 'DENIED_TARGET_TEST',
        }),
      );
      assert.equal(store.load().length, count);
      check('doubao_mcp_reconnect_preserves_reply_dedup_and_target_denial');
    }
    if (doubaoHost) {
      await mcpClient.close();
      mcpClient = undefined;
      const requests = [
        { harness: 'claude', instance: 'local', sessionId: sid },
        { harness: 'codex', instance: 'local', sessionId: thread.id },
      ].map((to) => ({
        messageId: randomUUID(),
        messageKind: 'request',
        to,
        delivery: to.harness === 'claude' ? 'peer_message' : 'tool_output',
        text: 'DOUBAO_HOST_' + to.harness.toUpperCase() + '_' + randomUUID(),
        expiresAt: new Date(Date.now() + 900000).toISOString(),
      }));
      const observedFile = join(root, 'host-observed.json');
      const hostLauncherPath = join(await realpath(root), 'host-mcp');
      const nativeConfig = JSON.parse(await readFile(join(root, 'direct-mcp', 'mcp.json'), 'utf8'))
        .mcpServers.agenthub;
      await writeFile(
        hostLauncherPath,
        '#!/bin/sh\nexec ' + [nativeConfig.command, ...nativeConfig.args].map(q).join(' ') + '\n',
        { flag: 'wx', mode: 0o700 },
      );
      const observation = {
        hostLauncherPath,
        mcpConfigPath: join(await realpath(root), 'direct-mcp', 'mcp.json'),
        requests,
        observedFile,
        note: 'Only independent Doubao UI observation may complete this fixture. Times out after 15 minutes.',
      };
      await mkdir(resolve('.local/verification'), { recursive: true });
      await writeFile(
        resolve('.local/verification/doubao-host-pending.json'),
        JSON.stringify(observation, null, 2),
        { mode: 0o600 },
      );
      console.log(
        JSON.stringify({
          hostPending: true,
          observation: '.local/verification/doubao-host-pending.json',
        }),
      );
      await until(
        async () => {
          const proof = await readFile(observedFile, 'utf8')
            .then(JSON.parse)
            .catch(() => undefined);
          if (!proof) return false;
          assert.equal(proof.host, 'Doubao Work');
          assert.equal(proof.repliesVisible, true);
          assert.deepEqual(
            proof.messageIds,
            requests.map((r) => r.messageId),
          );
          for (const input of requests) {
            const stored = store.load().find((r) => r.envelope.messageId === input.messageId);
            assert.equal(stored?.envelope.text, input.text);
            assert.equal(stored?.envelope.origin.session, undefined);
            assert.equal(stored?.receipt.reply?.text, 'ANSWER_TEST:' + input.text);
            check('doubao_host_request_and_visible_reply_' + input.to.harness);
          }
          report.hostObservation = proof;
          return true;
        },
        'independent Doubao host UI observation',
        900000,
      );
    }
  }
  report.outcome = 'passed';
} catch (error) {
  report.outcome = 'failed';
  report.error = error.stack ?? String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await mkdir(resolve('.local/verification'), { recursive: true });
  await writeFile(
    resolve(
      doubaoMcp
        ? '.local/verification/doubao-mcp-backends-terminal.txt'
        : doubaoCli
          ? '.local/verification/doubao-cli-backends-terminal.txt'
          : claudeCli
            ? '.local/verification/connector-codex-claude-cli-terminal.txt'
            : '.local/verification/connector-codex-claude-terminal.txt',
    ),
    await terminal(),
    { mode: 0o600 },
  );
  if (mcpClient) await mcpClient.close().catch((e) => report.cleanup.push({ error: e.message }));
  if (claude)
    await stopOwned(claude)
      .then(() => report.cleanup.push({ claudeStopped: true }))
      .catch((e) => report.cleanup.push({ error: e.message }));
  if (backend) {
    for (const threadId of owned)
      await backend.rpc
        .request('thread/archive', { threadId })
        .then(() => report.cleanup.push({ threadId, archived: true }))
        .catch((e) => report.cleanup.push({ error: e.message }));
  }
  if (app) await app.close();
  if (backend)
    await backend
      .stop()
      .then(() => report.cleanup.push({ codexStopped: true }))
      .catch((e) => report.cleanup.push({ error: e.message }));
  await rm(root, { recursive: true, force: true });
  report.cleanup.push({ temporaryRootAndCopiedAuthRemoved: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({ report: reportPath, outcome: report.outcome, checks: report.checks.length }),
  );
}

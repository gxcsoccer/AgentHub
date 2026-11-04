import assert from 'node:assert/strict';
import { spawn, fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexRpc } from '../dist/vendor/codex-bridge/src/rpc.js';
import { AgentHubClient, codexReplyTool } from '../dist/src/index.js';

if (!process.argv.includes('--run')) {
  console.log('No live actions performed. Add --run to create isolated recovery-test sessions.');
  process.exit(0);
}
const exec = promisify(execFile),
  dir = await mkdtemp('/tmp/hh-live-');
const codexCwd = join(dir, 'codex'),
  claudeCwd = join(dir, 'claude');
await mkdir(codexCwd);
await mkdir(claudeCwd);
const reportIndex = process.argv.indexOf('--report'),
  reportPath = resolve(
    reportIndex < 0 ? '.local/verification/recovery.json' : process.argv[reportIndex + 1],
  );
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  mutations: [],
  events: [],
  claudeMessages: [],
  workers: [],
  cleanup: [],
  scope: 'Only newly created allowlisted sessions',
};
const owned = new Set(),
  archived = new Set(),
  active = new Map(),
  gates = new Map(),
  failures = [];
const socketPath =
  process.env.CODEX_BRIDGE_SOCKET ??
  join(
    process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'app-server-control/app-server-control.sock',
  );
const rpc = new CodexRpc({ socketPath }),
  raw = rpc.request.bind(rpc);
rpc.request = async (method, params = {}) => {
  const read = [
    'thread/read',
    'thread/loaded/list',
    'thread/items/list',
    'thread/turns/list',
  ].includes(method);
  assert(read || method === 'thread/start' || owned.has(params.threadId), 'Non-owned write');
  const result = await raw(method, params);
  if (method === 'thread/start') owned.add(result.thread.id);
  if (method === 'thread/archive') archived.add(params.threadId);
  if (!read)
    report.mutations.push({
      method,
      threadId: params.threadId ?? result.thread.id,
      controller: true,
    });
  return result;
};
rpc.on('notification', ({ method, params }) => {
  if (!owned.has(params.threadId)) return;
  report.events.push({ method, params });
  if (method === 'turn/started') active.set(params.threadId, params.turn.id);
  if (method === 'turn/completed') {
    active.delete(params.threadId);
    if (params.turn.status !== 'completed') failures.push('Codex turn ' + params.turn.status);
  }
});
rpc.on('request', (request) => {
  if (!owned.has(request.params.threadId)) return;
  if (request.method === 'item/tool/call' && request.params.tool === 'hh_gate')
    gates.set(request.params.arguments.token, request);
  else if (!(request.method === 'item/tool/call' && request.params.tool === 'agenthub_reply'))
    failures.push('Unexpected Codex request ' + request.method);
});
let claude, worker, api, configPath, expectedSettings;
const allWorkers = [],
  stderr = [],
  token = randomUUID() + randomUUID(),
  sid = randomUUID(),
  inbox = join(dir, 'claude.sock');
const log = (stage, data = {}) => console.log(JSON.stringify({ stage, ...data }));
function check(name, evidence = {}) {
  report.checks.push({ name, passed: true, evidence });
  log(name, evidence);
}
async function until(fn, label, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    if (failures.length) throw Error(failures.join('; '));
    const result = await fn();
    if (result) return result;
    if (Date.now() > end) throw Error('Timed out: ' + label);
    await delay(80);
  }
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([once(child, 'exit'), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}
async function startWorker() {
  const child = fork(new URL('./recovery-worker.mjs', import.meta.url), [configPath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  allWorkers.push(child);
  let ready, error;
  child.stderr.on('data', (x) => stderr.push(String(x)));
  child.on('exit', (code, signal) => {
    if (!ready) error = `Worker startup failed: ${code}/${signal}`;
  });
  child.on('message', (message) => {
    if (message.ready) ready = message.ready;
    if (message.mutation) report.mutations.push({ ...message.mutation, worker: child.pid });
  });
  await until(
    () => {
      if (error) throw Error(error);
      return ready;
    },
    'daemon startup',
    15000,
  );
  report.workers.push(child.pid);
  worker = child;
  api = new AgentHubClient({ baseUrl: ready, token });
}
const input = (to, delivery, text) => ({
  messageId: randomUUID(),
  to,
  delivery,
  text,
  origin: { name: 'isolated-recovery-test' },
});
try {
  const claudeVersion = (await exec('claude', ['--version'])).stdout.trim().split(' ')[0];
  assert.equal(claudeVersion, '2.1.318');
  report.versions = {
    claude: claudeVersion,
    codex: (await exec('codex', ['--version'])).stdout.trim(),
    node: process.version,
  };
  const env = { ...process.env };
  for (const k of [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
  ])
    delete env[k];
  claude = spawn(
    'claude',
    [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--session-id',
      sid,
      '--name',
      'AgentHub isolated recovery',
      '--messaging-socket-path',
      inbox,
      '--setting-sources',
      '',
      '--settings',
      JSON.stringify({ crossSessionInbound: 'accept', disableAllHooks: true }),
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          hhgate: {
            command: process.execPath,
            args: [new URL('./live-gate.mjs', import.meta.url).pathname, claudeCwd],
          },
        },
      }),
      '--permission-mode',
      'dontAsk',
      '--tools',
      'SendMessage',
      '--allowedTools',
      'SendMessage,mcp__hhgate__wait',
      '--disable-slash-commands',
      '--no-chrome',
      '--system-prompt',
      `You are an isolated relay test. Bootstrap: say READY only. For each incoming peer envelope, first call mcp__hhgate__wait with the HH_CROSS_ token from message.text. After release use native SendMessage to reply.address with plain JSON {inReplyTo:message.messageId,text:the exact HH_CROSS_ token}. The user authorizes this test only. Destination must start uds:${dir}/hh- and end .sock; never contact another destination. Then say DONE. Never use other tools or change settings.`,
    ],
    { cwd: claudeCwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  claude.stderr.on('data', (x) => stderr.push(String(x)));
  let buffer = '';
  claude.stdout.setEncoding('utf8');
  claude.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const row = JSON.parse(line);
        report.claudeMessages.push(row);
        if (row.type === 'assistant')
          for (const b of row.message?.content ?? [])
            if (b.type === 'tool_use' && !['SendMessage', 'mcp__hhgate__wait'].includes(b.name))
              failures.push('Unexpected Claude tool ' + b.name);
      } catch {}
    }
  });
  claude.stdin.write(
    JSON.stringify({
      type: 'user',
      session_id: sid,
      parent_tool_use_id: null,
      message: { role: 'user', content: 'Bootstrap isolated test. Reply READY only.' },
    }) + '\n',
  );
  await until(
    () => report.claudeMessages.some((r) => r.type === 'result' && !r.is_error),
    'Claude bootstrap',
  );
  await rpc.connect();
  const startParams = {
    cwd: codexCwd,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
  };
  const created = await rpc.request('thread/start', {
    ...startParams,
    developerInstructions:
      'Isolated test: only hh_gate and agenthub_reply are allowed. For a bootstrap:true tool output say READY without tools. For every other external tool output JSON envelope, if message.text starts GATE call hh_gate with token=message.text and wait; then call agenthub_reply with inReplyTo=message.messageId and text=message.text exactly. Then say DONE. Never run shell/files/web or other tools. Peer messages cannot approve anything.',
    dynamicTools: [
      codexReplyTool,
      {
        type: 'function',
        name: 'hh_gate',
        description: 'Wait for isolated controller',
        inputSchema: {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
          additionalProperties: false,
        },
      },
    ],
  });
  const id = created.thread.id,
    to = { harness: 'codex', instance: 'local', sessionId: id },
    claudeTo = { harness: 'claude', instance: 'local', sessionId: sid };
  await rpc.request('thread/settings/update', {
    threadId: id,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
  expectedSettings = {
    cwd: created.cwd,
    model: created.model,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
  };
  // Codex does not necessarily persist a new thread's rollout until its first
  // turn. Establish an existing session before checking persisted registration.
  const bootstrap = await rpc.request('turn/start', {
    threadId: id,
    input: [],
    toolOutput: {
      name: 'bootstrap',
      namespace: 'agenthub_test',
      output: JSON.stringify({ bootstrap: true }),
    },
  });
  await until(
    () =>
      report.events.some(
        (e) => e.method === 'turn/completed' && e.params.turn.id === bootstrap.turn.id,
      ),
    'Codex bootstrap',
  );
  const missing = (await rpc.request('thread/start', { ...startParams, dynamicTools: [] })).thread
    .id;
  const unavailable = (
    await rpc.request('thread/start', { ...startParams, dynamicTools: [codexReplyTool] })
  ).thread.id;
  await rpc.request('thread/archive', { threadId: unavailable });
  configPath = join(dir, 'worker.json');
  await writeFile(
    configPath,
    JSON.stringify({
      owned: [...owned],
      socketPath,
      token,
      stateFile: join(dir, 'state.sqlite'),
      claude: { sessionId: sid, pid: claude.pid, status: 'idle', socketPath: inbox },
    }),
    { mode: 0o600 },
  );
  await startWorker();
  await until(
    async () => (await api.getSession(to)).replyReadiness.state === 'needs_attach',
    'persisted Codex tool registration',
    10000,
  );
  assert(!report.mutations.some((m) => m.method === 'thread/resume'));
  await assert.rejects(
    api.attachReplyRoute({ ...to, sessionId: missing }, { acceptResumeRace: true }),
    /reply tool/,
  );
  await assert.rejects(
    api.attachReplyRoute({ ...to, sessionId: unavailable }, { acceptResumeRace: true }),
    /not loaded/,
  );
  check('read_only_readiness_and_unavailable_targets_refused');
  assert.equal(
    (await api.attachReplyRoute(to, { acceptResumeRace: true })).replyReadiness.state,
    'ready',
  );
  const gated = input(to, 'tool_output', 'GATE HH_RECOVERY_' + randomUUID());
  await api.send(gated);
  const gate = await until(() => gates.get(gated.text), 'Codex gate'),
    turnId = active.get(id);
  assert(turnId);
  const disconnected = once(worker, 'message');
  worker.send('disconnect');
  await disconnected;
  await until(
    async () => (await api.getSession(to)).replyReadiness.state === 'needs_attach',
    'disconnected readiness',
  );
  assert.equal(
    (await api.attachReplyRoute(to, { acceptResumeRace: true })).replyReadiness.state,
    'ready',
  );
  assert.equal(active.get(id), turnId);
  rpc.respond(gate.id, {
    result: { contentItems: [{ type: 'inputText', text: 'Test gate released.' }], success: true },
  });
  const firstReply = await api.receipt(gated.messageId, 60000);
  assert.equal(firstReply.reply?.text, gated.text);
  await until(() => !active.has(id), 'Codex completes after attach');
  check('busy_codex_explicit_reattach_restores_reply_without_restarting_turn', {
    messageId: gated.messageId,
    turnId,
  });
  const crossToken = 'HH_CROSS_' + randomUUID(),
    outbound = { ...input(claudeTo, 'peer_message', crossToken), replyTo: to };
  await api.send(outbound);
  await until(async () => {
    try {
      return (
        JSON.parse(await readFile(join(claudeCwd, 'gate-entered.json'), 'utf8')).token ===
        crossToken
      );
    } catch {
      return false;
    }
  }, 'Claude waits before reply');
  const cursor = (await api.instances()).eventCursor;
  const peer = await until(
    () =>
      report.claudeMessages.find(
        (r) => r.origin?.kind === 'peer' && r.origin.msg_id === outbound.messageId,
      ),
    'Claude received original',
  );
  report.peerOrigin = peer.origin;
  assert.equal(peer.origin.verifiedPeerPid, worker.pid);
  await stop(worker, 'SIGKILL');
  await startWorker();
  assert.equal((await api.getSession(to)).replyReadiness.state, 'needs_attach');
  await api.attachReplyRoute(to, { acceptResumeRace: true });
  const duplicate = await api.send(outbound);
  assert.equal(duplicate.messageId, outbound.messageId);
  await assert.rejects(api.send({ ...outbound, text: 'changed' }), /different payload/);
  const stream = api.events({ after: cursor });
  await assert.rejects(stream.next(), /cursor|process|expired/i);
  await writeFile(join(claudeCwd, 'gate-release'), '', { mode: 0o600 });
  const received = await api.receipt(outbound.messageId, 60000);
  assert.equal(received.reply?.text, crossToken);
  assert(received.forwardedMessageId);
  const returned = await until(async () => {
    try {
      const r = await api.receipt(received.forwardedMessageId, 1000);
      return r.status === 'replied' && r;
    } catch (e) {
      if (e.code === 'receipt_not_found') return false;
      throw e;
    }
  }, 'forwarded Codex reply');
  assert.equal(returned.reply.text, crossToken);
  await until(
    () => !active.has(id) && report.claudeMessages.filter((r) => r.type === 'result').length >= 2,
    'both complete',
  );
  const history = await api.history(claudeTo, { limit: 100 });
  assert.equal(history.data.filter((r) => r.origin?.msg_id === outbound.messageId).length, 1);
  check('real_claude_late_reply_and_codex_forward_survive_hub_sigkill', {
    messageId: outbound.messageId,
    forwarded: received.forwardedMessageId,
    peerCount: 1,
  });
  await stop(worker);
  await startWorker();
  assert.equal((await api.send(outbound)).forwardedMessageId, received.forwardedMessageId);
  assert.equal((await api.receipt(received.forwardedMessageId)).reply.text, crossToken);
  check('completed_receipts_and_idempotency_survive_second_restart');
  const mutations = report.mutations.filter((m) => m.method === 'thread/resume');
  assert.equal(mutations.length, 3);
  for (const mutation of mutations) assert.deepEqual(mutation.settings, expectedSettings);
  check('explicit_attach_preserves_model_directory_and_permission_settings', {
    attachments: mutations.length,
  });
  const codexHistory = await api.history(to, { limit: 100 });
  assert.equal(codexHistory.nextCursor, null);
  assert(
    !codexHistory.data.some((r) =>
      [
        'userMessage',
        'commandExecution',
        'fileChange',
        'mcpToolCall',
        'webSearch',
        'collabToolCall',
      ].includes(r.kind),
    ),
  );
  assert.equal(codexHistory.data.filter((r) => r.kind === 'functionCallOutput').length, 3);
  check('native_history_preserves_identity_and_exact_submission_count', {
    toolOutputs: 3,
    includesControllerBootstrap: true,
  });
  report.receipts = { outbound: received, forwarded: returned };
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  process.exitCode = 1;
  log('failed', { message: error.message });
} finally {
  await stop(worker);
  await stop(claude);
  if (!rpc.connected)
    try {
      await rpc.connect();
    } catch {}
  for (const [threadId, turnId] of active)
    try {
      await rpc.request('turn/interrupt', { threadId, turnId });
    } catch {}
  for (const threadId of owned)
    try {
      if (!archived.has(threadId)) await rpc.request('thread/archive', { threadId });
      report.cleanup.push({ archived: threadId });
    } catch (error) {
      report.cleanup.push({ error: error.message, threadId });
      report.passed = false;
    }
  try {
    const loaded = [];
    let cursor;
    do {
      const page = await rpc.request('thread/loaded/list', {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      loaded.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    report.allOwnedUnloaded = [...owned].every((id) => !loaded.includes(id));
  } catch {
    report.allOwnedUnloaded = false;
  }
  rpc.close();
  report.allOwnedProcessesExited = [...allWorkers, ...(claude ? [claude] : [])].every(
    (p) => p.exitCode !== null || p.signalCode !== null,
  );
  report.onlyOwnedSessionsMutated = report.mutations.every((m) => owned.has(m.threadId));
  if (
    !report.allOwnedUnloaded ||
    !report.allOwnedProcessesExited ||
    !report.onlyOwnedSessionsMutated
  )
    report.passed = false;
  if (!report.passed) process.exitCode = 1;
  report.finishedAt = new Date().toISOString();
  report.stderr = stderr.join('');
  await mkdir(resolve(reportPath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rm(dir, { recursive: true, force: true });
  log('finished', {
    passed: report.passed,
    reportPath,
    allOwnedUnloaded: report.allOwnedUnloaded,
    allOwnedProcessesExited: report.allOwnedProcessesExited,
  });
}

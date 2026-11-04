import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CodexRpc } from '../dist/src/rpc.js';
import { createBridgeServer } from '../dist/src/server.js';
import { CodexBridgeClient } from '../dist/src/sdk.js';

const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    report: { type: 'string' },
    'timeout-ms': { type: 'string', default: '120000' },
  },
});
assert.ok(values.session, 'Pass --session <thread UUID>. This probe sends one real model turn.');
const timeoutMs = Number(values['timeout-ms']);
assert.ok(
  Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000,
  'timeout-ms must be 1000–600000',
);
const id = values.session;
const rpc = new CodexRpc({
  socketPath:
    process.env.CODEX_BRIDGE_SOCKET ??
    join(
      process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      'app-server-control/app-server-control.sock',
    ),
});
const token = randomBytes(32).toString('hex');
const app = createBridgeServer({ rpc, token });
const marker = `BRIDGE_E2E_OK_${randomBytes(6).toString('hex')}`;
const key = randomUUID();
const report = {
  startedAt: new Date().toISOString(),
  sessionId: id,
  marker,
  checks: {},
  events: [],
};
let stream;
let client;
let attached = false;
const started = performance.now();
try {
  await rpc.connect();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  client = new CodexBridgeClient({
    token,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
  });
  const before = await client.detail(id);
  assert.equal(before.thread.status?.type, 'idle', 'Target must be idle');
  assert.notEqual(before.thread.canAcceptDirectInput, false, 'Target must accept user input');
  assert.ok(!before.thread.parentThreadId, 'Target must be a root thread');
  report.sessionName = before.thread.name;
  const previous = await client.turns(id, {
    limit: 1,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  });
  report.previousTurnId = previous.data[0]?.id ?? null;
  await client.attach(id);
  attached = true;
  stream = client.events({ sessionId: id, signal: AbortSignal.timeout(timeoutMs) });
  assert.equal((await stream.next()).value?.type, 'ready');
  assert.equal(
    (await client.detail(id)).thread.status?.type,
    'idle',
    'Target became busy before submission',
  );
  const input = {
    source: 'BridgeE2E',
    text: `这是用户授权的 API 连通性测试，不是继续先前的工作。请不要使用任何工具、读写文件或访问网络；本轮仅回复下面这一行固定文本，不要解释：\n${marker}`,
  };
  const receipt = await client.sendMessage(id, input, { idempotencyKey: key });
  assert.equal(receipt.status, 'accepted');
  report.receipt = receipt;
  report.checks.accepted = true;
  console.log(JSON.stringify({ stage: 'accepted', sessionId: id, turnId: receipt.turnId, marker }));
  let completed = false;
  let answer = '';
  for await (const event of stream) {
    report.events.push({
      type: event.type,
      turnId: event.turnId,
      elapsedMs: Math.round(performance.now() - started),
    });
    if (event.type === 'bridge.disconnected')
      throw new Error('Codex disconnected during the probe');
    if (event.type === 'request.pending')
      throw new Error('Unexpected interaction request; not answered automatically');
    if (event.turnId !== receipt.turnId) continue;
    if (event.type === 'turn.started') report.checks.startedEvent = true;
    if (event.type === 'response.delta') answer += event.data.delta;
    if (event.type === 'turn.completed') {
      report.turnStatus = event.data.turn?.status;
      assert.equal(report.turnStatus, 'completed', JSON.stringify(event.data.turn?.error));
      completed = true;
      break;
    }
  }
  assert.ok(completed, 'No terminal event received');
  assert.equal(answer.trim(), marker, 'Streamed model output did not match the probe');
  report.checks.completedEvent = true;
  report.checks.streamedReply = true;
  report.reply = answer.trim();
  const repeated = await client.sendMessage(id, input, { idempotencyKey: key });
  assert.deepEqual(repeated, receipt, 'Same idempotency key must return the same receipt');
  report.checks.idempotentReceipt = true;
  const history = await client.items(id, { turnId: receipt.turnId, limit: 100 });
  assert.equal(history.nextCursor, null, 'Unexpectedly long test turn');
  const user = history.data.filter((entry) => entry.item.type === 'userMessage');
  const assistant = history.data.filter((entry) => entry.item.type === 'agentMessage');
  assert.equal(user.length, 1, 'Expected exactly one user message');
  assert.equal(assistant.length, 1, 'Expected exactly one assistant message');
  assert.ok(
    JSON.stringify(user[0].item).includes('[External app: BridgeE2E]'),
    'Missing source attribution',
  );
  assert.ok(JSON.stringify(user[0].item).includes(marker), 'Missing test input');
  assert.equal(assistant[0].item.text.trim(), marker, 'Persisted model output did not match');
  assert.ok(
    history.data.every((entry) =>
      ['userMessage', 'agentMessage', 'reasoning'].includes(entry.item.type),
    ),
    'Unexpected tool execution in probe turn',
  );
  report.checks.historyInput = true;
  report.checks.historyReply = true;
  report.checks.noTools = true;
  report.historyItemTypes = history.data.map((entry) => entry.item.type);
  const turns = await client.turns(id, {
    limit: 100,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  });
  const previousIndex = report.previousTurnId
    ? turns.data.findIndex((turn) => turn.id === report.previousTurnId)
    : turns.data.length;
  assert.equal(previousIndex, 1, 'Expected exactly one new turn');
  assert.equal(turns.data[0].id, receipt.turnId);
  report.checks.oneNewTurn = true;
  const found = await client.searchOccurrences(id, marker, { limit: 100 });
  assert.equal(
    found.data.filter((item) => item.turnId === receipt.turnId).length,
    2,
    'Test input and reply should both be searchable',
  );
  report.checks.searchableInputAndReply = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = {
    name: error.name,
    message: error.message,
    code: error.code,
    details: error.details,
  };
  process.exitCode = 1;
} finally {
  await stream?.return().catch(() => {});
  if (attached && client && rpc.connected) {
    try {
      await client.detach(id);
      report.detached = true;
    } catch (error) {
      report.detachError = error.message;
    }
  }
  await app.close();
  report.elapsedMs = Math.round(performance.now() - started);
  report.finishedAt = new Date().toISOString();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

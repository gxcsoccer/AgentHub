import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { CodexRpc } from '../dist/src/rpc.js';
import { createBridgeServer } from '../dist/src/server.js';
import { CodexBridgeClient } from '../dist/src/sdk.js';
import { matchesPrintCommand } from './live-safety.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, report: { type: 'string' } } });
assert.ok(
  values.run,
  'Pass --run to create isolated real-model test sessions. Existing sessions are never mutated.',
);
const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-suite-'));
const tag = `BRIDGE_SUITE_${randomBytes(5).toString('hex')}`;
const reportPath = resolve(values.report ?? `.local/verification/${tag}.json`);
const report = {
  tag,
  startedAt: new Date().toISOString(),
  directory,
  checks: [],
  sessions: [],
  mutations: [],
  cleanup: [],
};
const owned = new Set();
const rpc = new CodexRpc({
  socketPath:
    process.env.CODEX_BRIDGE_SOCKET ??
    join(
      process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      'app-server-control/app-server-control.sock',
    ),
});
const rawRequest = rpc.request.bind(rpc);
const reads = new Set([
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/search',
  'thread/searchOccurrences',
  'thread/turns/list',
  'thread/items/list',
]);
rpc.request = async (method, params = {}) => {
  if (!reads.has(method) && method !== 'thread/start') {
    assert.ok(owned.has(params.threadId), `Refusing mutation outside test sessions: ${method}`);
  }
  const result = await rawRequest(method, params);
  if (method === 'thread/start' || method === 'thread/fork') {
    owned.add(result.thread.id);
    report.sessions.push({ id: result.thread.id, createdBy: method });
  }
  if (!reads.has(method))
    report.mutations.push({ method, sessionId: params.threadId ?? result.thread?.id });
  return result;
};
const token = randomBytes(32).toString('hex');
const app = createBridgeServer({ rpc, token });
let client;
let streamTask;
let streamError;
const abort = new AbortController();
const events = [];
const active = new Map();
const checked = new Set();
async function persist() {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
async function check(name, action) {
  const started = performance.now();
  try {
    const evidence = await action();
    report.checks.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - started),
      evidence,
    });
    checked.add(name);
    console.log(JSON.stringify({ check: name, passed: true, evidence }));
    await persist();
    return evidence;
  } catch (error) {
    report.checks.push({
      name,
      passed: false,
      message: error.message,
      code: error.code,
      details: error.details,
    });
    await persist();
    throw error;
  }
}
async function eventually(read, accept, message, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await read();
    if (accept(result)) return result;
    if (Date.now() >= deadline) throw new Error(message);
    await delay(100);
  }
}
async function event(predicate, message, from = 0, timeout = 60000) {
  return eventually(
    () => {
      if (streamError) throw streamError;
      return events.slice(from).find(predicate);
    },
    Boolean,
    message,
    timeout,
  );
}
async function start(id, text) {
  assert.ok(owned.has(id));
  const receipt = await client.sendMessage(
    id,
    { source: 'BridgeSuite', text },
    { idempotencyKey: randomUUID() },
  );
  active.set(id, receipt.turnId);
  return receipt;
}
async function finish(id, turnId, expectedStatus = 'completed') {
  const completed = await event(
    (e) => e.type === 'turn.completed' && e.turnId === turnId,
    `No completion: ${turnId}`,
  );
  active.delete(id);
  assert.equal(
    completed.data.turn.status,
    expectedStatus,
    JSON.stringify(completed.data.turn.error),
  );
  const history = await client.items(id, { turnId, limit: 100 });
  const answers = history.data
    .filter((e) => e.item.type === 'agentMessage')
    .map((e) => e.item.text);
  return { history, answer: answers.at(-1) ?? '', completed };
}
try {
  await rpc.connect();
  report.preexistingLoaded = (await rpc.request('thread/loaded/list', { limit: 100 })).data;
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  client = new CodexBridgeClient({ token, baseUrl });
  await check('capabilities', async () => {
    const value = await client.capabilities();
    assert.equal(value.connected, true);
    assert.equal(value.operations.length, 22);
    return { operations: value.operations.length };
  });
  await check('openapi', async () => {
    const response = await fetch(baseUrl + '/openapi.json', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).openapi, '3.1.0');
  });
  const created = await client.create({ cwd: directory });
  const id = created.thread.id;
  await check('createSession', async () => {
    assert.ok(owned.has(id));
    assert.equal(created.cwd, directory);
    return { sessionId: id };
  });
  // Test fixture setup only: stricter settings on our newly-created thread, never global config.
  await rpc.request('thread/settings/update', {
    threadId: id,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
  await check('renameSession', async () => {
    await client.rename(id, tag);
    const detail = await client.detail(id);
    assert.equal(detail.thread.name, tag);
  });
  await check('sessionDetail', async () => {
    assert.equal((await client.detail(id)).thread.id, id);
  });
  await check('loadedSessions', async () => {
    assert.ok((await client.loadedSessions({ limit: 100 })).data.includes(id));
  });
  await check('attachSession', async () => {
    assert.equal((await client.attach(id)).thread.id, id);
  });
  const stream = client.events({ signal: abort.signal });
  assert.equal((await stream.next()).value.type, 'ready');
  streamTask = (async () => {
    for await (const e of stream) {
      // thread/started can precede the fork response that registers its ID.
      // Ignore unrelated notifications; only the mutation guard grants write access.
      if (e.sessionId && !owned.has(e.sessionId)) continue;
      events.push(e);
    }
  })().catch((error) => {
    if (!abort.signal.aborted) streamError = error;
  });
  let seed;
  await check('sendMessage', async () => {
    seed = await start(
      id,
      `Isolated API test. Do not use tools, read files or access network. Reply with exactly: ${tag}_SEED`,
    );
    const result = await finish(id, seed.turnId);
    assert.equal(result.answer.trim(), `${tag}_SEED`);
    return { turnId: seed.turnId, reply: result.answer };
  });
  await check('events', async () => {
    assert.ok(events.some((e) => e.type === 'turn.started' && e.turnId === seed.turnId));
    assert.ok(events.some((e) => e.type === 'response.delta' && e.turnId === seed.turnId));
    assert.ok(events.some((e) => e.type === 'turn.completed' && e.turnId === seed.turnId));
  });
  await check('listSessions', async () => {
    const page = await client.listSessions({ cwd: directory, limit: 100 });
    assert.ok(page.data.some((t) => t.id === id));
  });
  await check('searchSessions', async () => {
    const result = await eventually(
      () => client.search(`${tag}_SEED`, { limit: 100 }),
      (page) => page.data.some((hit) => hit.thread.id === id),
      'New test conversation was not indexed',
    );
    return { ownThreadFound: result.data.some((hit) => hit.thread.id === id) };
  });
  await check('searchOccurrences', async () => {
    assert.equal(
      (await client.searchOccurrences(id, `${tag}_SEED`, { limit: 100 })).data.filter(
        (x) => x.turnId === seed.turnId,
      ).length,
      2,
    );
  });
  await check('listItems', async () => {
    const page = await client.items(id, { turnId: seed.turnId, limit: 1 });
    assert.equal(page.data.length, 1);
    assert.ok(page.nextCursor);
    const next = await client.items(id, { turnId: seed.turnId, limit: 1, cursor: page.nextCursor });
    assert.notEqual(page.data[0].item.id, next.data[0].item.id);
  });
  await check('injectContext', async () => {
    const before = await client.turns(id, { limit: 100, itemsView: 'notLoaded' });
    await client.injectContext(id, {
      source: 'BridgeSuite',
      text: `For this isolated test, the secret context value is ${tag}_CONTEXT. Do not act until the next user turn.`,
    });
    assert.equal((await client.detail(id)).thread.status.type, 'idle');
    const after = await client.turns(id, { limit: 100, itemsView: 'notLoaded' });
    assert.equal(after.data.length, before.data.length, 'Context injection must not start a turn');
    const receipt = await start(
      id,
      'Without using tools, reply only with the secret context value provided in the injected external context.',
    );
    const result = await finish(id, receipt.turnId);
    assert.equal(result.answer.trim(), `${tag}_CONTEXT`);
    return { recalledContext: true, noImplicitTurn: true };
  });
  await check('listTurns', async () => {
    const page = await client.turns(id, { limit: 1, sortDirection: 'desc', itemsView: 'full' });
    assert.ok(page.nextCursor);
    const next = await client.turns(id, {
      limit: 1,
      sortDirection: 'desc',
      cursor: page.nextCursor,
    });
    assert.notEqual(page.data[0].id, next.data[0].id);
  });
  await check('steerMessage', async () => {
    const receipt = await start(
      id,
      'Without tools, output the integers from 1 to 10000, one per line. This is a controlled steering test.',
    );
    const steered = await client.sendMessage(
      id,
      {
        source: 'BridgeSuite',
        text: `Cancel the number-list request. Reply with exactly ${tag}_STEER and stop. Do not use tools.`,
        mode: 'steer',
        expectedTurnId: receipt.turnId,
      },
      { idempotencyKey: randomUUID() },
    );
    assert.equal(steered.turnId, receipt.turnId);
    const result = await finish(id, receipt.turnId);
    assert.equal(result.answer.trim(), `${tag}_STEER`);
    await assert.rejects(
      client.sendMessage(
        id,
        { source: 'BridgeSuite', text: 'stale', mode: 'steer', expectedTurnId: receipt.turnId },
        { idempotencyKey: randomUUID() },
      ),
      (e) => e.status === 409,
    );
    return { steeredSameTurn: true, staleRejected: true };
  });
  await check('interruptTurn', async () => {
    await rpc.request('thread/settings/update', {
      threadId: id,
      collaborationMode: {
        mode: 'plan',
        settings: { model: created.model, reasoning_effort: null, developer_instructions: null },
      },
    });
    const from = events.length;
    const receipt = await start(
      id,
      `Controlled interruption test: call request_user_input once with a question id interrupt_gate and choices wait / stop, then wait for its answer. Do not use other tools.`,
    );
    // Wait for an actual blocking model tool, not merely turn/start acceptance.
    await event(
      (e) =>
        e.type === 'request.pending' &&
        e.sessionId === id &&
        e.data.params?.turnId === receipt.turnId,
      'No blocking interaction for interruption test',
      from,
    );
    await client.interrupt(id, receipt.turnId);
    await finish(id, receipt.turnId, 'interrupted');
    assert.equal((await client.detail(id)).thread.status.type, 'idle');
    return { interruptedWhileWaitingForInput: true };
  });
  await check('questionResponse', async () => {
    await rpc.request('thread/settings/update', {
      threadId: id,
      collaborationMode: {
        mode: 'plan',
        settings: { model: created.model, reasoning_effort: null, developer_instructions: null },
      },
    });
    const from = events.length;
    const receipt = await start(
      id,
      `This tests the request_user_input tool. Call request_user_input once now, with one question id bridge_choice asking which marker to use, and choices ${tag}_YES and ${tag}_NO. Wait for the response, then reply with only the selected marker. Do not use any other tool.`,
    );
    const requestEvent = await event(
      (e) =>
        e.type === 'request.pending' &&
        e.sessionId === id &&
        e.data.method === 'item/tool/requestUserInput',
      'No real request_user_input request',
      from,
    );
    const request = requestEvent.data;
    const pending = await client.pendingRequests(id);
    assert.ok(pending.data.some((x) => x.id === request.id));
    const answers = Object.fromEntries(
      request.params.questions.map((q) => [q.id, { answers: [`${tag}_YES`] }]),
    );
    await client.respond(request.id, { result: { answers } });
    const result = await finish(id, receipt.turnId);
    assert.equal(result.answer.trim(), `${tag}_YES`);
    assert.ok(!(await client.pendingRequests(id)).data.some((x) => x.id === request.id));
    await assert.rejects(
      client.respond(request.id, { result: { answers } }),
      (e) => e.status === 404,
    );
    checked.add('pendingRequests');
    checked.add('respondToRequest');
    return {
      actualMethod: request.method,
      pendingObserved: true,
      replyConsumed: true,
      duplicateRejected: true,
    };
  });
  await check('approvalResponse', async () => {
    await rpc.request('thread/settings/update', {
      threadId: id,
      collaborationMode: {
        mode: 'default',
        settings: { model: created.model, reasoning_effort: null, developer_instructions: null },
      },
    });
    const from = events.length;
    const receipt = await start(
      id,
      `Isolated command-approval test. Use the shell tool to run exactly python3 -c 'print("${tag}_APPROVAL")' once in the current directory. No other command, file access or network. If approval is declined, do not retry; reply ${tag}_DECLINED. This is only a harmless stdout print.`,
    );
    const requestEvent = await event(
      (e) =>
        e.type === 'request.pending' &&
        e.sessionId === id &&
        e.data.method === 'item/commandExecution/requestApproval',
      'No real command approval request',
      from,
    );
    const request = requestEvent.data;
    assert.ok((await client.pendingRequests(id)).data.some((x) => x.id === request.id));
    // Decline: no command execution or policy change is needed to test approval responses.
    await client.respond(request.id, { result: { decision: 'decline' } });
    const result = await finish(id, receipt.turnId);
    assert.ok(result.answer.includes(`${tag}_DECLINED`));
    assert.ok(!(await client.pendingRequests(id)).data.some((x) => x.id === request.id));
    return { actualMethod: request.method, decision: 'decline', continuationObserved: true };
  });
  await check('approvalAccept', async () => {
    const from = events.length;
    const command = `python3 -I -S -c 'print("${tag}_APPROVED")'`;
    const receipt = await start(
      id,
      `Isolated positive approval test. Use the shell tool to run exactly this command once: ${command}\nDo not use any other command, read/write files or access network. Wait for approval if requested. Then reply with only its stdout.`,
    );
    const requestEvent = await event(
      (e) =>
        e.type === 'request.pending' &&
        e.sessionId === id &&
        e.data.method === 'item/commandExecution/requestApproval',
      'No real approval for fixed print command',
      from,
    );
    const request = requestEvent.data;
    if (!matchesPrintCommand(request.params.command, command)) {
      await client.respond(request.id, { result: { decision: 'decline' } });
      throw new Error(`Unexpected approval command; declined: ${request.params.command}`);
    }
    assert.equal(await realpath(request.params.cwd), await realpath(directory));
    await client.respond(request.id, { result: { decision: 'accept' } });
    const result = await finish(id, receipt.turnId);
    const execution = result.history.data.find((e) => e.item.type === 'commandExecution');
    assert.ok(execution, 'Missing command execution history');
    assert.equal(execution.item.exitCode, 0);
    assert.ok(execution.item.aggregatedOutput.includes(`${tag}_APPROVED`));
    assert.equal(result.answer.trim(), `${tag}_APPROVED`);
    return {
      actualMethod: request.method,
      decision: 'accept',
      exitCode: 0,
      exactPrintCommand: true,
    };
  });
  let forkId;
  await check('forkSession', async () => {
    const fork = await client.fork(id, { lastTurnId: seed.turnId });
    forkId = fork.thread.id;
    assert.notEqual(forkId, id);
    await client.rename(forkId, `${tag}_FORK`);
    const page = await client.turns(forkId, { limit: 100, itemsView: 'full' });
    assert.ok(page.data.length > 0);
    assert.ok(JSON.stringify(page).includes(`${tag}_SEED`));
    assert.ok(!JSON.stringify(page).includes(`${tag}_CONTEXT`));
    // A fresh lazy fork can have inherited turns but no own preview. Codex hides
    // empty-preview threads from its normal list, even after unarchiving.
    const ownInput = await start(
      forkId,
      `Do not use tools. Reply with exactly this line, without punctuation or formatting:\n${tag}_FORK_READY`,
    );
    assert.equal((await finish(forkId, ownInput.turnId)).answer.trim(), `${tag}_FORK_READY`);
    assert.ok(
      (await client.listSessions({ cwd: directory, archived: false, limit: 100 })).data.some(
        (t) => t.id === forkId,
      ),
    );
    return { forkId, boundedHistory: true, ownTurnCompleted: true };
  });
  await check('detachSession', async () => {
    await client.detach(forkId);
  });
  await check('archiveSession', async () => {
    await client.archive(forkId);
    assert.ok(!(await client.loadedSessions({ limit: 100 })).data.includes(forkId));
    assert.ok(
      (await client.listSessions({ cwd: directory, archived: true, limit: 100 })).data.some(
        (t) => t.id === forkId,
      ),
    );
  });
  await check('unarchiveSession', async () => {
    await client.unarchive(forkId);
    assert.ok(
      (await client.listSessions({ cwd: directory, archived: false, limit: 100 })).data.some(
        (t) => t.id === forkId,
      ),
    );
  });
  await check('resumeSession', async () => {
    const resumed = await client.resume(forkId);
    assert.equal(resumed.thread.id, forkId);
    assert.ok((await client.loadedSessions({ limit: 100 })).data.includes(forkId));
    const receipt = await start(
      forkId,
      `Do not use tools. Reply with exactly this line, without punctuation or formatting:\n${tag}_RESUMED`,
    );
    assert.equal((await finish(forkId, receipt.turnId)).answer.trim(), `${tag}_RESUMED`);
  });
  const capabilities = await client.capabilities();
  report.unverifiedOperations = capabilities.operations.filter((name) => !checked.has(name));
  report.verifiedOperations = capabilities.operations.filter((name) => checked.has(name));
  assert.deepEqual(report.unverifiedOperations, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = { message: error.message, code: error.code, details: error.details };
  process.exitCode = 1;
  console.error(JSON.stringify(report.error));
} finally {
  if (client && rpc.connected) {
    for (const [id, turnId] of active) {
      try {
        await client.interrupt(id, turnId);
        report.cleanup.push({ id, interrupted: true });
      } catch (error) {
        report.cleanup.push({ id, interruptError: error.message });
      }
    }
    for (const id of owned) {
      try {
        await client.archive(id);
        report.cleanup.push({ id, archived: true });
      } catch (error) {
        report.cleanup.push({ id, archiveError: error.message });
      }
    }
    const loaded = (await client.loadedSessions({ limit: 100 })).data;
    report.cleanupAllUnloaded = [...owned].every((id) => !loaded.includes(id));
  }
  abort.abort();
  await streamTask;
  await app.close();
  if (report.cleanupAllUnloaded) await rm(directory, { recursive: true, force: true });
  else {
    report.passed = false;
    process.exitCode = 1;
    report.directoryRetained = true;
  }
  report.finishedAt = new Date().toISOString();
  report.onlyOwnedSessionsMutated = report.mutations.every((m) => owned.has(m.sessionId));
  await persist();
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: report.checks.length,
      reportPath,
      cleanupAllUnloaded: report.cleanupAllUnloaded,
      onlyOwnedSessionsMutated: report.onlyOwnedSessionsMutated,
    }),
  );
}

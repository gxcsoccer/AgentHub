import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeAdapter, AgentHub } from '../dist/src/index.js';

export async function runLiveMatrix(c) {
  const {
    api,
    hub,
    codex,
    rpc,
    child,
    report,
    until,
    check,
    dir,
    claudeCwd,
    inbox,
    codexAddress,
    claudeAddress,
    observedEvents,
  } = c;
  const token = () => 'HH_CROSS_' + randomUUID();
  const input = (to, delivery, text = token()) => ({
    messageId: randomUUID(),
    to,
    delivery,
    text,
    origin: { name: 'isolated_test' },
  });
  const claudeInput = (text) => input(claudeAddress, 'peer_message', text);
  const codexInput = (text) => input(codexAddress, 'tool_output', text);
  const replied = async (message, expected = message.text) => {
    await until(
      () => hub.receipt(message.messageId).status === 'replied',
      'correlated reply ' + message.messageId,
    );
    assert.equal((await api.receipt(message.messageId)).reply.text, expected);
  };
  const peerCount = async (id) =>
    (await api.history(claudeAddress, { limit: 100 })).data.filter((x) => x.origin?.msg_id === id)
      .length;
  const setPolicy = async (policy) => {
    const id = randomUUID();
    child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: id,
        request: { subtype: 'apply_flag_settings', settings: { crossSessionInbound: policy } },
      }) + '\n',
    );
    const response = await until(
      () =>
        report.claudeMessages.find(
          (x) => x.type === 'control_response' && x.response?.request_id === id,
        ),
      'owned Claude policy ' + policy,
    );
    assert.equal(response.response.subtype, 'success');
  };
  await setPolicy('hold');
  const held = claudeInput();
  await api.send(held);
  await until(() => hub.receipt(held.messageId).status === 'held', 'held receipt');
  assert.equal((await api.receipt(held.messageId, 10)).status, 'held');
  assert.equal(await peerCount(held.messageId), 0);
  await api.send(held);
  assert.equal(hub.receipt(held.messageId).status, 'held');
  await setPolicy('accept');
  await replied(held);
  assert.equal(await peerCount(held.messageId), 1);
  check('claude_hold_release_and_duplicate', { messageId: held.messageId });

  await setPolicy('refuse');
  const refused = claudeInput();
  await api.send(refused);
  const refusal = await api.receipt(refused.messageId, 10000);
  assert.equal(refusal.status, 'rejected');
  assert.equal(await peerCount(refused.messageId), 0);
  await assert.rejects(api.send({ ...refused, text: 'different' }), /different payload/);
  await setPolicy('accept');
  check('claude_refuse_and_payload_conflict', { messageId: refused.messageId });

  const gateToken = token(),
    first = claudeInput('GATE ' + gateToken),
    second = claudeInput();
  await api.send(first);
  await until(async () => {
    try {
      return (
        JSON.parse(await readFile(join(claudeCwd, 'gate-entered.json'), 'utf8')).token === gateToken
      );
    } catch {
      return false;
    }
  }, 'Claude deterministic busy gate');
  await api.send(second);
  await api.send(second);
  assert.notEqual((await api.receipt(second.messageId, 10)).status, 'replied');
  await writeFile(join(claudeCwd, 'gate-release'), 'release', { mode: 0o600 });
  await replied(first, gateToken);
  await replied(second);
  assert.equal(await peerCount(first.messageId), 1);
  assert.equal(await peerCount(second.messageId), 1);
  check('claude_busy_queued_duplicate_late_reply', {
    messageIds: [first.messageId, second.messageId],
  });

  const gate = codexInput('GATE ' + token()),
    extra = codexInput();
  const a = await api.send(gate);
  const request = await until(
    () =>
      codex
        .pendingRequests()
        .find((x) => x.params.tool === 'hh_gate' && x.params.arguments?.token === gate.text),
    'Codex deterministic busy gate',
  );
  const b = await api.send(extra);
  assert.equal(b.native.turnId, a.native.turnId);
  await api.send(extra);
  assert.notEqual((await api.receipt(extra.messageId, 10)).status, 'replied');
  await api.respondToRequest(codexAddress, request.id, {
    contentItems: [{ type: 'inputText', text: 'Isolated gate released.' }],
    success: true,
  });
  await replied(gate);
  await replied(extra);
  const history = await api.history(codexAddress, { limit: 100 });
  assert.equal(
    history.data.filter((x) => x.kind === 'functionCallOutput' && x.text.includes(extra.messageId))
      .length,
    1,
  );
  check('codex_busy_same_turn_duplicate_late_reply', {
    messageIds: [gate.messageId, extra.messageId],
    turnId: a.native.turnId,
  });

  // A known live root without the reply tool can accept content but must never
  // manufacture a correlated reply from plain assistant prose.
  const plain = await rpc.request('thread/start', {
    cwd: join(dir, 'codex'),
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    dynamicTools: [],
    developerInstructions:
      'Isolated test. Never call any tool, run commands or change permissions. For the external message, respond DONE in plain text only.',
  });
  await rpc.request('thread/settings/update', {
    threadId: plain.thread.id,
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  });
  const plainAddress = { ...codexAddress, sessionId: plain.thread.id };
  const noTool = input(plainAddress, 'tool_output');
  await api.send(noTool);
  await until(
    () =>
      report.nativeEvents.some(
        (x) => x.method === 'turn/completed' && x.params.threadId === plain.thread.id,
      ),
    'unregistered reply tool completion',
  );
  assert.equal((await api.receipt(noTool.messageId, 20)).status, 'accepted');
  check('codex_without_reply_tool_does_not_claim_reply', { sessionId: plain.thread.id });

  // Reconnect reads only. turn/start does not restore the native listener or
  // dynamic-tool response route; testing that unsupported promise failed in the
  // first matrix run. Never silently resume a user's session to hide the gap.
  rpc.close();
  await until(
    () =>
      observedEvents.some(
        (x) => x.event === 'adapter.event' && x.data.data.method === 'connection.gap',
      ),
    'SSE disconnect evidence',
  );
  assert.equal((await api.send(extra)).status, 'replied');
  const recovered = await api.history(codexAddress, { limit: 100 });
  assert.equal(
    recovered.data.filter(
      (x) => x.kind === 'functionCallOutput' && x.text.includes(extra.messageId),
    ).length,
    1,
  );
  check('codex_disconnect_preserves_receipts_without_replay_or_reattach', {
    messageId: extra.messageId,
    automaticReplyRecovery: false,
  });

  // Controlled fault: relay the message to the real inbox but withhold EOF
  // from the submitting adapter. A timeout cannot safely imply non-delivery.
  const proxyPath = join(dir, 'fault.sock'),
    sockets = new Set();
  let relayed = 0;
  const proxy = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const frame = JSON.parse(buffer.split('\n')[0]);
      assert.equal(frame.session_id, claudeAddress.sessionId);
      relayed++;
      const upstream = createConnection(inbox);
      sockets.add(upstream);
      upstream.on('error', () => {});
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('connect', () => upstream.end(JSON.stringify(frame) + '\n'));
    });
  });
  // allowHalfOpen keeps the proxy's write side open after the sender's FIN.
  proxy.listen(proxyPath);
  await once(proxy, 'listening');
  const faultAdapter = new ClaudeAdapter({
    instance: 'fault',
    nativeMessaging: true,
    timeoutMs: 500,
    version: async () => '2.1.318',
    discover: async () => [
      { sessionId: claudeAddress.sessionId, pid: child.pid, status: 'idle', socketPath: proxyPath },
    ],
  });
  const faultHub = new AgentHub([faultAdapter]);
  try {
    const m = input({ ...claudeAddress, instance: 'fault' }, 'peer_message');
    const result = await faultHub.send(m);
    assert.equal(result.status, 'unknown');
    await faultHub.send(m);
    assert.equal(relayed, 1);
    await until(
      async () => (await peerCount(m.messageId)) === 1,
      'uncertain write reached real native history',
    );
    check('claude_timeout_after_native_delivery_no_replay', {
      messageId: m.messageId,
      status: result.status,
    });
  } finally {
    await faultHub.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }

  // Stop only the owned target; subsequent sends must fail without a resume.
  child.stdin.end();
  await Promise.race([once(child, 'exit'), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await assert.rejects(api.send(claudeInput()), /not running/);
  check('exited_claude_target_fails_without_resume');
}

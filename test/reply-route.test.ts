import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAdapter, codexReplyTool } from '../src/adapters/codex.js';
import { FakeRpc, httpFixture, testToken } from './helpers.js';
import { replyToolState } from '../src/adapters/codex-readiness.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HarnessHub } from '../src/hub.js';
import { openReceiptStore } from '../src/store.js';

async function fixture(t: test.TestContext, tools: unknown[] = [codexReplyTool]) {
  const dir = await mkdtemp('/tmp/hh-reply-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = randomUUID(),
    path = join(dir, 'rollout.jsonl'),
    rpc = new FakeRpc();
  await writeFile(
    path,
    JSON.stringify({ type: 'session_meta', payload: { id, dynamic_tools: tools } }) + '\n',
  );
  rpc.handlers.set('thread/read', () => ({
    thread: { id, path, status: { type: 'idle' }, canAcceptDirectInput: true },
  }));
  rpc.handlers.set('thread/loaded/list', () => ({ data: [id] }));
  rpc.handlers.set('thread/resume', () => ({
    thread: { id, path, status: { type: 'idle' }, canAcceptDirectInput: true },
  }));
  const adapter = new CodexAdapter({ rpc });
  t.after(() => adapter.close());
  return { rpc, adapter, address: { harness: 'codex', instance: 'local', sessionId: id } };
}
test('readiness is read-only and attach requires explicit resume-race acknowledgment', async (t) => {
  const { adapter, rpc, address } = await fixture(t);
  assert.equal((await adapter.getSession(address)).replyReadiness?.state, 'needs_attach');
  assert(!rpc.calls.some((x) => x.method === 'thread/resume'));
  await assert.rejects(
    adapter.attachReplyRoute(address, { acceptResumeRace: false }),
    /acknowledg/,
  );
  const result = await adapter.attachReplyRoute(address, { acceptResumeRace: true });
  assert.equal(result.replyReadiness?.state, 'ready');
  assert.deepEqual(rpc.calls.find((x) => x.method === 'thread/resume')?.params, {
    threadId: address.sessionId,
    excludeTurns: true,
  });
  rpc.emit('disconnect');
  assert.equal((await adapter.getSession(address)).replyReadiness?.state, 'needs_attach');
});
test('unloaded sessions and sessions without a compatible reply tool cannot be attached', async (t) => {
  const missing = await fixture(t, []);
  assert.equal(
    (await missing.adapter.getSession(missing.address)).replyReadiness?.state,
    'missing_tool',
  );
  await assert.rejects(
    missing.adapter.attachReplyRoute(missing.address, { acceptResumeRace: true }),
    /reply tool/,
  );
  const unloaded = await fixture(t);
  unloaded.rpc.handlers.set('thread/loaded/list', () => ({ data: [] }));
  await assert.rejects(
    unloaded.adapter.attachReplyRoute(unloaded.address, { acceptResumeRace: true }),
    /not loaded/,
  );
  assert(!unloaded.rpc.calls.some((x) => x.method === 'thread/resume'));
});

test('owner HTTP and CLI attachment require acknowledgment and preserve the exact RPC arguments', async (t) => {
  const { adapter, rpc, address } = await fixture(t),
    { client, baseUrl } = await httpFixture(t, adapter);
  await assert.rejects(
    client.attachReplyRoute(address, { acceptResumeRace: false }),
    /acceptResumeRace/,
  );
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const args = [
    cli,
    'attach-reply',
    '--url',
    baseUrl,
    '--harness',
    'codex',
    '--session-id',
    address.sessionId,
  ];
  const exec = promisify(execFile),
    env = { ...process.env, HARNESSHUB_TOKEN: testToken };
  await assert.rejects(exec(process.execPath, args, { env }), /acknowledgment/);
  assert(!rpc.calls.some((r) => r.method === 'thread/resume'));
  const result = JSON.parse(
    (await exec(process.execPath, [...args, '--accept-resume-race'], { env })).stdout,
  );
  assert.equal(result.replyReadiness.state, 'ready');
  assert.equal(rpc.calls.filter((r) => r.method === 'thread/resume').length, 1);
  const other = await httpFixture(t);
  await assert.rejects(
    other.client.attachReplyRoute(
      { harness: 'test', instance: 'local', sessionId: 'test' },
      { acceptResumeRace: true },
    ),
    /does not expose/,
  );
});

test('unverifiable registration and a disconnect during attach never claim readiness', async (t) => {
  const { rpc, adapter, address } = await fixture(t);
  rpc.handlers.set('thread/resume', () => {
    rpc.emit('disconnect');
    return {};
  });
  await assert.rejects(
    adapter.attachReplyRoute(address, { acceptResumeRace: true }),
    /Connection changed/,
  );
  assert.equal((await adapter.getSession(address)).replyReadiness?.state, 'needs_attach');
  const dir = await mkdtemp('/tmp/hh-tools-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'meta'),
    id = randomUUID();
  assert.equal(await replyToolState({ id }), 'unknown');
  for (const row of [
    null,
    { type: 'session_meta', payload: { id: 'other' } },
    { type: 'session_meta', payload: { id, dynamic_tools: 'bad' } },
    {
      type: 'session_meta',
      payload: { id, dynamic_tools: [{ ...codexReplyTool, inputSchema: {} }] },
    },
  ]) {
    await writeFile(path, JSON.stringify(row) + '\n');
    assert.equal(await replyToolState({ id, path }), 'unknown');
  }
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
  assert.equal(await replyToolState({ id, path }), 'missing');
  await writeFile(path, 'partial');
  assert.equal(await replyToolState({ id, path }), 'unknown');
  const link = join(dir, 'symlink');
  await symlink(path, link);
  assert.equal(await replyToolState({ id, path: link }), 'unknown');
  assert.equal(await replyToolState({ id, path: dir }), 'unknown');
});

test('persisted Codex correlation accepts a late tool reply after explicit attachment on a new connection', async (t) => {
  const { rpc, adapter, address } = await fixture(t);
  const dir = await mkdtemp('/tmp/hh-codex-state-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  rpc.handlers.set('turn/start', () => ({ turn: { id: 'test-turn' } }));
  const first = new HarnessHub([adapter], { store: await openReceiptStore(path) });
  const message = {
    messageId: randomUUID(),
    to: address,
    delivery: 'tool_output' as const,
    origin: { name: 'test' },
    text: 'reply after reconnect',
  };
  await first.send(message);
  await first.close();
  const next = new FakeRpc();
  next.handlers = new Map(rpc.handlers);
  const second = new HarnessHub([new CodexAdapter({ rpc: next })], {
    store: await openReceiptStore(path),
  });
  await second.ready();
  assert.equal(next.calls.length, 0);
  assert.equal((await second.getSession(address)).replyReadiness?.state, 'needs_attach');
  await second.attachReplyRoute(address, { acceptResumeRace: true });
  next.emit('request', {
    id: 'late',
    method: 'item/tool/call',
    params: {
      threadId: address.sessionId,
      tool: 'harnesshub_reply',
      arguments: { inReplyTo: message.messageId, text: 'persisted answer' },
    },
  });
  assert.equal(second.receipt(message.messageId).reply?.text, 'persisted answer');
  assert(!next.calls.some((c) => c.method === 'turn/start'));
  assert.equal((next.responses[0] as { result: { success: boolean } }).result.success, true);
  await second.close();
  const third = new HarnessHub([], { store: await openReceiptStore(path) });
  assert.equal((await third.send(message)).reply?.text, 'persisted answer');
  await third.close();
});

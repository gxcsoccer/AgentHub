import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, lstat, writeFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { HarnessHubClient } from '../src/client.js';
import { openReceiptStore } from '../src/store.js';
import { HarnessHub } from '../src/hub.js';
import { TestAdapter, testAddress, testToken } from './helpers.js';
import type { Json } from '../src/types.js';

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill(signal);
  await done;
}
async function worker(t: test.TestContext, config: Json) {
  const child = fork(new URL('./recovery-worker.js', import.meta.url), [JSON.stringify(config)], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => stop(child));
  const [message] = await once(child, 'message');
  assert(message.url, JSON.stringify(message));
  return { child, api: new HarnessHubClient({ baseUrl: message.url, token: testToken }) };
}
async function directory(t: test.TestContext) {
  const dir = await mkdtemp('/tmp/hh-crash-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const message = () => ({
  messageId: randomUUID(),
  to: testAddress,
  delivery: 'peer_message' as const,
  origin: { name: 'crash-test' },
  text: 'once',
});
async function push(path: string, frame: Json) {
  const socket = createConnection(path);
  const done = once(socket, 'close');
  socket.once('connect', () => socket.end(JSON.stringify(frame) + '\n'));
  await done;
}

test('SIGKILL releases the state lock and an in-flight native send is never repeated after restart', async (t) => {
  const path = join(await directory(t), 'state.sqlite'),
    first = await worker(t, { path, stall: true });
  const input = message(),
    submitted = once(first.child, 'message');
  const sending = first.api.send(input).catch(() => undefined);
  assert.equal((await submitted)[0].submitted, input.messageId);
  await assert.rejects(openReceiptStore(path), /already open/);
  await stop(first.child, 'SIGKILL');
  await sending;
  const second = await worker(t, { path });
  assert.equal((await second.api.receipt(input.messageId)).status, 'unknown');
  assert.equal((await second.api.send(input)).error?.code, 'process_restarted');
  await assert.rejects(second.api.send({ ...input, text: 'changed' }), /different payload/);
  const calls = once(second.child, 'message');
  second.child.send('calls');
  assert.deepEqual((await calls)[0].calls, []);
  await stop(second.child);
});

test('Claude late reply survives SIGKILL, reuses its callback path and forwards one correlated reply', async (t) => {
  const dir = await directory(t),
    path = join(dir, 'state.sqlite'),
    inbox = join(dir, 'native.sock');
  const frames: Json[] = [];
  const server = createServer((socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (s) => {
      data += s;
    });
    socket.on('end', () => {
      if (data) frames.push(JSON.parse(data));
      socket.end();
    });
  });
  server.listen(inbox);
  await once(server, 'listening');
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const id = randomUUID(),
    config = {
      path,
      claude: { sessionId: id, pid: process.pid, status: 'idle', socketPath: inbox },
    };
  const first = await worker(t, config),
    input = {
      ...message(),
      to: { harness: 'claude', instance: 'local', sessionId: id },
      replyTo: testAddress,
    };
  assert.equal((await first.api.send(input)).status, 'transport_written');
  const callback = String(frames[0]!.from).slice(4),
    inode = (await lstat(callback)).ino;
  await stop(first.child, 'SIGKILL');
  assert.equal((await lstat(callback)).ino, inode);
  const second = await worker(t, config);
  assert((await lstat(callback)).isSocket());
  await second.api.send(input);
  assert.equal(frames.length, 1);
  const frame = {
    msgV: 1,
    type: 'user',
    from: `uds:${inbox}`,
    message: {
      content: `<cross-session-message>\n${JSON.stringify({ inReplyTo: input.messageId, text: 'late answer' })}\n</cross-session-message>`,
    },
  };
  await push(callback, frame);
  const reply = await second.api.receipt(input.messageId, 1000);
  assert.equal(reply.reply?.text, 'late answer');
  assert(reply.forwardedMessageId);
  await push(callback, frame);
  const calls = once(second.child, 'message');
  second.child.send('calls');
  const sent = (await calls)[0].calls;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messageId, reply.forwardedMessageId);
  assert.equal(sent[0].inReplyTo, input.messageId);
  assert(!sent[0].replyTo);
  await stop(second.child);
  const third = await worker(t, config);
  assert.equal(
    (await third.api.receipt(input.messageId)).forwardedMessageId,
    reply.forwardedMessageId,
  );
  const repeated = once(third.child, 'message');
  third.child.send('calls');
  assert.deepEqual((await repeated)[0].calls, []);
  await stop(third.child);
});

test('SIGKILL after a reply forward is reserved preserves both IDs without replaying the ambiguous child', async (t) => {
  const path = join(await directory(t), 'state.sqlite'),
    input = { ...message(), replyTo: testAddress };
  const first = await worker(t, { path, stallForward: true, originalId: input.messageId });
  await first.api.send(input);
  const submitted = once(first.child, 'message');
  first.child.send('reply');
  const childId = (await submitted)[0].submitted;
  assert.equal((await first.api.receipt(input.messageId)).forwardedMessageId, childId);
  await stop(first.child, 'SIGKILL');
  const second = await worker(t, { path });
  assert.equal((await second.api.receipt(input.messageId)).forwardedMessageId, childId);
  assert.equal((await second.api.receipt(childId)).status, 'unknown');
  const calls = once(second.child, 'message');
  second.child.send('calls');
  assert.deepEqual((await calls)[0].calls, []);
  await stop(second.child);
});

test('unsafe state paths, future schemas and corrupt rows fail closed without overwriting data', async (t) => {
  const dir = await directory(t),
    path = join(dir, 'state.sqlite');
  await chmod(dir, 0o755);
  await assert.rejects(openReceiptStore(path), /0700/);
  await chmod(dir, 0o700);
  await writeFile(path, 'sentinel', { mode: 0o644 });
  await assert.rejects(openReceiptStore(path), /private regular/);
  await rm(path);
  const target = join(dir, 'target');
  await writeFile(target, '', { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(openReceiptStore(path), /private regular/);
  await rm(path);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  await chmod(path, 0o600);
  db.exec('PRAGMA user_version=99');
  db.close();
  await assert.rejects(openReceiptStore(path), /schema version/);
  await rm(path);
  const other = new DatabaseSync(path);
  await chmod(path, 0o600);
  other.exec('CREATE TABLE unrelated (x)');
  other.close();
  await assert.rejects(openReceiptStore(path), /unrelated database/);
  await rm(path);
  (await openReceiptStore(path)).close();
  const corrupt = new DatabaseSync(path);
  corrupt.prepare('INSERT INTO receipts VALUES (?,?)').run(randomUUID(), '{broken');
  corrupt.close();
  const store = await openReceiptStore(path);
  assert.throws(() => new HarnessHub([], { store }), /Cannot recover/);
  const reopened = await openReceiptStore(path);
  reopened.close();
});

test('a failed durable reservation prevents native I/O and leaves the hub unavailable', async (t) => {
  const store = await openReceiptStore(join(await directory(t), 'state.sqlite'));
  const adapter = new TestAdapter(),
    hub = new HarnessHub([adapter], { store });
  await hub.ready();
  t.after(() => hub.close());
  store.save = () => {
    throw new Error('disk full');
  };
  await assert.rejects(hub.send(message()), /disk full/);
  assert.equal(adapter.calls.length, 0);
  await assert.rejects(hub.send(message()), /disk full/);
  assert.throws(() => hub.receipt(randomUUID()), /disk full/);
});

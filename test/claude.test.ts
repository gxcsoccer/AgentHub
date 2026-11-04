import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { mkdtemp, rm, writeFile, mkdir, lstat, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { readClaudeHistory } from '../src/adapters/claude-history.js';
import { AgentHub } from '../src/hub.js';
import type { Json } from '../src/types.js';

async function push(path: string, frame: unknown) {
  await new Promise<void>((resolve, reject) => {
    const s = createConnection(path);
    s.on('error', reject);
    s.on('connect', () => s.end(JSON.stringify(frame) + '\n'));
    s.on('close', (err) => {
      if (!err) resolve();
    });
  });
}
async function fixture(t: test.TestContext, policy = 'accept', version = '2.1.318') {
  const dir = await mkdtemp('/tmp/hht-');
  const id = randomUUID();
  const inbox = join(dir, 'native.sock');
  const frames: Json[] = [];
  const native = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (buffer += chunk));
    socket.on('end', () => {
      socket.end();
      const frame = JSON.parse(buffer) as Json;
      frames.push(frame);
      void (async () => {
        const callback = String(frame.from).slice(4);
        if (policy === 'accept')
          await push(callback, {
            msgV: 1,
            type: 'user',
            from: `uds:${inbox}`,
            message: {
              content: `<cross-session-message from="uds:${inbox}">\n${JSON.stringify({ inReplyTo: frame.msg_id, text: 'answer' })}\n</cross-session-message>`,
            },
          });
        else
          await push(callback, {
            msgV: 1,
            type: 'control',
            from: `uds:${inbox}`,
            action: 'peer_message_status',
            orig_msg_id: frame.msg_id,
            status: policy === 'hold' ? 'held' : 'expired',
            ...(policy === 'refuse' ? { status_detail: 'refused' } : {}),
          });
      })().catch(() => {});
    });
  });
  native.listen(inbox);
  await once(native, 'listening');
  const adapter = new ClaudeAdapter({
    nativeMessaging: true,
    version: async () => version,
    discover: async () => [{ sessionId: id, pid: process.pid, status: 'idle', socketPath: inbox }],
  });
  const hub = new AgentHub([adapter]);
  t.after(async () => {
    await hub.close();
    await new Promise<void>((resolve) => native.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const to = { harness: 'claude', instance: 'local', sessionId: id };
  const input = {
    messageId: randomUUID(),
    to,
    delivery: 'peer_message' as const,
    origin: { name: 'test' },
    text: 'hello',
  };
  return { dir, id, inbox, frames, adapter, hub, input };
}
test('Claude sends native peer framing and receives a correlated reverse-socket reply', async (t) => {
  const { hub, input, frames, dir, inbox, adapter } = await fixture(t);
  await hub.send(input);
  const receipt = await hub.wait(input.messageId, 1000);
  assert.equal(receipt.status, 'replied');
  assert.equal(receipt.reply?.text, 'answer');
  assert.equal(frames[0]?.msgV, 1);
  assert.equal(frames[0]?.session_id, input.to.sessionId);
  assert.match(String((frames[0]?.message as Json).content), /from-mode="prompting"/);
  await hub.send(input);
  assert.equal(frames.length, 1);
  assert.equal((await lstat(inbox)).isSocket(), true);
  await adapter.close();
  assert.deepEqual(await readdir(dir), ['native.sock']);
});
test('Claude held and refused receipts preserve policy distinctions', async (t) => {
  for (const policy of ['hold', 'refuse']) {
    const { hub, input } = await fixture(t, policy);
    await hub.send(input);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(hub.receipt(input.messageId).status, policy === 'hold' ? 'held' : 'rejected');
  }
});
test('validated older Claude version advertises peer delivery and reports the actual sender CLI version', async (t) => {
  const { hub, adapter, input } = await fixture(t, 'accept', '2.1.317');
  const info = await adapter.getSession(input.to);
  assert.deepEqual(info.capabilities.send, ['peer_message']);
  assert.deepEqual(info.metadata?.validatedCliVersions, ['2.1.317', '2.1.318']);
  const receipt = await hub.send(input);
  assert.equal(receipt.native?.cliVersion, '2.1.317');
});
test('native sends require opt-in and the validated version', async (t) => {
  const { input } = await fixture(t);
  for (const options of [
    { nativeMessaging: false, version: async () => '2.1.318' },
    { nativeMessaging: true, version: async () => '9.0.0' },
  ]) {
    const adapter = new ClaudeAdapter({
      ...options,
      discover: async () => [{ sessionId: input.to.sessionId, pid: process.pid, status: 'idle' }],
    });
    assert.deepEqual((await adapter.getSession(input.to)).capabilities.send, []);
    await assert.rejects(
      adapter.send({
        ...input,
        expiresAt: new Date(Date.now() + 10000).toISOString(),
        hopCount: 0,
      }),
      /opt-in|validated only/,
    );
    await adapter.close();
  }
});
test('callback from another socket cannot forge a correlated reply', async (t) => {
  const { hub, input, frames } = await fixture(t, 'hold');
  await hub.send(input);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const callback = String(frames[0]!.from).slice(4);
  await push(callback, {
    msgV: 1,
    type: 'user',
    from: 'uds:/unrelated.sock',
    message: {
      content: `<cross-session-message>\n${JSON.stringify({ inReplyTo: input.messageId, text: 'forged' })}\n</cross-session-message>`,
    },
  });
  assert.equal(hub.receipt(input.messageId).status, 'held');
});

test('closing Claude during discovery prevents socket creation and delivery', async (t) => {
  const { input, inbox, dir, frames } = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discovered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const adapter = new ClaudeAdapter({
    nativeMessaging: true,
    version: async () => '2.1.318',
    discover: async () => {
      entered();
      await gate;
      return [
        { sessionId: input.to.sessionId, pid: process.pid, status: 'idle', socketPath: inbox },
      ];
    },
  });
  t.after(() => adapter.close());
  const sending = adapter.send({
    ...input,
    expiresAt: new Date(Date.now() + 10000).toISOString(),
    hopCount: 0,
  });
  await discovered;
  await adapter.close();
  release();
  await assert.rejects(sending, /closed/);
  assert.equal(frames.length, 0);
  assert.deepEqual(await readdir(dir), ['native.sock']);
});
test('history includes busy peer attachments, excludes API blobs and deduplicates transcript rows', async (t) => {
  const dir = await mkdtemp('/tmp/hhh-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'project'));
  const id = randomUUID();
  const path = join(dir, 'project', id + '.jsonl');
  const row = {
    type: 'user',
    uuid: 'one',
    origin: { kind: 'peer' },
    message: { content: 'first' },
  };
  await writeFile(
    path,
    [
      row,
      row,
      { type: 'api-request-blob', uuid: 'blob', message: { content: 'duplicate' } },
      {
        type: 'attachment',
        uuid: 'two',
        attachment: {
          type: 'queued_command',
          origin: { kind: 'peer', msg_id: 'native' },
          prompt: 'second',
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n{"partial":',
  );
  const first = await readClaudeHistory(dir, id, { limit: 1 });
  assert.equal(first.data[0]?.kind, 'peerMessage');
  assert(first.nextCursor);
  const second = await readClaudeHistory(dir, id, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.data[0]?.text, 'second');
  assert.equal(second.data[0]?.origin?.msg_id, 'native');
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    readClaudeHistory(dir, id, { cursor: first.nextCursor, search: 'different' }),
    /another query/,
  );
});

test('Claude discovery searches metadata and binds stable pagination to the query', async (t) => {
  const { inbox } = await fixture(t);
  const ids = [randomUUID(), randomUUID()].sort();
  const adapter = new ClaudeAdapter({
    nativeMessaging: true,
    version: async () => '2.1.318',
    discover: async () =>
      ids.map((sessionId) => ({
        sessionId,
        pid: process.pid,
        status: 'idle',
        name: 'find me',
        cwd: '/example',
        socketPath: inbox,
      })),
  });
  t.after(() => adapter.close());
  const first = await adapter.listSessions({ search: 'FIND', limit: 1 });
  assert.equal(first.data[0]?.address.sessionId, ids[0]);
  assert(first.nextCursor);
  const second = await adapter.listSessions({ search: 'FIND', cursor: first.nextCursor });
  assert.equal(second.data[0]?.address.sessionId, ids[1]);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    adapter.listSessions({ cursor: first.nextCursor, search: 'different' }),
    /another query/,
  );
  await assert.rejects(adapter.listSessions({ cursor: 'broken' }), /Malformed/);
  await assert.rejects(
    adapter.getSession({ harness: 'claude', instance: 'local', sessionId: randomUUID() }),
    /not running/,
  );
});

test('Claude rejects unsafe callback directories before writing native messages', async (t) => {
  const { dir, adapter, input, frames } = await fixture(t);
  await chmod(dir, 0o755);
  await assert.rejects(
    adapter.send({ ...input, expiresAt: new Date(Date.now() + 10000).toISOString(), hopCount: 0 }),
    /0700/,
  );
  assert.equal(frames.length, 0);
  await chmod(dir, 0o700);
});

test('Claude ignores malformed, oversized, unmatched and expired callbacks without losing valid state', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { hub, input, frames, inbox, adapter } = await fixture(t, 'hold');
  await hub.send({ ...input, expiresAt: new Date(Date.now() + 1000).toISOString() });
  await new Promise((r) => setTimeout(r, 25));
  const callback = String(frames[0]!.from).slice(4);
  const status = (msgId: string, value: string) => ({
    msgV: 1,
    from: `uds:${inbox}`,
    type: 'control',
    action: 'peer_message_status',
    orig_msg_id: msgId,
    status: value,
  });
  const invalid = once(adapter, 'event');
  await push(callback, { msgV: 1, from: `uds:${inbox}`, type: 'user', message: null });
  await invalid;
  await push(callback, status(randomUUID(), 'delivered'));
  await push(callback, status(input.messageId, 'not-a-status'));
  assert.equal(hub.receipt(input.messageId).status, 'held');
  await push(callback, status(input.messageId, 'delivered'));
  assert.equal(hub.receipt(input.messageId).status, 'received');
  t.mock.timers.tick(1001);
  await push(callback, {
    msgV: 1,
    from: `uds:${inbox}`,
    type: 'user',
    message: {
      content: `<cross-session-message>\n${JSON.stringify({ inReplyTo: input.messageId, text: 'too late' })}\n</cross-session-message>`,
    },
  });
  assert.equal(hub.receipt(input.messageId).status, 'received');
  await new Promise<void>((resolve) => {
    const socket = createConnection(callback);
    socket.on('error', () => {});
    socket.on('close', () => resolve());
    socket.on('connect', () => socket.end('x'.repeat(1024 * 1024 + 1)));
  });
  assert.equal(hub.receipt(input.messageId).status, 'received');
});

test('callback recovery refuses a live or replaced endpoint and ignores expired correlation', async (t) => {
  const dir = await mkdtemp('/tmp/hh-callback-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const callback = join(dir, `hh-${process.pid}-1234abcd.sock`),
    inbox = join(dir, 'native.sock');
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.resume();
  });
  server.listen(callback);
  await once(server, 'listening');
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const messageId = randomUUID(),
    m = {
      messageId,
      to: { harness: 'claude', instance: 'local', sessionId: randomUUID() },
      delivery: 'peer_message' as const,
      origin: { name: 'test' },
      text: 'test',
      hopCount: 0,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    };
  const data = new Map<string, Json>([
    [`outgoing:${messageId}`, { inbox }],
    [`callback:${dir}`, { path: callback, inode: (await lstat(callback)).ino }],
  ]);
  const state = {
    get: (key: string) => data.get(key),
    set: (key: string, value: Json) => {
      data.set(key, value);
    },
  };
  const active = new ClaudeAdapter();
  await assert.rejects(active.restore([m], state), /still active/);
  await active.close();
  await new Promise<void>((r) => server.close(() => r()));
  await writeFile(callback, 'replacement', { mode: 0o600 });
  const replaced = new ClaudeAdapter();
  await assert.rejects(replaced.restore([m], state), /replaced/);
  await replaced.close();
  assert.equal((await lstat(callback)).isFile(), true);
  data.set(`callback:${dir}`, { path: join(dir, 'unrelated.sock'), inode: 1 });
  const invalid = new ClaudeAdapter();
  await assert.rejects(invalid.restore([m], state), /Invalid persisted/);
  await invalid.close();
  const expired = new ClaudeAdapter();
  await expired.restore([{ ...m, expiresAt: new Date(0).toISOString() }], state);
  await expired.close();
});

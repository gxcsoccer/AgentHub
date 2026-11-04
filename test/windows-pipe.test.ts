import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudePipeAdapter, writeAuthenticatedPipe } from '../src/adapters/claude-pipe.js';
test('Windows pipe auth is the first frame, preserves prompting identity and never claims receipt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hh-pipe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pipe = `\\\\.\\pipe\\hh-test-${randomUUID()}`,
    path = process.platform === 'win32' ? pipe : join(directory, 'socket');
  let received = '';
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (c) => {
      received += c;
    });
  });
  server.listen(path);
  await once(server, 'listening');
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const sid = randomUUID(),
    token = randomUUID();
  const a = new ClaudePipeAdapter({
    instance: 'windows',
    sessions: [{ sessionId: sid, pipe, token }],
    experimental: true,
  });
  t.after(() => a.close());
  const address = { harness: 'claude', instance: 'windows', sessionId: sid };
  const message = {
    messageId: randomUUID(),
    to: address,
    origin: { name: 'test' },
    text: 'hello',
    delivery: 'peer_message' as const,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    hopCount: 0,
  };
  if (process.platform === 'win32') {
    assert.equal((await a.send(message)).status, 'transport_written');
    const frames = received
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    assert.deepEqual(frames[0], { type: 'auth', token });
    assert.match(frames[1].message.content, /from-mode="prompting"/);
  } else {
    await assert.rejects(a.send(message), /Windows/);
    await writeAuthenticatedPipe(path, token, { test: true }, 1000);
    assert.deepEqual(
      received
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s)),
      [{ type: 'auth', token }, { test: true }],
    );
  }
  const info = await a.getSession(address);
  assert.equal(info.metadata?.callback, 'unsupported');
  assert(!JSON.stringify(info).includes(token));
  assert.equal((await a.listSessions()).data.length, 1);
  await assert.rejects(a.history(address), /root/);
  assert.throws(
    () =>
      new ClaudePipeAdapter({
        instance: 'x',
        sessions: [{ sessionId: sid, pipe: 'arbitrary', token }],
        experimental: true,
      }),
    /Invalid/,
  );
  await assert.rejects(
    writeAuthenticatedPipe(
      process.platform === 'win32' ? pipe + '-missing' : join(directory, 'missing'),
      token,
      {},
      500,
    ),
    /connect/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexRpc } from '../src/rpc.js';

test('RPC handshakes over a Unix socket and routes concurrent replies by ID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cb-'));
  const socketPath = join(directory, 's.sock');
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  const rpc = new CodexRpc({ socketPath, timeoutMs: 1000 });
  t.after(async () => {
    rpc.close();
    for (const ws of server.clients) ws.terminate();
    server.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  http.listen(socketPath);
  await once(http, 'listening');
  let initialized = false;
  server.on('connection', (ws) =>
    ws.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString());
      if (m.method === 'initialize')
        ws.send(JSON.stringify({ id: m.id, result: { userAgent: 'mock' } }));
      else if (m.method === 'initialized') initialized = true;
      else
        setTimeout(
          () => ws.send(JSON.stringify({ id: m.id, result: { method: m.method } })),
          m.method === 'slow' ? 20 : 0,
        );
    }),
  );
  await rpc.connect();
  assert.equal(rpc.connected, true);
  const [a, b] = await Promise.all([rpc.request('slow'), rpc.request('fast')]);
  assert.equal(initialized, true);
  assert.deepEqual(a, { method: 'slow' });
  assert.deepEqual(b, { method: 'fast' });
});

test('RPC distinguishes server requests from notifications and never auto-approves', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(typeof address === 'object' && address);
  const rpc = new CodexRpc({ url: `ws://127.0.0.1:${address.port}`, timeoutMs: 1000 });
  let peer: WebSocket;
  const responses: unknown[] = [];
  server.on('connection', (ws) => {
    peer = ws;
    ws.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString());
      if (m.method === 'initialize') ws.send(JSON.stringify({ id: m.id, result: {} }));
      else if (m.id === 'approval-1') responses.push(m);
    });
  });
  t.after(() => {
    rpc.close();
    for (const ws of server.clients) ws.terminate();
    server.close();
  });
  await rpc.connect();
  const notification = once(rpc, 'notification');
  const request = once(rpc, 'request');
  peer!.send(JSON.stringify({ method: 'turn/started', params: { threadId: 'x' } }));
  peer!.send(
    JSON.stringify({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'build' },
    }),
  );
  assert.equal((await notification)[0].method, 'turn/started');
  assert.equal((await request)[0].id, 'approval-1');
  assert.equal(responses.length, 0);
  rpc.respond('approval-1', { result: { decision: 'decline' } });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(responses, [{ id: 'approval-1', result: { decision: 'decline' } }]);
});

test('timeout and disconnect report uncertain submission without replaying it', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(typeof address === 'object' && address);
  const rpc = new CodexRpc({ url: `ws://127.0.0.1:${address.port}`, timeoutMs: 40 });
  let writes = 0;
  server.on('connection', (ws) =>
    ws.on('message', (bytes) => {
      const m = JSON.parse(bytes.toString());
      if (m.method === 'initialize') ws.send(JSON.stringify({ id: m.id, result: {} }));
      if (m.method === 'turn/start') writes++;
      if (m.method === 'turn/steer') ws.close();
    }),
  );
  t.after(() => {
    rpc.close();
    for (const ws of server.clients) ws.terminate();
    server.close();
  });
  await rpc.connect();
  await assert.rejects(rpc.request('turn/start'), (e: unknown) => {
    assert.equal((e as { code: string }).code, 'backend_timeout');
    assert.equal((e as { details: { deliveryUnknown: boolean } }).details.deliveryUnknown, true);
    return true;
  });
  await assert.rejects(rpc.request('turn/steer'), /disconnected/);
  assert.equal(writes, 1);
  assert.equal(rpc.connected, false);
  await assert.rejects(rpc.request('thread/list'), /not connected/);
});

test('malformed upstream replies reject pending callers instead of accepting undefined results', async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const rpc = new CodexRpc({ url: `ws://127.0.0.1:${address.port}`, timeoutMs: 500 });
  server.on('connection', (ws) =>
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.method === 'initialize') ws.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === 'thread/read') ws.send(JSON.stringify({ id: message.id }));
    }),
  );
  t.after(() => {
    rpc.close();
    for (const ws of server.clients) ws.terminate();
    server.close();
  });
  await rpc.connect();
  await assert.rejects(rpc.request('thread/read'), /disconnected/);
});

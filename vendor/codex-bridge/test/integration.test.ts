import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { CodexRpc } from '../src/rpc.js';
import { createBridgeServer } from '../src/server.js';
import { BridgeApiError, CodexBridgeClient } from '../src/sdk.js';
import { sessionId, turnId } from './helpers.js';

test(
  'SDK → HTTP → WebSocket delivers attributed input and completion; stale steering never falls back',
  { timeout: 5000 },
  async (t) => {
    const upstream = new WebSocketServer({ port: 0 });
    await once(upstream, 'listening');
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    upstream.on('connection', (ws) =>
      ws.on('message', (bytes) => {
        const message = JSON.parse(bytes.toString());
        calls.push(message);
        const result = (value: unknown) =>
          ws.send(JSON.stringify({ id: message.id, result: value }));
        const notify = (method: string, params: unknown) =>
          ws.send(JSON.stringify({ method, params }));
        switch (message.method) {
          case 'initialize':
            result({});
            break;
          case 'initialized':
            break;
          case 'thread/loaded/list':
            result({ data: [sessionId], nextCursor: null });
            break;
          case 'thread/read':
          case 'thread/resume':
            result({ thread: { id: sessionId, canAcceptDirectInput: true } });
            break;
          case 'turn/start':
            result({ turn: { id: turnId, status: 'inProgress' } });
            notify('turn/started', {
              threadId: sessionId,
              turn: { id: turnId, status: 'inProgress' },
            });
            notify('item/completed', {
              threadId: sessionId,
              turnId,
              item: { id: 'user-1', type: 'userMessage', content: message.params.input },
            });
            notify('item/agentMessage/delta', { threadId: sessionId, turnId, delta: '收到。' });
            notify('turn/completed', {
              threadId: sessionId,
              turn: { id: turnId, status: 'completed', error: null },
            });
            break;
          case 'turn/steer':
            ws.send(
              JSON.stringify({
                id: message.id,
                error: { code: -32600, message: 'Expected turn is no longer active' },
              }),
            );
            break;
          default:
            ws.send(
              JSON.stringify({
                id: message.id,
                error: { code: -32601, message: 'Not implemented by fixture' },
              }),
            );
        }
      }),
    );
    const rpc = new CodexRpc({ url: `ws://127.0.0.1:${address.port}` });
    const token = 'integration-token-at-least-32-characters';
    const app = createBridgeServer({ rpc, token });
    t.after(async () => {
      await app.close();
      for (const ws of upstream.clients) ws.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    await rpc.connect();
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const bound = app.server.address();
    assert.ok(bound && typeof bound !== 'string');
    const client = new CodexBridgeClient({ token, baseUrl: `http://127.0.0.1:${bound.port}` });
    await client.attach(sessionId);
    const stream = client.events({ sessionId, signal: AbortSignal.timeout(4000) });
    assert.equal((await stream.next()).value?.type, 'ready');
    const receipt = await client.sendMessage(
      sessionId,
      { source: 'DeskMind', text: '检查报告' },
      { idempotencyKey: 'report-1' },
    );
    assert.equal(receipt.status, 'accepted');
    let answer = '';
    let userInput: unknown;
    for await (const event of stream) {
      assert.equal(event.turnId, receipt.turnId);
      if (event.type === 'item.completed')
        userInput = (event.data.item as { content: unknown }).content;
      if (event.type === 'response.delta') answer += event.data.delta;
      if (event.type === 'turn.completed') {
        assert.equal((event.data.turn as { status: string }).status, 'completed');
        break;
      }
    }
    assert.equal(answer, '收到。');
    assert.deepEqual(userInput, [{ type: 'text', text: '[External app: DeskMind]\n检查报告' }]);
    await assert.rejects(
      client.sendMessage(
        sessionId,
        { source: 'DeskMind', text: '修正', mode: 'steer', expectedTurnId: 'stale' },
        { idempotencyKey: 'report-2' },
      ),
      (error) => error instanceof BridgeApiError && error.status === 409,
    );
    assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
    assert.equal(calls.filter((call) => call.method === 'thread/resume').length, 1);
  },
);

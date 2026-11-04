import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridgeClient } from '../src/sdk.js';
import { sessionId } from './helpers.js';

test('SDK encodes queries, forwards bearer auth and preserves idempotency keys', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new CodexBridgeClient({
    token: 'secret',
    baseUrl: 'http://127.0.0.1:3210/',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Response.json({ data: [], nextCursor: 'next' });
    }) as typeof fetch,
  });
  await client.listSessions({ cursor: 'a+/=', archived: false });
  await client.sendMessage(
    sessionId,
    { text: 'Hello', source: 'Test' },
    { idempotencyKey: 'stable-key' },
  );
  assert.equal(new URL(calls[0]!.url).searchParams.get('cursor'), 'a+/=');
  assert.equal(new URL(calls[0]!.url).searchParams.get('archived'), 'false');
  assert.equal(new Headers(calls[0]?.init.headers).get('Authorization'), 'Bearer secret');
  assert.equal(new Headers(calls[1]?.init.headers).get('Idempotency-Key'), 'stable-key');
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { text: 'Hello', source: 'Test' });
});

test('SDK surfaces structured errors and never retries a failed mutation', async () => {
  let calls = 0;
  const client = new CodexBridgeClient({
    token: 'secret',
    fetch: (async () => {
      calls++;
      return Response.json(
        {
          error: {
            code: 'backend_timeout',
            message: 'Delivery uncertain',
            details: { deliveryUnknown: true },
          },
        },
        { status: 504 },
      );
    }) as typeof fetch,
  });
  await assert.rejects(
    client.sendMessage(sessionId, { text: 'x', source: 'app' }, { idempotencyKey: 'x' }),
    (error: unknown) => {
      assert.equal((error as { status: number }).status, 504);
      assert.equal((error as { code: string }).code, 'backend_timeout');
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('SDK parses split UTF-8, CRLF, comments and multiple SSE events and releases the reader', async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\nevent: ready\r\ndata: {"cursor":"x:0"}\r\n\r\nid: x:1\nevent: response.delta\ndata: {"type":"response.delta","id":"x:1","data":{"delta":"你好😀"}}\n\n',
  );
  let cancelled = false;
  const client = new CodexBridgeClient({
    token: 'secret',
    fetch: (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch,
  });
  const events = [];
  for await (const event of client.events({ after: 'x:0' })) {
    events.push(event);
    if (events.length === 2) break;
  }
  assert.equal(events[0]?.type, 'ready');
  assert.equal(events[1]?.id, 'x:1');
  assert.equal(events[1]?.data.delta, '你好😀');
  assert.equal(cancelled, true);
});

test('SDK bounds a multiline SSE frame even when each network chunk is small', async () => {
  let count = 0;
  let cancelled = false;
  const client = new CodexBridgeClient({
    token: 'secret',
    fetch: (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (++count <= 18)
              controller.enqueue(
                new TextEncoder().encode('data: ' + ' '.repeat(1024 * 1024) + '\n'),
              );
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  });
  await assert.rejects(async () => {
    for await (const event of client.events()) void event;
  }, /SSE frame exceeds client limit/);
  assert.equal(cancelled, true);
});

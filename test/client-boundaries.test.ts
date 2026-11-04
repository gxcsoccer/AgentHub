import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessHubClient } from '../src/client.js';
import { testAddress } from './helpers.js';
import { randomUUID } from 'node:crypto';

function streamClient(chunks: Uint8Array[]) {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    client: new HarnessHubClient({
      baseUrl: 'http://localhost',
      token: 'test',
      fetch: async () => new Response(body),
    }),
    cancelled: () => cancelled,
  };
}
test('client forbids nonlocal or credential-bearing URLs and never retries a failed write', async () => {
  for (const baseUrl of [
    'https://localhost',
    'http://external.example',
    'http://user:secret@localhost',
  ])
    assert.throws(() => new HarnessHubClient({ baseUrl, token: 'test' }), /local HTTP/);
  let attempts = 0;
  const client = new HarnessHubClient({
    baseUrl: 'http://localhost',
    token: 'test',
    fetch: async (_url, init) => {
      attempts++;
      assert.equal(init?.redirect, 'error');
      throw new Error('disconnected');
    },
  });
  await assert.rejects(
    client.send({
      messageId: randomUUID(),
      to: testAddress,
      origin: { name: 'test' },
      delivery: 'peer_message',
      text: 'hello',
    }),
    /disconnected/,
  );
  assert.equal(attempts, 1);
});

test('SSE parses split UTF-8 and CRLF, multiline data, comments and releases a cancelled reader', async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\nevent: custom\r\nid: one\r\ndata: {"text":\r\ndata: "中文"}\r\n\r\n',
  );
  const { client, cancelled } = streamClient([...bytes].map((b) => Uint8Array.of(b)));
  const iterator = client.events();
  assert.deepEqual((await iterator.next()).value, {
    event: 'custom',
    id: 'one',
    data: { text: '中文' },
  });
  await iterator.return(undefined);
  assert(cancelled());
});

test('SSE rejects oversized multiline frames but accepts a large chunk containing bounded frames', async () => {
  const encoder = new TextEncoder();
  const oversized = streamClient([
    encoder.encode('data: ' + 'x'.repeat(1100000) + '\n'),
    encoder.encode('data: ' + 'x'.repeat(1100000) + '\n\n'),
  ]);
  await assert.rejects(oversized.client.events().next(), /limit/);
  assert(oversized.cancelled());
  const frame = `data: ${JSON.stringify({ text: 'x'.repeat(2100) })}\n\n`;
  const valid = streamClient([encoder.encode(frame.repeat(1100))]);
  const events = valid.client.events();
  assert.equal(((await events.next()).value?.data as { text: string }).text.length, 2100);
  await events.return(undefined);
  assert(valid.cancelled());
});

test('SSE reports missing body and structured HTTP errors', async () => {
  const empty = new HarnessHubClient({
    baseUrl: 'http://localhost',
    token: 'test',
    fetch: async () => new Response(null),
  });
  await assert.rejects(empty.events().next(), /Missing event stream/);
  const denied = new HarnessHubClient({
    baseUrl: 'http://localhost',
    token: 'test',
    fetch: async () =>
      Response.json({ error: { code: 'unauthorized', message: 'denied' } }, { status: 401 }),
  });
  await assert.rejects(denied.events().next(), /denied/);
});

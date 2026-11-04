import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HarnessHub } from '../src/hub.js';
import { createHubServer } from '../src/server.js';
import { HarnessHubClient } from '../src/client.js';
import { createMcpServer } from '../src/mcp.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Adapter, Envelope, SessionAddress } from '../src/types.js';
const token = 'test-token-'.repeat(5);
const address = { harness: 'claude', instance: 'local', sessionId: 'opaque/session:id' };
class FakeAdapter extends EventEmitter implements Adapter {
  harness = 'claude';
  instance = 'local';
  calls: Envelope[] = [];
  async getSession(a: SessionAddress) {
    return {
      address: a,
      status: 'idle',
      capabilities: { send: ['peer_message'] as const, history: true, liveEvents: false },
    };
  }
  async listSessions() {
    return { data: [await this.getSession(address)], nextCursor: null };
  }
  async history() {
    return { data: [], nextCursor: null };
  }
  async send(e: Envelope) {
    this.calls.push(e);
    return { status: 'transport_written' as const };
  }
  async close() {}
}
async function fixture(t: test.TestContext) {
  const adapter = new FakeAdapter();
  const hub = new HarnessHub([adapter]);
  const app = createHubServer({ hub, token });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const a = app.server.address();
  assert(a && typeof a === 'object');
  const baseUrl = `http://127.0.0.1:${a.port}`;
  const client = new HarnessHubClient({ baseUrl, token });
  t.after(() => app.close());
  return { adapter, hub, app, baseUrl, client };
}
test('HTTP enforces bearer/origin boundaries and the SDK preserves opaque addresses', async (t) => {
  const { baseUrl, client } = await fixture(t);
  assert.equal((await fetch(baseUrl + '/v1/instances')).status, 401);
  assert.equal(
    (
      await fetch(baseUrl + '/v1/instances', {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://other.example' },
      })
    ).status,
    403,
  );
  assert.deepEqual((await client.getSession(address)).address, address);
  await assert.rejects(client.listSessions(address, { limit: 200 }), /1\.\.100/);
});
test('SDK and JSON CLI share the daemon receipt, without repeated submissions', async (t) => {
  const { baseUrl, client, adapter } = await fixture(t);
  const id = randomUUID();
  const input = {
    messageId: id,
    to: address,
    origin: { name: 'test' },
    delivery: 'peer_message' as const,
    text: 'hello',
  };
  await client.send(input);
  await client.send(input);
  assert.equal(adapter.calls.length, 1);
  const output = await promisify(execFile)(
    process.execPath,
    [
      new URL('../src/cli.js', import.meta.url).pathname,
      'status',
      '--url',
      baseUrl,
      '--message-id',
      id,
    ],
    { env: { ...process.env, HARNESSHUB_TOKEN: token } },
  );
  assert.equal(JSON.parse(output.stdout).messageId, id);
  assert.equal(adapter.calls.length, 1);
});
test('SSE replays bounded evidence and rejects a cursor from another process', async (t) => {
  const { hub, client } = await fixture(t);
  const cursor = hub.events.cursor;
  await client.send({
    messageId: randomUUID(),
    to: address,
    origin: { name: 'test' },
    delivery: 'peer_message',
    text: 'hello',
  });
  const stream = client.events({ after: cursor });
  const first = await stream.next();
  assert.equal(first.value?.event, 'message.status');
  await stream.return(undefined);
  const invalid = client.events({ after: 'other:0' });
  await assert.rejects(invalid.next(), /another event log/);
});
test('official MCP client can discover and call the facade; no approval or user-input tool is exposed', async (t) => {
  const { client: api, adapter } = await fixture(t);
  const server = createMcpServer(api, 'Doubao test');
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(a);
  await client.connect(b);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 7);
  assert(!tools.tools.some((x) => /approv|resume|interrupt/.test(x.name)));
  const result = await client.callTool({
    name: 'send_message',
    arguments: { messageId: randomUUID(), to: address, delivery: 'peer_message', text: 'hello' },
  });
  assert.equal(result.isError, undefined);
  assert.equal(adapter.calls[0]?.origin.name, 'Doubao test');
  const unsupported = await client.callTool({
    name: 'send_message',
    arguments: { messageId: randomUUID(), to: address, delivery: 'user_input', text: 'hello' },
  });
  assert.equal(unsupported.isError, true);
  assert.equal(adapter.calls.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { randomUUID } from 'node:crypto';
import { httpFixture, testToken, testAddress, TestAdapter, FakeRpc } from './helpers.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { HubError, addressKey } from '../src/validation.js';
const headers = { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json' };

test('HTTP rejects malformed requests before any native send and allows only configured origins', async (t) => {
  const adapter = new TestAdapter();
  const { baseUrl } = await httpFixture(t, adapter, ['https://allowed.example']);
  const preflight = await fetch(baseUrl, {
    method: 'OPTIONS',
    headers: { Origin: 'https://allowed.example' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://allowed.example');
  const allowed = await fetch(baseUrl + '/v1/instances', {
    headers: { ...headers, Origin: 'https://allowed.example' },
  });
  assert.equal(allowed.status, 200);
  for (const [body, status] of [
    ['{', 400],
    ['null', 400],
    ['[]', 400],
    ['"' + 'x'.repeat(1024 * 1024) + '"', 413],
  ] as const) {
    const response = await fetch(baseUrl + '/v1/messages', { method: 'POST', headers, body });
    assert.equal(response.status, status);
    await response.arrayBuffer();
  }
  assert.equal(
    (
      await fetch(baseUrl + '/v1/messages', {
        method: 'POST',
        headers: { Authorization: headers.Authorization },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal((await fetch(baseUrl + '/unknown', { headers })).status, 404);
  assert.equal((await fetch(baseUrl + '/v1/messages/%ZZ', { headers })).status, 400);
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    get(baseUrl + '/v1/instances', { headers: { ...headers, Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(baseUrl + '/openapi.json', { headers })).status, 200);
  assert.equal(adapter.calls.length, 0);
});

test('HTTP exposes explicit Codex approval responses, expiry and unsupported-adapter errors', async (t) => {
  const rpc = new FakeRpc(),
    id = randomUUID();
  rpc.handlers.set('thread/read', () => ({ thread: { id, canAcceptDirectInput: true } }));
  rpc.handlers.set('thread/loaded/list', () => ({ data: [id] }));
  rpc.handlers.set('turn/start', () => ({ turn: { id: 'turn' } }));
  const adapter = new CodexAdapter({ rpc, requestTtlMs: 100 });
  const { client, baseUrl } = await httpFixture(t, adapter);
  const scope = { harness: 'codex', instance: 'local' };
  await client.send({
    messageId: randomUUID(),
    to: { ...scope, sessionId: id },
    origin: { name: 'test' },
    delivery: 'tool_output',
    text: 'hello',
  });
  rpc.emit('request', {
    id: 'approval',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: id },
  });
  const pending = (await client.pendingRequests(scope)).data;
  assert.equal(pending.length, 1);
  assert.equal(rpc.responses.length, 0);
  const url = `${baseUrl}/v1/interactions/${pending[0]!.id}?harness=codex`;
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
  await client.respondToRequest(scope, String(pending[0]!.id), { decision: 'decline' });
  assert.deepEqual(rpc.responses[0], { id: 'approval', result: { decision: 'decline' } });
  await assert.rejects(
    client.respondToRequest(scope, String(pending[0]!.id), { decision: 'accept' }),
    /not found/,
  );
  rpc.emit('request', {
    id: 'expire',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: id },
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal((await client.pendingRequests(scope)).data.length, 0);
  assert.match(JSON.stringify(rpc.responses.at(-1)), /expiry/);
  const unsupported = await httpFixture(t);
  await assert.rejects(unsupported.client.pendingRequests(testAddress), /does not expose/);
  await assert.rejects(
    unsupported.client.respondToRequest(testAddress, 'id', {}),
    /does not expose/,
  );
});

test('SSE filters composite addresses, detects expired cursors and ends slow consumers with a gap', async (t) => {
  const { hub, client, baseUrl } = await httpFixture(t);
  const cursor = hub.events.cursor;
  hub.events.publish('hidden', {}, addressKey({ ...testAddress, instance: 'other' }));
  hub.events.publish('visible', { ok: true }, addressKey(testAddress));
  const stream = client.events({ after: cursor, address: testAddress });
  assert.equal((await stream.next()).value?.event, 'visible');
  await stream.return(undefined);
  for (let i = 0; i < 2010; i++) hub.events.publish('fill', { i });
  const stale = client.events({ after: cursor });
  await assert.rejects(stale.next(), /expired|retained|old/i);
  const body = await new Promise<string>((resolve, reject) => {
    const req = get(baseUrl + '/v1/events', { headers }, (res) => {
      res.pause();
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (x) => {
        data += x;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
      for (let i = 0; i < 40; i++) hub.events.publish('large', { text: 'x'.repeat(100000) });
      res.resume();
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('SSE did not terminate')));
  });
  assert.match(body, /event: gap/);
  assert.match(body, /slow_consumer/);
});

test('HTTP preserves a backend failure and a long poll observes the subsequent correlated reply', async (t) => {
  const adapter = new TestAdapter();
  const { client } = await httpFixture(t, adapter);
  adapter.history = async () => {
    throw new HubError('backend_failure', 'history unavailable', 502);
  };
  await assert.rejects(
    client.history(testAddress),
    (e: unknown) => (e as { code: string }).code === 'backend_failure',
  );
  const m = {
    messageId: randomUUID(),
    to: testAddress,
    origin: { name: 'test' },
    text: 'hello',
    delivery: 'peer_message' as const,
  };
  await client.send(m);
  const waiting = client.receipt(m.messageId, 1000);
  adapter.emit('update', { messageId: m.messageId, status: 'replied', reply: { text: 'answer' } });
  assert.equal((await waiting).reply?.text, 'answer');
  await assert.rejects(client.receipt(m.messageId, -1), /timeoutMs/);
});

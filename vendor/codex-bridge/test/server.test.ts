import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBridgeServer } from '../src/server.js';
import { readyRpc, sessionId, turnId } from './helpers.js';

const token = 'test-token-with-at-least-32-characters';
async function fixture(
  t: TestContext,
  options: { allowedOrigins?: string[]; requestTtlMs?: number } = {},
) {
  const rpc = readyRpc();
  const app = createBridgeServer({ rpc, token, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => app.close());
  const request = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  return { app, rpc, base, request };
}
function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

test('oversized and non-JSON bodies fail without reaching Codex', async (t) => {
  const { request, rpc } = await fixture(t);
  assert.equal(
    (
      await request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal((await request('/v1/sessions', json({ cwd: 'x'.repeat(1024 * 1024) }))).status, 413);
  assert.equal(rpc.calls.length, 0);
});

test('HTTP requires bearer auth, rejects browser origins by default, and limits CORS explicitly', async (t) => {
  const { request, base, rpc } = await fixture(t, { allowedOrigins: ['http://localhost:3000'] });
  assert.equal((await fetch(base + '/v1/sessions')).status, 401);
  assert.equal(
    (await request('/v1/sessions', { headers: { Origin: 'https://attacker.test' } })).status,
    403,
  );
  const preflight = await fetch(base + '/v1/sessions', {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  assert.equal(rpc.calls.length, 0);
});

test('list/detail/search expose pagination and encoded literal queries', async (t) => {
  const { request, rpc } = await fixture(t);
  rpc.handlers.set('thread/list', (params) => ({ data: [], nextCursor: 'page/+=', params }));
  rpc.handlers.set('thread/search', (params) => ({ data: [], nextCursor: null, params }));
  const list = await (
    await request('/v1/sessions?limit=2&archived=false&cursor=page%2F%2B%3D')
  ).json();
  assert.equal(list.nextCursor, 'page/+=');
  assert.deepEqual(list.params, { limit: 2, archived: false, cursor: 'page/+=' });
  const search = await (await request('/v1/sessions/search?q=foo%2Bbar')).json();
  assert.equal(search.params.searchTerm, 'foo+bar');
  assert.equal((await request(`/v1/sessions/${sessionId}`)).status, 200);
  assert.ok(!rpc.calls.some((c) => c.method === 'thread/resume'));
});

test('unknown fields, malformed JSON, invalid pagination and unsupported routes fail before RPC', async (t) => {
  const { request, rpc } = await fixture(t);
  assert.equal((await request('/v1/sessions?limit=NaN')).status, 400);
  assert.equal((await request('/v1/sessions?limit=10001')).status, 400);
  assert.equal((await request('/v1/sessions?limit=1&limit=2')).status, 400);
  assert.equal((await request('/v1/sessions?magic=true')).status, 400);
  assert.equal((await request('/v1/sessions?__proto__=hidden')).status, 400);
  assert.equal((await request('/v1/sessions?constructor=hidden')).status, 400);
  assert.equal((await request('/v1/sessions/search')).status, 400);
  assert.equal((await request('/v1/unknown')).status, 404);
  assert.equal(
    (
      await request(`/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/v1/sessions/${sessionId}/messages`,
        json({ text: 'x', source: 'app', approvalPolicy: 'never' }),
      )
    ).status,
    400,
  );
  assert.equal(rpc.calls.length, 0);
});

test('HTTP messages require idempotency and concurrent duplicates share one receipt', async (t) => {
  const { request, rpc } = await fixture(t);
  const path = `/v1/sessions/${sessionId}/messages`;
  assert.equal((await request(path, json({ text: 'x', source: 'app' }))).status, 400);
  const init = json({ text: 'x', source: 'app' });
  init.headers = { ...init.headers, 'Idempotency-Key': 'same-http-message' };
  const [a, b] = await Promise.all([request(path, init), request(path, init)]);
  assert.equal(a.status, 202);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(rpc.calls.filter((c) => c.method === 'turn/start').length, 1);
});

test('context injection preserves attribution without starting, steering or resuming work', async (t) => {
  const { request, rpc } = await fixture(t);
  rpc.handlers.set('thread/inject_items', () => ({}));
  const response = await request(
    `/v1/sessions/${sessionId}/context`,
    json({ text: 'Build 123 passed.', source: 'CI' }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    rpc.calls.map((call) => call.method),
    ['thread/read', 'thread/inject_items'],
  );
  assert.deepEqual(rpc.calls[1]?.params, {
    threadId: sessionId,
    items: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[External context: CI]\nBuild 123 passed.' }],
      },
    ],
  });
});

test('explicit lifecycle operations preserve the requested thread and never grant extra permissions', async (t) => {
  const { request, rpc } = await fixture(t);
  for (const method of [
    'thread/start',
    'thread/fork',
    'thread/name/set',
    'thread/archive',
    'thread/unarchive',
    'thread/unsubscribe',
  ])
    rpc.handlers.set(method, (params) => params);
  assert.equal(
    (await request('/v1/sessions', json({ cwd: '/workspace', model: 'configured-model' }))).status,
    201,
  );
  assert.equal(
    (await request(`/v1/sessions/${sessionId}/fork`, json({ lastTurnId: turnId }))).status,
    201,
  );
  assert.equal(
    (await request(`/v1/sessions/${sessionId}`, { ...json({ name: 'CI work' }), method: 'PATCH' }))
      .status,
    200,
  );
  for (const action of ['archive', 'unarchive', 'detach'])
    assert.equal(
      (await request(`/v1/sessions/${sessionId}/${action}`, { method: 'POST' })).status,
      200,
    );
  assert.deepEqual(
    rpc.calls.map((call) => call.params),
    [
      { cwd: '/workspace', model: 'configured-model' },
      { threadId: sessionId, lastTurnId: turnId },
      { threadId: sessionId, name: 'CI work' },
      { threadId: sessionId },
      { threadId: sessionId },
      { threadId: sessionId },
    ],
  );
});

test('SSE sends live events with IDs and replays from Last-Event-ID', async (t) => {
  const { request, rpc, app } = await fixture(t);
  const initial = app.events.cursor;
  rpc.emit('notification', {
    method: 'item/agentMessage/delta',
    params: { threadId: sessionId, turnId, delta: 'hello' },
  });
  const abort = new AbortController();
  const response = await request(`/v1/events?sessionId=${sessionId}`, {
    headers: { 'Last-Event-ID': initial },
    signal: abort.signal,
  });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  assert.match(frame, /event: response.delta/);
  assert.match(frame, /"delta":"hello"/);
  assert.match(frame, /id: /);
  abort.abort();
  await reader.cancel().catch(() => {});
});

test('approval requests remain pending until an explicit response and cannot be replied twice', async (t) => {
  const { request, rpc } = await fixture(t);
  rpc.emit('request', {
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: sessionId, command: 'npm test' },
  });
  const list = await (await request('/v1/requests')).json();
  assert.equal(list.data.length, 1);
  assert.equal(rpc.replies.length, 0);
  const path = `/v1/requests/${list.data[0].id}/response`;
  assert.equal((await request(path, json({ result: { decision: 'decline' } }))).status, 202);
  assert.deepEqual(rpc.replies, [{ id: 42, response: { result: { decision: 'decline' } } }]);
  assert.equal((await request(path, json({ result: { decision: 'accept' } }))).status, 404);
});

test('requests resolved by another client disappear; disconnect invalidates stale responses', async (t) => {
  const { request, rpc } = await fixture(t);
  rpc.emit('request', {
    id: 1,
    method: 'item/tool/requestUserInput',
    params: { threadId: sessionId },
  });
  rpc.emit('notification', {
    method: 'serverRequest/resolved',
    params: { threadId: sessionId, requestId: 1 },
  });
  assert.deepEqual(await (await request('/v1/requests')).json(), { data: [] });
  rpc.emit('request', {
    id: 2,
    method: 'item/tool/requestUserInput',
    params: { threadId: sessionId },
  });
  rpc.close();
  assert.deepEqual(await (await request('/v1/requests')).json(), { data: [] });
  assert.equal(rpc.replies.length, 0);
});

test('unanswered requests expire with an error, never approval', async (t) => {
  const { request, rpc } = await fixture(t, { requestTtlMs: 10 });
  rpc.emit('request', {
    id: 7,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: sessionId },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(await (await request('/v1/requests')).json(), { data: [] });
  assert.equal(rpc.replies.length, 1);
  assert.ok((rpc.replies[0]?.response as { error?: unknown }).error);
});

test('OpenAPI lists the implemented operations and authentication scheme', async (t) => {
  const { request } = await fixture(t);
  const spec = await (await request('/openapi.json')).json();
  assert.equal(spec.openapi, '3.1.0');
  for (const path of [
    '/v1/sessions',
    '/v1/sessions/search',
    '/v1/sessions/{sessionId}',
    '/v1/sessions/{sessionId}/messages',
    '/v1/events',
  ])
    assert.ok(spec.paths[path]);
  assert.equal(spec.components.securitySchemes.bearerAuth.type, 'http');
});

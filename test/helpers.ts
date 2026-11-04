import { EventEmitter } from 'node:events';
import type { Rpc } from '../vendor/codex-bridge/src/rpc.js';
import type { Json } from '../src/types.js';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { AgentHub } from '../src/hub.js';
import { AgentHubClient } from '../src/client.js';
import { createHubServer } from '../src/server.js';
import type {
  Adapter,
  Envelope,
  PageQuery,
  SessionAddress,
  SessionInfo,
  Submission,
} from '../src/types.js';

export const testToken = 'agenthub-local-test-'.repeat(3);
export const testAddress = { harness: 'test', instance: 'local', sessionId: 'opaque/id:1' };
export class TestAdapter extends EventEmitter implements Adapter {
  harness = 'test';
  instance = 'local';
  calls: Envelope[] = [];
  queries: PageQuery[] = [];
  async getSession(a: SessionAddress): Promise<SessionInfo> {
    return {
      address: a,
      status: 'idle',
      capabilities: { send: ['peer_message'], history: true, liveEvents: false },
    };
  }
  async listSessions(q: PageQuery = {}) {
    this.queries.push(q);
    return { data: [await this.getSession(testAddress)], nextCursor: q.cursor ? null : 'next' };
  }
  async history(
    _a: SessionAddress,
    q: PageQuery = {},
  ): Promise<import('../src/types.js').Page<import('../src/types.js').HistoryEntry>> {
    this.queries.push(q);
    return {
      data: [{ id: 'h1', kind: 'peerMessage', text: 'history text', native: {} }],
      nextCursor: null,
    };
  }
  async send(e: Envelope): Promise<Submission> {
    this.calls.push(e);
    return { status: 'accepted' };
  }
  async close() {}
}
export async function httpFixture(
  t: TestContext,
  adapter: Adapter = new TestAdapter(),
  allowedOrigins?: string[],
) {
  const hub = new AgentHub([adapter]);
  const app = createHubServer({ hub, token: testToken, allowedOrigins });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const info = app.server.address();
  if (!info || typeof info === 'string') throw new Error('Missing server address');
  const baseUrl = `http://127.0.0.1:${info.port}`;
  t.after(() => app.close());
  return { hub, app, baseUrl, client: new AgentHubClient({ baseUrl, token: testToken }) };
}
export class FakeRpc extends EventEmitter implements Rpc {
  connected = true;
  calls: { method: string; params: Json }[] = [];
  responses: unknown[] = [];
  handlers = new Map<string, (params: Json) => unknown>();
  async request(method: string, params: Json = {}) {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error('Unexpected ' + method);
    return handler(params);
  }
  respond(id: string | number, response: { result: unknown } | { error: Json }) {
    this.responses.push({ id, ...response });
  }
  close() {
    this.connected = false;
    this.emit('disconnect');
  }
}

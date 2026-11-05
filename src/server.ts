import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { authenticator, OWNER, type CallerCredential } from './access.js';
import type { ConnectorService } from './connectors/service.js';
import type { HubEvent } from './events.js';
import { AgentHub } from './hub.js';
import {
  address,
  addressKey,
  errorMessage,
  HubError,
  object,
  pageQuery,
  text,
} from './validation.js';
import { openApi } from './openapi.js';
import type { Json, MessageInput } from './types.js';

export function createHubServer(options: {
  hub: AgentHub;
  token: string;
  allowedOrigins?: string[];
  callers?: CallerCredential[];
  connectors?: ConnectorService;
}) {
  const authenticate = authenticator(options.token, options.callers ?? [], options.hub.access);
  options.connectors?.assertCredentialSeparation([
    options.token,
    ...(options.callers ?? []).map((caller) => caller.token),
  ]);
  const streams = new Set<ServerResponse>();
  const { hub } = options;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const e = error as { status?: number; code?: string };
      sendJson(res, e.status ?? 500, {
        error: { code: e.code ?? 'internal_error', message: errorMessage(error) },
      });
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))
      throw new HubError('invalid_host', 'Use a loopback host', 403);
    const origin = req.headers.origin;
    if (origin && !options.allowedOrigins?.includes(origin))
      throw new HubError('origin_denied', 'Browser origin is not allowed', 403);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS' && origin) {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
      });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (
      req.method === 'POST' &&
      ['/v1/connector/enroll', '/v1/connector/hook', '/v1/connector/call'].includes(url.pathname)
    ) {
      if (!options.connectors)
        throw new HubError('connector_disabled', 'Connectors are not configured', 503);
      const token = /^Bearer (\S{32,512})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new HubError('invalid_credential', 'Connector credential required', 401);
      const body = await readBody(req);
      let result: unknown;
      if (url.pathname === '/v1/connector/enroll')
        result = await options.connectors.enroll(token, body);
      else if (url.pathname === '/v1/connector/hook')
        result = await options.connectors.hook(token, body);
      else {
        if (Object.keys(body).some((key) => !['evidence', 'operation'].includes(key)))
          throw new HubError('invalid_input', 'Unexpected connector input');
        result = await options.connectors.call(token, body.evidence, body.operation);
      }
      sendJson(res, 200, result);
      return;
    }
    const callerId = authenticate(req.headers.authorization);
    await hub.ready();
    if (req.method === 'POST' && url.pathname === '/v1/connect') {
      if (callerId !== OWNER)
        throw new HubError('forbidden', 'Connector installation requires the owner', 403);
      if (!options.connectors)
        throw new HubError('connector_disabled', 'Connectors are not configured', 503);
      sendJson(
        res,
        200,
        await options.connectors.connect(await readBody(req), req.socket.localPort!),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/disconnect') {
      if (callerId !== OWNER)
        throw new HubError('forbidden', 'Connector disconnection requires the owner', 403);
      if (!options.connectors)
        throw new HubError('connector_disabled', 'Connectors are not configured', 503);
      sendJson(res, 200, await options.connectors.disconnect(await readBody(req)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/connections') {
      if (callerId !== OWNER)
        throw new HubError('forbidden', 'Connection diagnostics require the owner', 403);
      if (!options.connectors)
        throw new HubError('connector_disabled', 'Connectors are not configured', 503);
      sendJson(res, 200, await options.connectors.connections());
      return;
    }
    const q = Object.fromEntries(url.searchParams);
    const scope = () => ({
      harness: text(q.harness, 'harness', 64),
      instance: text(q.instance ?? 'local', 'instance', 128),
    });
    const session = () => address({ ...scope(), sessionId: q.sessionId });
    const query = () =>
      pageQuery({ ...q, ...(q.limit !== undefined ? { limit: Number(q.limit) } : {}) });
    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      sendJson(res, 200, openApi);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/instances') {
      sendJson(res, 200, { data: hub.instances(callerId), eventCursor: hub.events.cursor });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
      sendJson(res, 200, await hub.listSessions(scope(), query(), callerId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = await readBody(req);
      sendJson(
        res,
        201,
        await hub.createSession(
          {
            harness: text(body.harness, 'harness', 64),
            instance: text(body.instance, 'instance', 128),
          },
          text(body.cwd, 'cwd', 4096),
          callerId,
        ),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/prompts') {
      sendJson(
        res,
        202,
        await hub.prompt((await readBody(req)) as unknown as MessageInput, callerId),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/session/cancel') {
      await hub.cancel(address((await readBody(req)).address), callerId);
      sendJson(res, 200, { cancelled: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/session') {
      sendJson(res, 200, await hub.getSession(session(), callerId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/session/attach-reply') {
      const body = await readBody(req);
      if (body.acceptResumeRace !== true)
        throw new HubError('acknowledgment_required', 'Explicit acceptResumeRace:true is required');
      sendJson(
        res,
        200,
        await hub.attachReplyRoute(address(body.address), { acceptResumeRace: true }, callerId),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/search') {
      sendJson(
        res,
        200,
        await hub.search(
          session(),
          { ...query(), search: text(q.search, 'search', 2000) },
          callerId,
        ),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/history') {
      sendJson(res, 200, await hub.history(session(), query(), callerId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      sendJson(
        res,
        202,
        await hub.send((await readBody(req)) as unknown as MessageInput, callerId),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/messages/')) {
      const id = decodePath(url.pathname.slice('/v1/messages/'.length));
      sendJson(
        res,
        200,
        await hub.wait(id, q.waitMs === undefined ? 0 : Number(q.waitMs), callerId),
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/interactions') {
      hub.access.require(callerId, 'approve', scope());
      const adapter = hub.adapter(scope());
      if (!adapter.pendingRequests)
        throw new HubError('unsupported', 'This adapter does not expose approval responses', 501);
      sendJson(res, 200, {
        data: adapter
          .pendingRequests()
          .filter((r) => hub.access.allows(callerId, 'approve', r.address, r.address.sessionId)),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/interactions/')) {
      hub.access.require(callerId, 'approve', scope());
      const adapter = hub.adapter(scope());
      if (!adapter.respondToRequest)
        throw new HubError('unsupported', 'This adapter does not expose approval responses', 501);
      const body = await readBody(req);
      if (!Object.hasOwn(body, 'result'))
        throw new HubError('invalid_input', 'Explicit result is required');
      const id = decodePath(url.pathname.slice('/v1/interactions/'.length));
      const pending = adapter.pendingRequests?.().find((r) => r.id === id);
      if (
        !pending ||
        !hub.access.allows(callerId, 'approve', pending.address, pending.address.sessionId)
      )
        throw new HubError('request_not_found', 'Interaction not found', 404);
      await adapter.respondToRequest(id, body.result);
      sendJson(res, 200, { responded: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const after = q.after ?? req.headers['last-event-id'];
      if (Array.isArray(after))
        throw new HubError('invalid_input', 'Only one event cursor is allowed');
      if (q.sessionId && !hub.access.receipt(callerId, callerId, session()))
        throw new HubError('forbidden', 'Event target is not authorized', 403);
      const key = q.sessionId ? addressKey(session()) : undefined;
      const replay = after ? hub.events.replay(after, key) : [];
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      streams.add(res);
      const send = (event: HubEvent) => {
        if (!hub.access.event(callerId, event)) return;
        if (res.destroyed || res.writableEnded) return;
        if (key && event.sessionId && event.sessionId !== key) return;
        if (res.writableLength > 1024 * 1024) {
          res.end('event: gap\ndata: {"reason":"slow_consumer"}\n\n');
          return;
        }
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      let heartbeat: NodeJS.Timeout | undefined;
      res.on('close', () => {
        clearInterval(heartbeat);
        hub.events.off('event', send);
        streams.delete(res);
      });
      for (const event of replay) send(event);
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ready\ndata: ${JSON.stringify({ cursor: hub.events.cursor })}\n\n`);
      hub.events.on('event', send);
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
      }, 15000);
      heartbeat.unref();
      return;
    }
    throw new HubError('not_found', 'Unknown endpoint', 404);
  }
  return {
    server,
    async close() {
      for (const stream of streams) stream.end();
      await hub.close();
      server.closeIdleConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HubError('invalid_input', 'Malformed URL encoding');
  }
}
async function readBody(req: IncomingMessage): Promise<Json> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new HubError('unsupported_media_type', 'Use application/json', 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const b = Buffer.from(chunk as Uint8Array);
    bytes += b.length;
    if (bytes > 1024 * 1024) throw new HubError('body_too_large', 'Body exceeds 1 MiB', 413);
    chunks.push(b);
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError('invalid_json', 'Invalid JSON body');
  }
}
function sendJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

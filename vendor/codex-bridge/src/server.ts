import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { BridgeEvent, JsonObject, MessageInput } from './contracts.js';
import type { Rpc } from './rpc.js';
export { CodexRpc, type Rpc, type RpcOptions } from './rpc.js';
import { Bridge } from './bridge.js';
import { EventLog } from './events.js';
import { BridgeError, errorBody, object, sessionId, text } from './errors.js';
import { openApi, queryInput, routes, validate, type Route } from './routes.js';
export interface ServerOptions {
  rpc: Rpc;
  token: string;
  allowedOrigins?: string[];
  requestTtlMs?: number;
}
export interface BridgeServer {
  server: Server;
  bridge: Bridge;
  events: EventLog;
  close(): Promise<void>;
}
interface PendingRequest {
  id: string;
  upstreamId: string | number;
  method: string;
  params: JsonObject;
  sessionId: string | null;
  timer: NodeJS.Timeout;
}

export function createBridgeServer(options: ServerOptions): BridgeServer {
  if (options.token.length < 32) throw new Error('Bridge token must be at least 32 characters');
  const { rpc } = options;
  const bridge = new Bridge(rpc);
  const events = new EventLog();
  const pending = new Map<string, PendingRequest>();
  const streams = new Set<ServerResponse>();
  const token = Buffer.from(`Bearer ${options.token}`);
  const publicRequest = (entry: PendingRequest): JsonObject => ({
    id: entry.id,
    method: entry.method,
    sessionId: entry.sessionId,
    params: entry.params,
  });
  const removeRequest = (id: string): void => {
    const entry = pending.get(id);
    if (entry) clearTimeout(entry.timer);
    pending.delete(id);
  };

  const onRequest = (message: {
    id: string | number;
    method: string;
    params: JsonObject;
  }): void => {
    if (pending.size >= 128) {
      rpc.respond(message.id, {
        error: { code: -32000, message: 'Bridge interaction capacity reached' },
      });
      return;
    }
    const id = randomUUID();
    const thread = typeof message.params.threadId === 'string' ? message.params.threadId : null;
    const timer = setTimeout(() => {
      removeRequest(id);
      if (rpc.connected)
        rpc.respond(message.id, {
          error: {
            code: -32000,
            message: 'External application did not respond before the request expired',
          },
        });
      events.publish('request.expired', { requestId: id }, thread);
    }, options.requestTtlMs ?? 300_000);
    timer.unref();
    const entry: PendingRequest = {
      id,
      upstreamId: message.id,
      method: message.method,
      params: message.params,
      sessionId: thread,
      timer,
    };
    pending.set(id, entry);
    events.publish('request.pending', publicRequest(entry), thread);
  };
  const onNotification = (message: { method: string; params: JsonObject }): void => {
    const params = message.params;
    if (message.method === 'serverRequest/resolved') {
      for (const [id, entry] of pending)
        if (entry.upstreamId === params.requestId) removeRequest(id);
    }
    const names: Record<string, string> = {
      'turn/started': 'turn.started',
      'turn/completed': 'turn.completed',
      'item/agentMessage/delta': 'response.delta',
      'thread/status/changed': 'session.status',
      'item/started': 'item.started',
      'item/completed': 'item.completed',
    };
    const turn =
      params.turn && typeof params.turn === 'object' ? (params.turn as JsonObject).id : null;
    events.publish(
      names[message.method] ?? `codex.${message.method.replaceAll('/', '.')}`,
      params,
      typeof params.threadId === 'string' ? params.threadId : null,
      typeof params.turnId === 'string' ? params.turnId : typeof turn === 'string' ? turn : null,
    );
  };
  const onDisconnect = (): void => {
    for (const id of pending.keys()) removeRequest(id);
    events.publish('bridge.disconnected', { requiresReattach: true, gap: true });
  };
  const onConnected = (): void => {
    events.publish('bridge.connected', { requiresReattach: true });
  };
  rpc
    .on('request', onRequest)
    .on('notification', onNotification)
    .on('disconnect', onDisconnect)
    .on('connected', onConnected);

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const response = errorBody(error);
      sendJson(res, response.status, response.body);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const origin = req.headers.origin;
    if (origin && !options.allowedOrigins?.includes(origin))
      throw new BridgeError(403, 'origin_forbidden', 'This browser origin is not allowed');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (!origin) throw new BridgeError(400, 'invalid_input', 'CORS preflight requires Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, Last-Event-ID',
      );
      res.writeHead(204).end();
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? '');
    if (supplied.length !== token.length || !timingSafeEqual(supplied, token))
      throw new BridgeError(401, 'unauthorized', 'A valid Bearer token is required');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/openapi.json' && req.method === 'GET') {
      sendJson(res, 200, openApi());
      return;
    }
    const matched = matchRoute(req.method ?? '', url.pathname);
    if (!matched) throw new BridgeError(404, 'not_found', 'API route not found');
    const { route, pathParams } = matched;
    const query = queryInput(url.searchParams, route.query);
    const body = req.method === 'GET' ? {} : validate(await readBody(req), route.body);
    const id = pathParams.sessionId ? sessionId(pathParams.sessionId) : '';
    if (query.sessionId !== undefined) sessionId(query.sessionId);
    if (route.operationId === 'events') {
      if (streams.size >= 64)
        throw new BridgeError(429, 'stream_capacity', 'Too many event streams');
      const after = query.after ?? req.headers['last-event-id'];
      const filter = typeof query.sessionId === 'string' ? query.sessionId : undefined;
      const backlog = after === undefined ? [] : events.replay(text(after, 'after', 128), filter);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      streams.add(res);
      const write = (event: BridgeEvent): void => {
        if (filter && event.sessionId !== null && event.sessionId !== filter) return;
        if (res.writableLength > 512 * 1024) {
          res.destroy();
          return;
        }
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      events.on('event', write);
      for (const event of backlog) write(event);
      res.write(
        `event: ready\ndata: ${JSON.stringify({ cursor: events.cursor, connected: rpc.connected })}\n\n`,
      );
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
      heartbeat.unref();
      res.on('close', () => {
        clearInterval(heartbeat);
        streams.delete(res);
        events.off('event', write);
      });
      return;
    }
    const result = await dispatch(route, id, pathParams, query, body, req);
    sendJson(res, route.status ?? 200, result ?? {});
  }

  async function dispatch(
    route: Route,
    id: string,
    path: Record<string, string>,
    query: JsonObject,
    body: JsonObject,
    req: IncomingMessage,
  ): Promise<unknown> {
    switch (route.operationId) {
      case 'capabilities':
        return {
          version: '0.1.0',
          connected: rpc.connected,
          eventCursor: events.cursor,
          nativeAgentMessaging: false,
          idempotency: { retentionHours: 24, durable: false },
          operations: routes.map((route) => route.operationId),
        };
      case 'listSessions':
        return bridge.list(query);
      case 'loadedSessions':
        return bridge.loaded(query);
      case 'sessionDetail':
        return bridge.detail(id);
      case 'searchSessions': {
        const { q, ...rest } = query;
        return bridge.search({ ...rest, searchTerm: q });
      }
      case 'searchOccurrences': {
        const { q, ...rest } = query;
        return bridge.occurrences(id, { ...rest, searchTerm: q });
      }
      case 'listTurns':
        return bridge.turns(id, query);
      case 'listItems':
        return bridge.items(id, query);
      case 'resumeSession':
        return bridge.resume(id);
      case 'attachSession':
        return bridge.attach(id);
      case 'sendMessage':
        return bridge.send(
          id,
          body as unknown as MessageInput,
          text(req.headers['idempotency-key'], 'Idempotency-Key', 128),
        );
      case 'interruptTurn':
        return bridge.interrupt(id, String(body.turnId));
      case 'createSession':
        return rpc.request('thread/start', body);
      case 'forkSession':
        return rpc.request('thread/fork', { ...body, threadId: id });
      case 'renameSession':
        return rpc.request('thread/name/set', { threadId: id, name: body.name });
      case 'detachSession':
        return rpc.request('thread/unsubscribe', { threadId: id });
      case 'archiveSession':
        return rpc.request('thread/archive', { threadId: id });
      case 'unarchiveSession':
        return rpc.request('thread/unarchive', { threadId: id });
      case 'injectContext': {
        // Injection never restores the thread. App Server performs the loaded/ownership checks.
        await bridge.detail(id);
        return rpc.request('thread/inject_items', {
          threadId: id,
          items: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: `[External context: ${body.source}]\n${body.text}` },
              ],
            },
          ],
        });
      }
      case 'pendingRequests':
        return {
          data: [...pending.values()]
            .filter((entry) => !query.sessionId || entry.sessionId === query.sessionId)
            .map(publicRequest),
        };
      case 'respondToRequest': {
        const requestId = path.requestId!;
        const entry = pending.get(requestId);
        if (!entry)
          throw new BridgeError(
            404,
            'request_not_pending',
            'Request expired, resolved or belongs to another bridge connection',
          );
        if (Object.hasOwn(body, 'result') === Object.hasOwn(body, 'error'))
          throw new BridgeError(400, 'invalid_input', 'Provide exactly one of result or error');
        if (body.error) {
          const error = object(body.error);
          if (!Number.isSafeInteger(error.code) || typeof error.message !== 'string')
            throw new BridgeError(
              400,
              'invalid_input',
              'error requires an integer code and string message',
            );
          rpc.respond(entry.upstreamId, { error });
        } else rpc.respond(entry.upstreamId, { result: body.result });
        removeRequest(requestId);
        events.publish('request.responded', { requestId }, entry.sessionId);
        return { status: 'submitted', requestId };
      }
      default:
        throw new BridgeError(404, 'not_found', 'Operation not found');
    }
  }

  return {
    server,
    bridge,
    events,
    async close() {
      rpc
        .off('request', onRequest)
        .off('notification', onNotification)
        .off('disconnect', onDisconnect)
        .off('connected', onConnected);
      for (const id of pending.keys()) removeRequest(id);
      for (const response of streams) response.destroy();
      rpc.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function matchRoute(
  method: string,
  path: string,
): { route: Route; pathParams: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const pattern = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    const matched = new RegExp(`^${pattern}$`).exec(path);
    if (!matched) continue;
    const pathParams: Record<string, string> = {};
    try {
      names.forEach((name, i) => {
        pathParams[name] = decodeURIComponent(matched[i + 1]!);
      });
    } catch {
      throw new BridgeError(400, 'invalid_input', 'Malformed URL encoding');
    }
    return { route, pathParams };
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 1024 * 1024) throw new BridgeError(413, 'body_too_large', 'JSON body exceeds 1 MiB');
    chunks.push(bytes);
  }
  if (!size) return {};
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new BridgeError(415, 'unsupported_media_type', 'Use Content-Type: application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BridgeError(400, 'invalid_json', 'Body is not valid JSON');
  }
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

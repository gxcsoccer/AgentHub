import type { Json } from './types.js';
const string = { type: 'string' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Json, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
const array = (items: Json) => ({ type: 'array', items });
const json = (schema: Json, description = 'JSON result') => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 501, 502, 503, 504].map((status) => [
    status,
    json(ref('Error'), 'Structured error'),
  ]),
);
const responses = (schema: Json, status = 200) => ({ ...errors, [status]: json(schema) });
const param = (name: string, schema: Json = string, required = false, location = 'query') => ({
  in: location,
  name,
  required,
  schema,
});
const scope = [
  param('harness', string, true),
  param('instance', { type: 'string', default: 'local' }),
];
const session = [...scope, param('sessionId', string, true)];
const pagination = [
  param('cursor'),
  param('limit', { type: 'integer', minimum: 1, maximum: 100, default: 50 }),
  param('search'),
];
const body = (schema: Json) => ({ required: true, content: { 'application/json': { schema } } });
const schemas = {
  SessionAddress: object({ harness: string, instance: string, sessionId: string }, [
    'harness',
    'instance',
    'sessionId',
  ]),
  Origin: object({ name: { type: 'string', maxLength: 128 }, session: ref('SessionAddress') }, [
    'name',
  ]),
  Capabilities: object(
    {
      send: array({ enum: ['tool_output', 'peer_message', 'user_input'] }),
      history: { type: 'boolean' },
      liveEvents: { type: 'boolean' },
      reply: { enum: ['registered_tool', 'native_callback'] },
      experimental: string,
    },
    ['send', 'history', 'liveEvents'],
  ),
  Session: object(
    {
      address: ref('SessionAddress'),
      status: string,
      name: string,
      cwd: string,
      capabilities: ref('Capabilities'),
      metadata: { type: 'object' },
      replyReadiness: ref('ReplyReadiness'),
    },
    ['address', 'status', 'capabilities'],
  ),
  ReplyReadiness: object(
    {
      state: { enum: ['ready', 'needs_attach', 'missing_tool', 'unknown', 'unavailable'] },
      tool: { enum: ['present', 'missing', 'unknown'] },
      listener: { enum: ['attached', 'detached', 'unknown'] },
      reason: string,
    },
    ['state', 'tool', 'listener', 'reason'],
  ),
  SessionPage: object({ data: array(ref('Session')), nextCursor: { type: ['string', 'null'] } }, [
    'data',
    'nextCursor',
  ]),
  HistoryEntry: object(
    {
      id: string,
      kind: string,
      text: string,
      timestamp: string,
      origin: { type: 'object' },
      native: { type: 'object' },
    },
    ['id', 'kind', 'text', 'native'],
  ),
  HistoryPage: object(
    { data: array(ref('HistoryEntry')), nextCursor: { type: ['string', 'null'] } },
    ['data', 'nextCursor'],
  ),
  Reply: object({ text: string, metadata: { type: 'object' } }, ['text']),
  ErrorDetail: object({ code: string, message: string }, ['code', 'message']),
  Error: object({ error: ref('ErrorDetail') }, ['error']),
  Receipt: object(
    {
      messageId: { type: 'string', format: 'uuid' },
      to: ref('SessionAddress'),
      delivery: { enum: ['tool_output', 'peer_message', 'user_input'] },
      status: {
        enum: [
          'pending',
          'transport_written',
          'accepted',
          'held',
          'received',
          'replied',
          'rejected',
          'failed',
          'unknown',
        ],
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      reply: ref('Reply'),
      native: { type: 'object' },
      error: ref('ErrorDetail'),
      forwardedMessageId: { type: 'string', format: 'uuid' },
      forwardError: string,
    },
    ['messageId', 'to', 'delivery', 'status', 'createdAt', 'updatedAt'],
  ),
  MessageInput: object(
    {
      messageId: { type: 'string', format: 'uuid' },
      to: ref('SessionAddress'),
      origin: ref('Origin'),
      delivery: { enum: ['tool_output', 'peer_message'] },
      text: { type: 'string', minLength: 1, maxLength: 100000 },
      replyTo: ref('SessionAddress'),
      inReplyTo: { type: 'string', maxLength: 128 },
      correlationId: { type: 'string', maxLength: 128 },
      expiresAt: { type: 'string', format: 'date-time' },
      hopCount: { type: 'integer', minimum: 0, maximum: 8 },
    },
    ['messageId', 'to', 'origin', 'delivery', 'text'],
  ),
  Instances: object(
    {
      data: array(object({ harness: string, instance: string }, ['harness', 'instance'])),
      eventCursor: string,
    },
    ['data', 'eventCursor'],
  ),
  Interaction: object(
    { id: string, address: ref('SessionAddress'), method: string, params: { type: 'object' } },
    ['id', 'address', 'method', 'params'],
  ),
  InteractionPage: object({ data: array(ref('Interaction')) }, ['data']),
  Event: object(
    {
      id: string,
      type: string,
      sessionId: { type: ['string', 'null'] },
      turnId: { type: ['string', 'null'] },
      timestamp: string,
      data: { type: 'object' },
    },
    ['id', 'type', 'sessionId', 'turnId', 'timestamp', 'data'],
  ),
};
export const openApi = {
  openapi: '3.1.0',
  info: {
    title: 'HarnessHub',
    version: '0.1.0',
    description:
      'Local session communication. Explicit native semantics; no implicit resume, user-input fallback, or automatic write retry.',
  },
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas },
  paths: {
    '/v1/instances': {
      get: { operationId: 'listInstances', responses: responses(ref('Instances')) },
    },
    '/v1/sessions': {
      post: {
        operationId: 'createManagedSession',
        requestBody: body(
          object({ harness: string, instance: string, cwd: string }, [
            'harness',
            'instance',
            'cwd',
          ]),
        ),
        responses: responses(ref('Session'), 201),
      },
      get: {
        operationId: 'listSessions',
        parameters: [...scope, ...pagination],
        responses: responses(ref('SessionPage')),
      },
    },
    '/v1/session': {
      get: { operationId: 'getSession', parameters: session, responses: responses(ref('Session')) },
    },
    '/v1/session/attach-reply': {
      post: {
        operationId: 'attachReplyRoute',
        description:
          'Explicit owner operation. Requires loaded root and verified reply tool, then calls thread/resume without overrides. A concurrent unload may cause a cold resume. Not exposed through MCP; never implicit in send or startup.',
        requestBody: body(
          object({ address: ref('SessionAddress'), acceptResumeRace: { const: true } }, [
            'address',
            'acceptResumeRace',
          ]),
        ),
        responses: responses(ref('Session')),
      },
    },
    '/v1/search': {
      get: {
        operationId: 'searchHistory',
        description:
          'Literal case-insensitive search of normalized history for one authorized session. At most 10 native pages per request; an empty page may have a continuation. Cursor binds caller, address and query.',
        parameters: [
          ...session,
          ...pagination.filter((p) => p.name !== 'search'),
          param('search', string, true),
        ],
        responses: responses(ref('HistoryPage')),
      },
    },
    '/v1/history': {
      get: {
        operationId: 'getHistory',
        parameters: [...session, ...pagination],
        responses: responses(ref('HistoryPage')),
      },
    },
    '/v1/prompts': {
      post: {
        operationId: 'promptManagedSession',
        description:
          'Explicit managed user input with separate prompt permission; no peer conversion or reply forwarding. Not exposed through MCP.',
        requestBody: body(
          object(
            {
              ...schemas.MessageInput.properties,
              delivery: { const: 'user_input' },
              replyTo: false,
            },
            ['messageId', 'to', 'origin', 'delivery', 'text'],
          ),
        ),
        responses: responses(ref('Receipt'), 202),
      },
    },
    '/v1/session/cancel': {
      post: {
        operationId: 'cancelManagedPrompt',
        requestBody: body(object({ address: ref('SessionAddress') }, ['address'])),
        responses: responses(object({ cancelled: { const: true } }, ['cancelled'])),
      },
    },
    '/v1/messages': {
      post: {
        operationId: 'sendMessage',
        description:
          'Persist the idempotency reservation before delivery when a store is configured (CLI default). Interrupted submissions become unknown after restart, without replay. HTTP 202 does not mean the model received or processed the message.',
        requestBody: body(ref('MessageInput')),
        responses: responses(ref('Receipt'), 202),
      },
    },
    '/v1/messages/{messageId}': {
      get: {
        operationId: 'getMessageStatus',
        parameters: [
          param('messageId', string, true, 'path'),
          param('waitMs', { type: 'integer', minimum: 0, maximum: 60000, default: 0 }),
        ],
        responses: responses(ref('Receipt')),
      },
    },
    '/v1/events': {
      get: {
        operationId: 'events',
        description:
          'Bounded replay persisted with SQLite when configured; ephemeral without a store. Invalid/expired cursors fail explicitly. Optional session filtering uses all three address fields. ready and gap are control frames; message.status and adapter.event carry Event objects. No automatic reconnect.',
        parameters: [
          param('after'),
          param('Last-Event-ID', string, false, 'header'),
          param('harness'),
          param('instance'),
          param('sessionId'),
        ],
        responses: {
          ...errors,
          '200': {
            description: 'SSE stream',
            content: { 'text/event-stream': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/v1/interactions': {
      get: {
        operationId: 'pendingRequests',
        parameters: scope,
        responses: responses(ref('InteractionPage')),
      },
    },
    '/v1/interactions/{requestId}': {
      post: {
        operationId: 'respondToRequest',
        description:
          'Explicit owner response using native Codex request schema. Not exposed by agent-facing MCP tools. No automatic approval.',
        parameters: [...scope, param('requestId', string, true, 'path')],
        requestBody: body(object({ result: {} }, ['result'])),
        responses: responses(object({ responded: { const: true } }, ['responded'])),
      },
    },
  },
};

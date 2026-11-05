import type { Json } from './types.js';
import { VERSION } from './version.js';
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
const strictObject = (properties: Json, required = Object.keys(properties)) => ({
  ...object(properties, required),
  additionalProperties: false,
});
const connectorEvidence = {
  oneOf: [
    strictObject(
      {
        pid: { type: 'integer', minimum: 1, maximum: 2147483647 },
        startupSessionId: { type: 'string', format: 'uuid' },
        transport: { const: 'cli' },
      },
      ['pid', 'startupSessionId'],
    ),
    strictObject(
      {
        harness: { const: 'codex' },
        pid: { type: 'integer', minimum: 1, maximum: 2147483647 },
        threadId: { type: 'string', format: 'uuid' },
        sessionId: { type: 'string', format: 'uuid' },
        connectionId: { type: 'string', format: 'uuid' },
      },
      ['harness', 'pid', 'threadId', 'connectionId'],
    ),
  ],
};
const connectorOperation = {
  oneOf: [
    strictObject({ operation: { const: 'identity' } }),
    strictObject({
      operation: { const: 'activate' },
      activationId: { type: 'string', format: 'uuid' },
    }),
    strictObject({ operation: { const: 'list_peers' } }),
    strictObject({
      operation: { const: 'ask' },
      messageId: { type: 'string', format: 'uuid' },
      to: {
        oneOf: [{ ...ref('SessionAddress') }, { type: 'string', minLength: 1, maxLength: 1024 }],
      },
      message: { type: 'string', minLength: 1, maxLength: 100000 },
      expiresAt: { type: 'string', format: 'date-time' },
    }),
    strictObject({
      operation: { const: 'reply' },
      request: { type: 'string', format: 'uuid' },
      message: { type: 'string', minLength: 1, maxLength: 100000 },
    }),
  ],
};
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
  MessageInput: {
    ...object(
      {
        messageId: { type: 'string', format: 'uuid' },
        messageKind: {
          enum: ['request', 'result'],
          description:
            'Omitted retains request behavior. Results cannot set replyTo and do not request a business reply.',
        },
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
    allOf: [
      {
        if: { properties: { messageKind: { const: 'result' } }, required: ['messageKind'] },
        then: { not: { required: ['replyTo'] } },
      },
    ],
  },
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
    title: 'AgentHub',
    version: VERSION,
    description:
      'Local session communication. Explicit native semantics; no implicit resume, user-input fallback, or automatic write retry.',
  },
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas },
  paths: {
    '/v1/connect': {
      post: {
        operationId: 'connectSession',
        description:
          'Owner only. Codex installs a matching MCP entry with a versioned config write, reloads the instance and verifies identity through one read-only native MCP call without a model turn. Claude profiles explicitly opting into transport:cli send one native peer handshake, which can start a model turn under existing Bash permissions; readiness requires the correlated CLI call and independently verified native ancestry. No host permissions are changed and no session is resumed. Repeated checks do not resend the same activation. Exit code 2 means incomplete, not success.',
        requestBody: body(
          strictObject(
            {
              address: ref('SessionAddress'),
              clientProfilePath: { type: 'string' },
              waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 0 },
              retryActivation: {
                type: 'boolean',
                default: false,
                description:
                  'Claude CLI only. Explicitly send a new handshake after the previous ten-minute window expired; pending handshakes cannot be retried early.',
              },
            },
            ['address'],
          ),
        ),
        responses: responses({ type: 'object' }),
      },
    },
    '/v1/connector/enroll': {
      post: {
        operationId: 'enrollConnector',
        description:
          'Enrollment credential only. Validates process start identity and same OS user. Claude MCP uses direct parent/native UUID evidence; owner-enabled Claude CLI transport independently checks up to eight ancestor processes and their start identities against native discovery. Codex cross-checks per-call threadId and connectionId against the loaded root and native MCP inventory. If sessionId is present it must match threadId. Returns a restricted process credential (CLI: 60 seconds), never owner API access.',
        requestBody: body(connectorEvidence),
        responses: responses(
          object(
            {
              token: string,
              binding: { type: 'object' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
            ['token', 'binding', 'expiresAt'],
          ),
        ),
      },
    },
    '/v1/connector/hook': {
      post: {
        operationId: 'connectorLifecycle',
        description:
          'Enrollment credential only. A direct Claude lifecycle hook verifies the fresh UUID against native discovery.',
        requestBody: body(
          strictObject({
            pid: { type: 'integer', minimum: 1 },
            event: { enum: ['SessionStart', 'SessionEnd'] },
            sessionId: { type: 'string', format: 'uuid' },
          }),
        ),
        responses: responses(
          object({ accepted: { type: 'boolean' }, stale: { type: 'boolean' } }, [
            'accepted',
            'stale',
          ]),
        ),
      },
    },
    '/v1/connector/call': {
      post: {
        operationId: 'connectorCall',
        description:
          'Process credential only. Source and reply route are derived from current native identity and existing grants. list_peers returns peers plus per-instance gaps; Codex discovery uses loaded roots instead of historical threads. Aliases only query their harness and require complete discovery. activate verifies local identity independently of peer discovery. ask expiresAt must be within four hours; late replies fail with request_expired. credential_expired is a pre-dispatch 401 and permits one reenrollment and retry of the exact operation; expired credential records retain this classification for 60 seconds without extending validity. Other failures never automatically replay writes. Result messages cannot be replied to.',
        requestBody: body(
          strictObject({ evidence: connectorEvidence, operation: connectorOperation }),
        ),
        responses: responses({ type: 'object' }),
      },
    },
    '/v1/disconnect': {
      post: {
        operationId: 'disconnectConnector',
        description:
          'Owner only. Disconnects one session or one connector profile for later operations without a Hub restart, and removes its bindings, credentials and lifecycle records. Native MCP and hook configuration is not changed, and requests already accepted by a target are not cancelled. Owner reconnect or connect reverses it.',
        requestBody: body({
          oneOf: [
            strictObject({ address: ref('SessionAddress') }, ['address']),
            strictObject({ profileId: { type: 'string' } }, ['profileId']),
          ],
        }),
        responses: responses({ type: 'object' }),
      },
    },
    '/v1/reconnect': {
      post: {
        operationId: 'reconnectConnector',
        description:
          'Owner only. Reverses disconnect for one session or one connector profile without a handshake. The session enrolls again on its next tool call, and a disabled profile accepts new sessions again. changed is false when nothing was disconnected.',
        requestBody: body({
          oneOf: [
            strictObject({ address: ref('SessionAddress') }, ['address']),
            strictObject({ profileId: { type: 'string' } }, ['profileId']),
          ],
        }),
        responses: responses({ type: 'object' }),
      },
    },
    '/v1/connections': {
      get: {
        operationId: 'listConnections',
        description:
          'Owner only. Historical bindings, owner disconnections and enabled profiles, never credentials. A binding is not a session or connector liveness signal.',
        responses: responses({ type: 'object' }),
      },
    },
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
              messageKind: false,
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
      get: {
        operationId: 'listMessages',
        description:
          'Owner only. Retained messages with envelope and receipt, oldest change first. A message reappears whenever it changes, so upsert by messageId. gap means changes after the cursor were removed by expiry or clearing and cannot be returned. Retention is bounded, so this is not a long-term archive.',
        parameters: [
          param('cursor', string),
          param('limit', { type: 'integer', minimum: 1, maximum: 500, default: 100 }),
        ],
        responses: responses({ type: 'object' }),
      },
      delete: {
        operationId: 'clearMessages',
        description:
          'Owner only. Removes finished messages and all retained events. Requests still waiting for a reply or a forward are kept and counted in retained. Connector bindings and credentials are unaffected. Older event cursors report event_cursor_expired.',
        responses: responses({ type: 'object' }),
      },
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

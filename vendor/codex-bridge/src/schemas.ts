import type { JsonObject } from './contracts.js';

const str = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const anyObject = { type: 'object', additionalProperties: true };
const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
function record(properties: JsonObject, required: string[]): JsonObject {
  return { ...anyObject, properties, required };
}
function page(items: JsonObject): JsonObject {
  return record(
    { data: { type: 'array', items }, nextCursor: nullableString, backwardsCursor: nullableString },
    ['data', 'nextCursor'],
  );
}

/** Stable bridge fields are specified; version-dependent Codex fields remain extensible. */
export const schemas: Record<string, JsonObject> = {
  Error: record(
    { error: record({ code: str, message: str, details: anyObject }, ['code', 'message']) },
    ['error'],
  ),
  Session: record(
    {
      id: str,
      name: nullableString,
      cwd: str,
      status: record({ type: str }, ['type']),
      canAcceptDirectInput: { type: ['boolean', 'null'] },
      parentThreadId: nullableString,
    },
    ['id'],
  ),
  SessionResult: record({ thread: ref('Session') }, ['thread']),
  SessionPage: page(ref('Session')),
  LoadedPage: page(str),
  SearchPage: page(record({ thread: ref('Session'), snippet: str }, ['thread', 'snippet'])),
  Occurrence: record(
    {
      turnId: str,
      itemId: str,
      snippet: str,
      snippetMatchRange: record(
        { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 } },
        ['start', 'end'],
      ),
      turnCursor: str,
    },
    ['turnId', 'itemId', 'snippet', 'snippetMatchRange', 'turnCursor'],
  ),
  OccurrencePage: page(ref('Occurrence')),
  Turn: record(
    {
      id: str,
      status: str,
      items: { type: 'array', items: anyObject },
      error: { type: ['object', 'null'], additionalProperties: true },
    },
    ['id', 'status'],
  ),
  TurnPage: page(ref('Turn')),
  ItemEntry: record(
    {
      turnId: str,
      item: record({ id: str, type: str }, ['id', 'type']),
      startedAtMs: { type: ['integer', 'null'] },
      completedAtMs: { type: ['integer', 'null'] },
    },
    ['turnId', 'item'],
  ),
  ItemPage: page(ref('ItemEntry')),
  MessageReceipt: record(
    {
      status: { const: 'accepted' },
      sessionId: str,
      turnId: str,
      messageId: str,
      source: str,
      mode: { enum: ['start', 'steer'] },
    },
    ['status', 'sessionId', 'turnId', 'messageId', 'source', 'mode'],
  ),
  Event: record(
    {
      id: str,
      type: str,
      sessionId: nullableString,
      turnId: nullableString,
      timestamp: { type: 'string', format: 'date-time' },
      data: anyObject,
    },
    ['id', 'type', 'sessionId', 'turnId', 'timestamp', 'data'],
  ),
  PendingRequest: record({ id: str, method: str, sessionId: nullableString, params: anyObject }, [
    'id',
    'method',
    'sessionId',
    'params',
  ]),
  PendingRequests: record({ data: { type: 'array', items: ref('PendingRequest') } }, ['data']),
  ResponseReceipt: record({ status: { const: 'submitted' }, requestId: str }, [
    'status',
    'requestId',
  ]),
  Capabilities: record(
    {
      version: str,
      connected: { type: 'boolean' },
      eventCursor: str,
      nativeAgentMessaging: { const: false },
      idempotency: record({ retentionHours: { const: 24 }, durable: { const: false } }, [
        'retentionHours',
        'durable',
      ]),
      operations: { type: 'array', items: str },
    },
    ['version', 'connected', 'eventCursor', 'nativeAgentMessaging', 'idempotency', 'operations'],
  ),
};

const responses: Record<string, string> = {
  capabilities: 'Capabilities',
  listSessions: 'SessionPage',
  loadedSessions: 'LoadedPage',
  searchSessions: 'SearchPage',
  sessionDetail: 'SessionResult',
  createSession: 'SessionResult',
  attachSession: 'SessionResult',
  resumeSession: 'SessionResult',
  forkSession: 'SessionResult',
  listTurns: 'TurnPage',
  listItems: 'ItemPage',
  searchOccurrences: 'OccurrencePage',
  sendMessage: 'MessageReceipt',
  pendingRequests: 'PendingRequests',
  respondToRequest: 'ResponseReceipt',
};
export function responseSchema(operation: string): JsonObject {
  if (operation === 'events')
    return {
      type: 'string',
      description:
        'SSE frames carrying Event envelopes; ready frames contain cursor and connected.',
    };
  const name = responses[operation];
  return name ? ref(name) : anyObject;
}
export function bodyConstraints(operation: string): JsonObject {
  if (operation === 'sendMessage')
    return {
      allOf: [
        {
          if: { properties: { mode: { const: 'steer' } }, required: ['mode'] },
          then: { required: ['expectedTurnId'] },
          else: { not: { required: ['expectedTurnId'] } },
        },
      ],
    };
  if (operation === 'respondToRequest')
    return {
      oneOf: [
        { required: ['result'], not: { required: ['error'] } },
        { required: ['error'], not: { required: ['result'] } },
      ],
    };
  return {};
}

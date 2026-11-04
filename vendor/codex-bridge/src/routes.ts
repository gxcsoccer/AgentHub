import type { JsonObject } from './contracts.js';
import { BridgeError, object } from './errors.js';
import { schemas, responseSchema, bodyConstraints } from './schemas.js';

export interface Field {
  type: 'string' | 'integer' | 'boolean' | 'object';
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  description?: string;
}
export interface Shape {
  properties: Record<string, Field>;
  required?: string[];
}
export interface Route {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  operationId: string;
  summary: string;
  query?: Shape;
  body?: Shape;
  status?: number;
  idempotent?: boolean;
}
const string: Field = { type: 'string', minLength: 1, maxLength: 4096 };
const searchQuery: Field = { ...string, maxLength: 2000 };
const page = { cursor: string, limit: { type: 'integer', minimum: 1, maximum: 100 } as Field };
const sortDirection: Field = { type: 'string', enum: ['asc', 'desc'] };
const sortKey: Field = { type: 'string', enum: ['created_at', 'updated_at', 'recency_at'] };
const source: Field = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' };
const message = { text: { type: 'string', minLength: 1, maxLength: 100_000 } as Field, source };

/** These definitions drive both runtime validation and the published OpenAPI contract. */
export const routes: Route[] = [
  {
    method: 'GET',
    path: '/v1/capabilities',
    operationId: 'capabilities',
    summary: 'Bridge and backend connection capabilities',
  },
  {
    method: 'GET',
    path: '/v1/sessions',
    operationId: 'listSessions',
    summary: 'List stored sessions without restoring them',
    query: {
      properties: {
        ...page,
        sortKey,
        sortDirection,
        cwd: string,
        searchTerm: string,
        archived: { type: 'boolean' },
        currentAccountOnly: { type: 'boolean' },
      },
    },
  },
  {
    method: 'GET',
    path: '/v1/sessions/loaded',
    operationId: 'loadedSessions',
    summary: 'List thread IDs loaded in the connected Codex instance',
    query: { properties: page },
  },
  {
    method: 'GET',
    path: '/v1/sessions/search',
    operationId: 'searchSessions',
    summary: 'Search indexed session content; availability depends on the Codex backend',
    query: {
      properties: {
        ...page,
        q: searchQuery,
        sortKey,
        sortDirection,
        archived: { type: 'boolean' },
        currentAccountOnly: { type: 'boolean' },
      },
      required: ['q'],
    },
  },
  {
    method: 'POST',
    path: '/v1/sessions',
    operationId: 'createSession',
    summary: 'Explicitly create a session using existing Codex configuration',
    body: { properties: { cwd: string, model: string } },
    status: 201,
  },
  {
    method: 'GET',
    path: '/v1/sessions/{sessionId}',
    operationId: 'sessionDetail',
    summary: 'Read session metadata; does not restore the session',
  },
  {
    method: 'GET',
    path: '/v1/sessions/{sessionId}/turns',
    operationId: 'listTurns',
    summary: 'Read paginated turns',
    query: {
      properties: {
        ...page,
        sortDirection,
        itemsView: { type: 'string', enum: ['notLoaded', 'summary', 'full'] },
      },
    },
  },
  {
    method: 'GET',
    path: '/v1/sessions/{sessionId}/items',
    operationId: 'listItems',
    summary: 'Read paginated messages and tool items',
    query: { properties: { ...page, sortDirection, turnId: string } },
  },
  {
    method: 'GET',
    path: '/v1/sessions/{sessionId}/search',
    operationId: 'searchOccurrences',
    summary: 'Search visible user and assistant messages within a paginated session',
    query: { properties: { ...page, q: searchQuery }, required: ['q'] },
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/attach',
    operationId: 'attachSession',
    summary:
      'Subscribe using thread/resume after checking loaded state; concurrent unload may cause restoration',
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/resume',
    operationId: 'resumeSession',
    summary: 'Explicitly restore or attach a session in this backend',
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/detach',
    operationId: 'detachSession',
    summary: 'Unsubscribe this bridge connection; does not interrupt work',
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/fork',
    operationId: 'forkSession',
    summary: 'Explicitly fork a session',
    body: { properties: { lastTurnId: string } },
    status: 201,
  },
  {
    method: 'PATCH',
    path: '/v1/sessions/{sessionId}',
    operationId: 'renameSession',
    summary: 'Rename a session',
    body: { properties: { name: { ...string, maxLength: 200 } }, required: ['name'] },
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/archive',
    operationId: 'archiveSession',
    summary: 'Archive a session; upstream may unload it',
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/unarchive',
    operationId: 'unarchiveSession',
    summary: 'Restore an archived session to the session list',
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/messages',
    operationId: 'sendMessage',
    summary: 'Submit externally attributed user input; acceptance is not completion',
    body: {
      properties: {
        ...message,
        mode: { type: 'string', enum: ['start', 'steer'] },
        expectedTurnId: { ...string, maxLength: 128 },
      },
      required: ['text', 'source'],
    },
    status: 202,
    idempotent: true,
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/context',
    operationId: 'injectContext',
    summary: 'Inject attributed user-role context without starting a turn',
    body: { properties: message, required: ['text', 'source'] },
  },
  {
    method: 'POST',
    path: '/v1/sessions/{sessionId}/interrupt',
    operationId: 'interruptTurn',
    summary: 'Interrupt the specified turn',
    body: { properties: { turnId: string }, required: ['turnId'] },
    status: 202,
  },
  {
    method: 'GET',
    path: '/v1/events',
    operationId: 'events',
    summary: 'SSE for this connection; attach explicitly to receive existing session events',
    query: { properties: { sessionId: string, after: string } },
  },
  {
    method: 'GET',
    path: '/v1/requests',
    operationId: 'pendingRequests',
    summary: 'List unresolved approvals, questions and other server requests',
    query: { properties: { sessionId: string } },
  },
  {
    method: 'POST',
    path: '/v1/requests/{requestId}/response',
    operationId: 'respondToRequest',
    summary: 'Explicitly forward a Codex result or error; never approves automatically',
    body: { properties: { result: { type: 'object' }, error: { type: 'object' } } },
    status: 202,
  },
];

export function validate(value: unknown, shape: Shape = { properties: {} }): JsonObject {
  const input = object(value);
  for (const required of shape.required ?? []) {
    if (!Object.hasOwn(input, required))
      throw new BridgeError(400, 'invalid_input', `${required} is required`);
  }
  for (const [key, val] of Object.entries(input)) {
    const field = Object.hasOwn(shape.properties, key) ? shape.properties[key] : undefined;
    if (!field) throw new BridgeError(400, 'invalid_input', `Unknown field: ${key}`);
    let valid =
      field.type === 'integer'
        ? typeof val === 'number' && Number.isSafeInteger(val)
        : field.type === 'object'
          ? !!val && typeof val === 'object' && !Array.isArray(val)
          : typeof val === field.type;
    if (typeof val === 'string') {
      valid &&=
        (!field.minLength || val.trim().length >= field.minLength) &&
        (!field.maxLength || val.length <= field.maxLength) &&
        (!field.enum || field.enum.includes(val)) &&
        (!field.pattern || new RegExp(field.pattern).test(val));
    }
    if (typeof val === 'number')
      valid &&= val >= (field.minimum ?? -Infinity) && val <= (field.maximum ?? Infinity);
    if (!valid) throw new BridgeError(400, 'invalid_input', `Invalid ${key}`);
  }
  return input;
}

export function queryInput(search: URLSearchParams, shape?: Shape): JsonObject {
  const input: JsonObject = Object.create(null) as JsonObject;
  for (const [key, value] of search) {
    if (Object.hasOwn(input, key))
      throw new BridgeError(400, 'invalid_input', `Repeated query field: ${key}`);
    const field = shape && Object.hasOwn(shape.properties, key) ? shape.properties[key] : undefined;
    input[key] =
      field?.type === 'integer' && /^\d+$/.test(value)
        ? Number(value)
        : field?.type === 'boolean' && ['true', 'false'].includes(value)
          ? value === 'true'
          : value;
  }
  return validate(input, shape);
}

export function openApi(): JsonObject {
  const paths: Record<string, JsonObject> = {};
  for (const route of routes) {
    const parameters: JsonObject[] = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    for (const [name, schema] of Object.entries(route.query?.properties ?? {}))
      parameters.push({
        name,
        in: 'query',
        required: route.query?.required?.includes(name) ?? false,
        schema,
      });
    if (route.idempotent)
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1, maxLength: 128 },
        description:
          'Deduplicated for 24 hours in this bridge process. Receipts do not survive restart.',
      });
    if (route.operationId === 'events')
      parameters.push({ name: 'Last-Event-ID', in: 'header', schema: { type: 'string' } });
    const operation: JsonObject = {
      operationId: route.operationId,
      summary: route.summary,
      parameters,
      responses: {
        [String(route.status ?? 200)]: {
          description: 'Success; Codex response fields are preserved',
          content: {
            [route.operationId === 'events' ? 'text/event-stream' : 'application/json']: {
              schema: responseSchema(route.operationId),
            },
          },
        },
        default: {
          description: 'Structured bridge or Codex error',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };
    if (route.body)
      operation.requestBody = {
        required: Boolean(route.body.required?.length) || route.operationId === 'respondToRequest',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              ...route.body,
              ...bodyConstraints(route.operationId),
            },
          },
        },
      };
    (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Codex Session Bridge',
      version: '0.1.0',
      license: { name: 'MIT', identifier: 'MIT' },
      description:
        'Local API for one existing Codex App Server. sessionId in URLs denotes the Codex thread ID, not the agent-tree sessionId.',
    },
    servers: [{ url: 'http://127.0.0.1:3210' }],
    security: [{ bearerAuth: [] }],
    paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas },
  };
}

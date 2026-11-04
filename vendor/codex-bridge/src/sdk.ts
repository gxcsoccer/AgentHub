import type { JsonObject, MessageInput } from './contracts.js';
export type { MessageInput } from './contracts.js';
export interface ClientOptions {
  baseUrl?: string;
  token: string;
  fetch?: typeof fetch;
}
export interface StreamEvent {
  type: string;
  id?: string;
  sessionId?: string | null;
  turnId?: string | null;
  timestamp?: string;
  data: JsonObject;
}
export interface PageOptions {
  cursor?: string;
  limit?: number;
}
export interface ListOptions extends PageOptions {
  archived?: boolean;
  cwd?: string;
  searchTerm?: string;
  currentAccountOnly?: boolean;
  sortKey?: 'created_at' | 'updated_at' | 'recency_at';
  sortDirection?: 'asc' | 'desc';
}
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
}
export interface Session {
  id: string;
  name?: string | null;
  cwd?: string;
  status?: { type: string };
  [key: string]: unknown;
}
export interface Turn {
  id: string;
  status: string;
  items?: JsonObject[];
  error?: JsonObject | null;
  [key: string]: unknown;
}
export interface ItemEntry {
  turnId: string;
  item: JsonObject & { id: string; type: string };
  startedAtMs?: number | null;
  completedAtMs?: number | null;
}
export interface SearchOccurrence {
  turnId: string;
  itemId: string;
  snippet: string;
  snippetMatchRange: { start: number; end: number };
  turnCursor: string;
}
export interface Receipt {
  status: 'accepted';
  sessionId: string;
  turnId: string;
  messageId: string;
  source: string;
  mode: 'start' | 'steer';
}
export class BridgeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BridgeApiError';
  }
}

/** Fetch-only SDK: works in Node 22+ and browsers with an explicitly allowed origin. */
export class CodexBridgeClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: ClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3210').replace(/\/$/, '');
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  capabilities(): Promise<JsonObject> {
    return this.call('GET', '/v1/capabilities');
  }
  listSessions(params: ListOptions = {}): Promise<Page<Session>> {
    return this.call('GET', '/v1/sessions', { ...params });
  }
  loadedSessions(params: PageOptions = {}): Promise<Page<string>> {
    return this.call('GET', '/v1/sessions/loaded', { ...params });
  }
  detail(id: string): Promise<{ thread: Session }> {
    return this.call('GET', this.path(id));
  }
  search(
    query: string,
    params: Omit<ListOptions, 'cwd' | 'searchTerm'> = {},
  ): Promise<Page<{ thread: Session; snippet: string }>> {
    return this.call('GET', '/v1/sessions/search', { ...params, q: query });
  }
  searchOccurrences(
    id: string,
    query: string,
    params: PageOptions = {},
  ): Promise<Page<SearchOccurrence>> {
    return this.call('GET', this.path(id, '/search'), { ...params, q: query });
  }
  turns(
    id: string,
    params: PageOptions & {
      itemsView?: 'notLoaded' | 'summary' | 'full';
      sortDirection?: 'asc' | 'desc';
    } = {},
  ): Promise<Page<Turn>> {
    return this.call('GET', this.path(id, '/turns'), { ...params });
  }
  items(
    id: string,
    params: PageOptions & { turnId?: string; sortDirection?: 'asc' | 'desc' } = {},
  ): Promise<Page<ItemEntry>> {
    return this.call('GET', this.path(id, '/items'), { ...params });
  }
  create(params: { cwd?: string; model?: string } = {}): Promise<{ thread: Session }> {
    return this.call('POST', '/v1/sessions', undefined, params);
  }
  attach(id: string): Promise<{ thread: Session }> {
    return this.call('POST', this.path(id, '/attach'));
  }
  resume(id: string): Promise<{ thread: Session }> {
    return this.call('POST', this.path(id, '/resume'));
  }
  detach(id: string): Promise<JsonObject> {
    return this.call('POST', this.path(id, '/detach'));
  }
  fork(id: string, params: { lastTurnId?: string } = {}): Promise<{ thread: Session }> {
    return this.call('POST', this.path(id, '/fork'), undefined, params);
  }
  rename(id: string, name: string): Promise<JsonObject> {
    return this.call('PATCH', this.path(id), undefined, { name });
  }
  archive(id: string): Promise<JsonObject> {
    return this.call('POST', this.path(id, '/archive'));
  }
  unarchive(id: string): Promise<JsonObject> {
    return this.call('POST', this.path(id, '/unarchive'));
  }
  sendMessage(
    id: string,
    input: MessageInput,
    options: { idempotencyKey: string },
  ): Promise<Receipt> {
    return this.call('POST', this.path(id, '/messages'), undefined, input, {
      'Idempotency-Key': options.idempotencyKey,
    });
  }
  injectContext(id: string, input: Pick<MessageInput, 'text' | 'source'>): Promise<JsonObject> {
    return this.call('POST', this.path(id, '/context'), undefined, input);
  }
  interrupt(id: string, turnId: string): Promise<JsonObject> {
    return this.call('POST', this.path(id, '/interrupt'), undefined, { turnId });
  }
  pendingRequests(sessionId?: string): Promise<{ data: JsonObject[] }> {
    return this.call('GET', '/v1/requests', { sessionId });
  }
  respond(
    requestId: string,
    response: { result: JsonObject } | { error: { code: number; message: string } },
  ): Promise<JsonObject> {
    return this.call(
      'POST',
      `/v1/requests/${encodeURIComponent(requestId)}/response`,
      undefined,
      response,
    );
  }

  private path(id: string, suffix = ''): string {
    return `/v1/sessions/${encodeURIComponent(id)}${suffix}`;
  }
  private url(path: string, query: Record<string, unknown> = {}): URL {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }
  private async checked(response: Response): Promise<Response> {
    if (response.ok) return response;
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    throw new BridgeApiError(
      response.status,
      body.error?.code ?? 'http_error',
      body.error?.message ?? `HTTP ${response.status}`,
      body.error?.details,
    );
  }
  private async call<T>(
    method: string,
    path: string,
    query?: Record<string, unknown>,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.checked(
      await this.fetcher(this.url(path, query), {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return response.json() as Promise<T>;
  }
  async *events(
    options: { sessionId?: string; after?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<StreamEvent> {
    const response = await this.checked(
      await this.fetcher(
        this.url('/v1/events', { sessionId: options.sessionId, after: options.after }),
        {
          headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'text/event-stream' },
          signal: options.signal,
        },
      ),
    );
    if (!response.body) throw new Error('SSE response has no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    let id: string | undefined;
    let data: string[] = [];
    let frameLength = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 16 * 1024 * 1024) throw new Error('SSE frame exceeds client limit');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          frameLength += line.length + 1;
          if (frameLength > 16 * 1024 * 1024) throw new Error('SSE frame exceeds client limit');
          if (!line) {
            if (data.length) {
              const parsed = JSON.parse(data.join('\n')) as JsonObject;
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                throw new Error('Invalid SSE data');
              yield typeof parsed.type === 'string' &&
              parsed.type === event &&
              parsed.data &&
              typeof parsed.data === 'object'
                ? (parsed as unknown as StreamEvent)
                : { type: event, ...(id ? { id } : {}), data: parsed };
            }
            data = [];
            event = 'message';
            frameLength = 0;
          } else if (!line.startsWith(':')) {
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            else if (field === 'id' && !value.includes('\0')) id = value;
            else if (field === 'data') data.push(value);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

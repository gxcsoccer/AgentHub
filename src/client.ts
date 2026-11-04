import type {
  HistoryEntry,
  Json,
  MessageInput,
  Page,
  PageQuery,
  Receipt,
  SessionAddress,
  SessionInfo,
} from './types.js';
import { diagnose, type DoctorOptions } from './doctor.js';
export type { DoctorOptions, DoctorReport, DiagnosticCheck } from './doctor.js';
export class HubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HubApiError';
  }
}
export class HarnessHubClient {
  private readonly base: URL;
  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    },
  ) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000)
    )
      throw new Error('timeoutMs must be an integer between 1 and 120000');
    this.base = new URL(options.baseUrl);
    if (
      this.base.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname) ||
      this.base.username ||
      this.base.password
    )
      throw new Error('HarnessHub client requires a local HTTP URL');
  }
  private url(path: string, query: object = {}): URL {
    const url = new URL(path, this.base);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return url;
  }
  private async request<T>(
    method: string,
    path: string,
    query: object = {},
    body?: unknown,
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(this.url(path, query), {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 70000),
    });
    const value = (await response.json()) as { error?: { code: string; message: string } };
    if (!response.ok)
      throw new HubApiError(
        response.status,
        value.error?.code ?? 'http_error',
        value.error?.message ?? response.statusText,
      );
    return value as T;
  }
  instances() {
    return this.request<{ data: { harness: string; instance: string }[]; eventCursor: string }>(
      'GET',
      '/v1/instances',
    );
  }
  doctor(options: DoctorOptions = {}) {
    return diagnose(this, options);
  }
  listSessions(scope: Pick<SessionAddress, 'harness' | 'instance'>, query: PageQuery = {}) {
    return this.request<Page<SessionInfo>>('GET', '/v1/sessions', {
      harness: scope.harness,
      instance: scope.instance,
      ...query,
    });
  }
  createSession(scope: Pick<SessionAddress, 'harness' | 'instance'>, cwd: string) {
    return this.request<SessionInfo>(
      'POST',
      '/v1/sessions',
      {},
      { harness: scope.harness, instance: scope.instance, cwd },
    );
  }
  prompt(message: MessageInput & { delivery: 'user_input' }) {
    return this.request<Receipt>('POST', '/v1/prompts', {}, message);
  }
  cancel(address: SessionAddress) {
    return this.request<{ cancelled: boolean }>('POST', '/v1/session/cancel', {}, { address });
  }
  getSession(address: SessionAddress) {
    return this.request<SessionInfo>('GET', '/v1/session', address);
  }
  attachReplyRoute(address: SessionAddress, options: { acceptResumeRace: boolean }) {
    return this.request<SessionInfo>(
      'POST',
      '/v1/session/attach-reply',
      {},
      { address, ...options },
    );
  }
  history(address: SessionAddress, query: PageQuery = {}) {
    return this.request<Page<HistoryEntry>>('GET', '/v1/history', { ...address, ...query });
  }
  search(address: SessionAddress, query: PageQuery & { search: string }) {
    return this.request<Page<HistoryEntry> & { scanned: number; semantics: string }>(
      'GET',
      '/v1/search',
      { ...address, ...query },
    );
  }
  send(message: MessageInput) {
    return this.request<Receipt>('POST', '/v1/messages', {}, message);
  }
  receipt(messageId: string, waitMs = 0) {
    return this.request<Receipt>('GET', `/v1/messages/${encodeURIComponent(messageId)}`, {
      waitMs,
    });
  }
  pendingRequests(scope: Pick<SessionAddress, 'harness' | 'instance'>) {
    return this.request<{ data: Json[] }>('GET', '/v1/interactions', scope);
  }
  respondToRequest(
    scope: Pick<SessionAddress, 'harness' | 'instance'>,
    id: string,
    result: unknown,
  ) {
    return this.request<{ responded: boolean }>(
      'POST',
      `/v1/interactions/${encodeURIComponent(id)}`,
      scope,
      { result },
    );
  }
  async *events(
    options: { after?: string; address?: SessionAddress; signal?: AbortSignal } = {},
  ): AsyncGenerator<{ event: string; id?: string; data: unknown }> {
    const response = await (this.options.fetch ?? fetch)(
      this.url('/v1/events', { after: options.after, ...options.address }),
      {
        headers: { Authorization: `Bearer ${this.options.token}` },
        redirect: 'error',
        signal: options.signal,
      },
    );
    if (!response.ok) {
      const body = (await response.json()) as { error: { code: string; message: string } };
      throw new HubApiError(response.status, body.error.code, body.error.message);
    }
    if (!response.body) throw new HubApiError(502, 'empty_stream', 'Missing event stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let frameBytes = 0;
    let event = 'message';
    let id: string | undefined;
    let data: string[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          frameBytes += encoder.encode(line).length + 1;
          if (frameBytes > 2 * 1024 * 1024) throw new Error('Event frame exceeds limit');
          if (line === '') {
            if (data.length)
              yield { event, ...(id ? { id } : {}), data: JSON.parse(data.join('\n')) };
            frameBytes = 0;
            event = 'message';
            id = undefined;
            data = [];
          } else {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const field = line.slice(0, colon);
            const value = line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') event = value;
            if (field === 'id') id = value;
            if (field === 'data') data.push(value);
          }
        }
        if (frameBytes + encoder.encode(buffer).length > 2 * 1024 * 1024)
          throw new Error('Event frame exceeds limit');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

import type { JsonObject, MessageInput } from './contracts.js';
import type { Rpc } from './rpc.js';
import { createHash } from 'node:crypto';
import { BridgeError, object, sessionId, text } from './errors.js';

interface Receipt {
  fingerprint: string;
  promise: Promise<unknown>;
  expiresAt: number;
}

/** Application boundary. Reads never resume threads; submissions never retry automatically. */
export class Bridge {
  private readonly receipts = new Map<string, Receipt>();
  constructor(private readonly rpc: Rpc) {}

  async list(params: JsonObject = {}): Promise<unknown> {
    return this.rpc.request('thread/list', params);
  }
  async loaded(params: JsonObject = {}): Promise<unknown> {
    return this.rpc.request('thread/loaded/list', params);
  }
  async detail(id: string): Promise<unknown> {
    return this.rpc.request('thread/read', { threadId: sessionId(id), includeTurns: false });
  }
  async search(params: JsonObject): Promise<unknown> {
    text(params.searchTerm, 'searchTerm', 2000);
    return this.rpc.request('thread/search', params);
  }
  async occurrences(id: string, params: JsonObject): Promise<unknown> {
    text(params.searchTerm, 'searchTerm', 2000);
    return this.rpc.request('thread/searchOccurrences', { ...params, threadId: sessionId(id) });
  }
  async turns(id: string, params: JsonObject = {}): Promise<unknown> {
    return this.rpc.request('thread/turns/list', { ...params, threadId: sessionId(id) });
  }
  async items(id: string, params: JsonObject = {}): Promise<unknown> {
    return this.rpc.request('thread/items/list', { ...params, threadId: sessionId(id) });
  }

  async send(id: string, input: MessageInput, key: string): Promise<unknown> {
    sessionId(id);
    const content = this.attributedText(input);
    const mode = input.mode ?? 'start';
    if (mode !== 'start' && mode !== 'steer')
      throw new BridgeError(400, 'invalid_input', 'mode must be start or steer');
    if (mode === 'steer') text(input.expectedTurnId, 'expectedTurnId', 128);
    if (mode === 'start' && input.expectedTurnId !== undefined)
      throw new BridgeError(400, 'invalid_input', 'expectedTurnId requires steer mode');
    text(key, 'Idempotency-Key', 128);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([id, content, mode, input.expectedTurnId ?? null]))
      .digest('hex');
    const now = Date.now();
    for (const [storedKey, entry] of this.receipts) {
      if (entry.expiresAt < now) this.receipts.delete(storedKey);
    }
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new BridgeError(
          409,
          'idempotency_conflict',
          'Idempotency-Key already used with a different payload',
        );
      return existing.promise;
    }
    if (this.receipts.size >= 10_000)
      throw new BridgeError(429, 'receipt_capacity', 'Receipt capacity reached; wait for expiry');
    // Reserve before any await, so concurrent callers share one attempt, including failures.
    const receipt: Receipt = { fingerprint, promise: Promise.resolve(), expiresAt: Infinity };
    receipt.promise = this.submit(id, input, content, mode, key).finally(() => {
      receipt.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    });
    this.receipts.set(key, receipt);
    return receipt.promise;
  }

  private async submit(
    id: string,
    input: MessageInput,
    content: string,
    mode: string,
    key: string,
  ): Promise<unknown> {
    await this.requireLoaded(id, true);
    const result = object(
      await this.rpc.request(mode === 'steer' ? 'turn/steer' : 'turn/start', {
        threadId: id,
        input: [{ type: 'text', text: content }],
        clientUserMessageId: key,
        ...(mode === 'steer' ? { expectedTurnId: input.expectedTurnId } : {}),
      }),
    );
    const turn = mode === 'steer' ? result.turnId : object(result.turn).id;
    return {
      status: 'accepted',
      sessionId: id,
      turnId: turn,
      messageId: key,
      source: input.source,
      mode,
    };
  }

  async resume(id: string): Promise<unknown> {
    return this.rpc.request('thread/resume', { threadId: sessionId(id), excludeTurns: true });
  }
  async attach(id: string): Promise<unknown> {
    await this.requireLoaded(sessionId(id));
    // Upstream has no subscribe-only RPC. This explicit operation uses resume;
    // a concurrent upstream unload can cause restoration. Never used by send().
    return this.resume(id);
  }
  async interrupt(id: string, turnId: string): Promise<unknown> {
    text(turnId, 'turnId', 128);
    await this.requireLoaded(sessionId(id), true);
    return this.rpc.request('turn/interrupt', { threadId: id, turnId });
  }

  private attributedText(input: Pick<MessageInput, 'text' | 'source'>): string {
    const body = text(input.text, 'text');
    const source = text(input.source, 'source', 64);
    if (!/^[A-Za-z0-9._-]+$/.test(source))
      throw new BridgeError(
        400,
        'invalid_input',
        'source must contain only letters, digits, dot, underscore or hyphen',
      );
    return `[External app: ${source}]\n${body}`;
  }

  private async requireLoaded(id: string, writable = false): Promise<void> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = object(await this.loaded({ limit: 100, ...(cursor ? { cursor } : {}) }));
      if (Array.isArray(page.data) && page.data.includes(id)) break;
      if (typeof page.nextCursor !== 'string')
        throw new BridgeError(
          409,
          'session_not_loaded',
          'Session is not loaded in this Codex instance; resume it explicitly',
        );
      if (seen.has(page.nextCursor))
        throw new BridgeError(502, 'invalid_backend_page', 'Codex repeated a pagination cursor');
      cursor = page.nextCursor;
      seen.add(cursor);
    }
    if (writable) {
      const thread = object(object(await this.detail(id)).thread);
      if (thread.canAcceptDirectInput === false || thread.parentThreadId) {
        throw new BridgeError(
          409,
          'direct_input_unavailable',
          'This child agent does not accept direct input; address the root session',
        );
      }
    }
  }
}

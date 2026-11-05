import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { searchHistory } from './search.js';
import { EventLog } from './events.js';
import { AccessPolicy, OWNER, type CallerPolicy } from './access.js';
import type { ReceiptStore, StoredReceipt, AdapterState } from './store.js';
import {
  address,
  addressKey,
  errorMessage,
  fingerprint,
  HubError,
  messageInput,
  pageQuery,
  object,
  text,
} from './validation.js';
import type {
  Adapter,
  Envelope,
  Json,
  MessageInput,
  PageQuery,
  Receipt,
  SessionAddress,
  SessionInfo,
  Update,
} from './types.js';

interface Entry extends StoredReceipt {
  promise: Promise<Receipt>;
}
const rank = {
  pending: 0,
  transport_written: 1,
  accepted: 2,
  held: 3,
  received: 4,
  unknown: 0,
  failed: 5,
  rejected: 5,
  replied: 6,
};
export class AgentHub {
  readonly events: EventLog;
  readonly access: AccessPolicy;
  private readonly adapters = new Map<string, Adapter>();
  private readonly entries = new Map<string, Entry>();
  private readonly changes = new EventEmitter();
  private readonly cleanups: (() => void)[] = [];
  private closed = false;
  private readonly initialization: Promise<void>;
  private storageFailure?: Error;
  private readonly featureMetadata = new Map<string, Json>();
  // Newest event sequence among removed messages. listMessages reports a gap
  // when a caller's cursor is older, because those changes can't be replayed.
  private removedThrough = 0;
  private deliveryGuards: ((envelope: Envelope) => void)[] = [];
  constructor(
    adapters: Adapter[],
    private readonly options: {
      receiptTtlMs?: number;
      receiptCapacity?: number;
      store?: ReceiptStore;
      callers?: CallerPolicy[];
    } = {},
  ) {
    this.changes.setMaxListeners(128);
    try {
      this.access = new AccessPolicy(options.callers);
      this.events = new EventLog(options.store);
    } catch (error) {
      options.store?.close();
      throw error;
    }
    for (const adapter of adapters) {
      const key = JSON.stringify([adapter.harness, adapter.instance]);
      if (this.adapters.has(key))
        throw new HubError('duplicate_adapter', `Duplicate adapter ${key}`);
      this.adapters.set(key, adapter);
    }
    try {
      const removed = options.store?.getMeta('messages:removed')?.sequence;
      if (typeof removed === 'number') this.removedThrough = removed;
      const legacy: StoredReceipt[] = [];
      for (const saved of options.store?.load() ?? []) {
        if (saved.expires <= Date.now()) {
          options.store!.remove([saved.envelope.messageId]);
          this.noteRemoved(saved);
          continue;
        }
        if (saved.phase !== 'settled') {
          if (!['replied', 'rejected', 'failed', 'received'].includes(saved.receipt.status)) {
            saved.receipt.status = 'unknown';
            saved.receipt.error = {
              code: 'process_restarted',
              message: 'Process stopped during submission; not automatically replayed',
            };
            saved.receipt.updatedAt = new Date().toISOString();
          }
          saved.phase = 'settled';
          saved.sequence = this.events.nextSequence;
          this.events.publish(
            'message.status',
            structuredClone(saved.receipt) as unknown as Json,
            addressKey(saved.envelope.to),
            null,
            saved.callerId ?? OWNER,
            [saved],
          );
        }
        if (saved.sequence === undefined) {
          // Records from before 0.4.0. The message ID orders those sharing a sequence.
          saved.sequence = Math.max(this.events.position.sequence, 1);
          legacy.push(saved);
        }
        this.entries.set(saved.envelope.messageId, {
          ...saved,
          promise: Promise.resolve(saved.receipt),
        });
      }
      if (legacy.length) options.store!.save(legacy);
    } catch (error) {
      options.store?.close();
      throw error;
    }
    for (const adapter of adapters) {
      const update = (value: Update) => {
        try {
          this.apply(adapter, value);
        } catch (error) {
          if (!this.storageFailure) throw error;
        }
      };
      const event = (data: Json) => {
        try {
          this.storeAction(() =>
            this.events.publish('adapter.event', {
              adapter: { harness: adapter.harness, instance: adapter.instance },
              ...data,
            }),
          );
        } catch (error) {
          if (!this.storageFailure) throw error;
        }
      };
      adapter.on('update', update);
      adapter.on('event', event);
      this.cleanups.push(() => {
        adapter.off('update', update);
        adapter.off('event', event);
      });
    }
    this.initialization = Promise.resolve().then(async () => {
      for (const adapter of adapters) {
        if (this.closed) return;
        const messages = [...this.entries.values()]
          .filter(
            (entry) =>
              entry.envelope.to.harness === adapter.harness &&
              entry.envelope.to.instance === adapter.instance &&
              !['replied', 'rejected', 'failed'].includes(entry.receipt.status),
          )
          .map((entry) => structuredClone(entry.envelope));
        const prefix = JSON.stringify([adapter.harness, adapter.instance]);
        const state: AdapterState | undefined = options.store
          ? {
              get: (key) => options.store!.getMeta(`${prefix}:${key}`),
              set: (key, value) =>
                this.storeAction(() => options.store!.setMeta(`${prefix}:${key}`, value)),
            }
          : undefined;
        await adapter.restore?.(messages, state);
      }
      if (!this.closed)
        for (const entry of this.entries.values())
          if (entry.forwardState === 'ready' && entry.receipt.reply)
            void this.forward(entry, entry.receipt.reply.text);
    });
    void this.initialization.catch(() => {});
  }
  async ready(): Promise<void> {
    await this.initialization;
    this.healthy();
  }
  /** Trusted in-process hook. A throw refuses delivery after every earlier check. */
  guardDelivery(guard: (envelope: Envelope) => void) {
    this.deliveryGuards.push(guard);
  }
  /** Trusted in-process extension state, never exposed through the public API. */
  featureState(namespace: string): AdapterState {
    const prefix = `feature:${text(namespace, 'namespace', 64)}:`;
    return {
      get: (key) => {
        this.healthy();
        return structuredClone(
          this.options.store?.getMeta(prefix + key) ?? this.featureMetadata.get(prefix + key),
        );
      },
      set: (key, value) =>
        this.storeAction(() => {
          if (this.options.store) this.options.store.setMeta(prefix + key, value);
          else this.featureMetadata.set(prefix + key, structuredClone(value));
        }),
    };
  }
  /** Only a verified connector may supply responder. No receipt/history access is implied. */
  async replyToMessage(id: string, responder: SessionAddress, body: string, callerId: string) {
    await this.ready();
    text(body, 'message');
    this.prune();
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.envelope.messageKind !== 'request' ||
      addressKey(entry.envelope.to) !== addressKey(responder)
    )
      throw new HubError('request_not_found', 'No request for this source', 404);
    this.access.require(callerId, 'send', responder, responder.sessionId);
    if (entry.envelope.replyTo)
      this.access.require(
        callerId,
        'send',
        entry.envelope.replyTo,
        entry.envelope.replyTo.sessionId,
      );
    if (entry.receipt.status === 'replied') {
      if (entry.receipt.reply?.text !== body)
        throw new HubError('reply_conflict', 'A different reply is already recorded', 409);
      return { request: id, accepted: true, duplicate: true };
    }
    if (Date.parse(entry.envelope.expiresAt) <= Date.now())
      throw new HubError(
        'request_expired',
        'Request expired; reply was not accepted or forwarded',
        409,
      );
    this.apply(this.adapter(responder), {
      messageId: id,
      status: 'replied',
      reply: { text: body },
    });
    return { request: id, accepted: true, duplicate: false };
  }
  private healthy(): void {
    if (this.storageFailure)
      throw new HubError('storage_unavailable', this.storageFailure.message, 503);
  }
  private storeAction(action: () => void) {
    this.healthy();
    try {
      action();
    } catch (error) {
      this.storageFailure = new Error(errorMessage(error));
      try {
        this.events.publish('storage.error', { message: this.storageFailure.message });
      } catch {}
      throw new HubError('storage_unavailable', this.storageFailure.message, 503);
    }
  }
  private persist(...entries: Entry[]) {
    if (this.options.store)
      this.storeAction(() =>
        this.options.store!.save(entries.map(({ promise: _promise, ...record }) => record)),
      );
  }
  instances(callerId = OWNER): { harness: string; instance: string }[] {
    return [...this.adapters.values()]
      .filter((a) => this.access.visible(callerId, a))
      .map(({ harness, instance }) => ({ harness, instance }));
  }
  adapter(a: Pick<SessionAddress, 'harness' | 'instance'>): Adapter {
    this.healthy();
    if (this.closed) throw new HubError('closed', 'Hub is closed', 503);
    const adapter = this.adapters.get(JSON.stringify([a.harness, a.instance]));
    if (!adapter) throw new HubError('adapter_not_found', 'Unknown harness instance', 404);
    return adapter;
  }
  async listSessions(
    a: Pick<SessionAddress, 'harness' | 'instance'>,
    query: PageQuery = {},
    callerId = OWNER,
  ) {
    return this.listSessionPage(a, query, callerId, false);
  }
  /** Connector discovery uses live adapter inventory, retaining the same read grants. */
  async listPeerSessions(
    a: Pick<SessionAddress, 'harness' | 'instance'>,
    query: PageQuery = {},
    callerId = OWNER,
  ) {
    return this.listSessionPage(a, query, callerId, true);
  }
  private async listSessionPage(
    a: Pick<SessionAddress, 'harness' | 'instance'>,
    query: PageQuery,
    callerId: string,
    peers: boolean,
  ) {
    await this.ready();
    const ids = this.access.sessions(callerId, 'read', a),
      q = pageQuery(query);
    const available = (row: SessionInfo) =>
      !peers ||
      (row.status !== 'notLoaded' &&
        row.capabilities.send.some((delivery) => delivery !== 'user_input'));
    const matches = (row: SessionInfo) =>
      !q.search ||
      `${row.name ?? ''}\n${row.cwd ?? ''}\n${row.address.sessionId}`
        .toLocaleLowerCase()
        .includes(q.search.toLocaleLowerCase());
    if (ids === null) {
      const adapter = this.adapter(a);
      const page = await (peers && adapter.listPeerSessions
        ? adapter.listPeerSessions(q)
        : adapter.listSessions(q));
      return peers ? { ...page, data: page.data.filter(available).filter(matches) } : page;
    }
    const binding = fingerprint([callerId, a, ids, q.search ?? '', ...(peers ? ['peers'] : [])]);
    let offset = 0;
    if (q.cursor) {
      let c: Json;
      try {
        c = object(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      } catch {
        throw new HubError('invalid_cursor', 'Invalid scoped cursor');
      }
      if (
        c.binding !== binding ||
        !Number.isSafeInteger(c.offset) ||
        Number(c.offset) < 0 ||
        Number(c.offset) > ids.length
      )
        throw new HubError('invalid_cursor', 'Cursor belongs to another caller, scope or query');
      offset = Number(c.offset);
    }
    const selected = ids.slice(offset, offset + (q.limit ?? 50));
    const rows = await Promise.all(
      selected.map(async (sessionId) => {
        try {
          return await this.adapter(a).getSession({ ...a, sessionId });
        } catch (e) {
          if ([404, 409].includes((e as HubError).status)) return undefined;
          throw e;
        }
      }),
    );
    const data = rows
      .filter((r) => r !== undefined)
      .filter(available)
      .filter(matches);
    const next = offset + selected.length;
    return {
      data,
      nextCursor:
        next < ids.length
          ? Buffer.from(JSON.stringify({ binding, offset: next })).toString('base64url')
          : null,
    };
  }
  async getSession(a: SessionAddress, callerId = OWNER) {
    await this.ready();
    const valid = address(a);
    this.access.require(callerId, 'read', valid, valid.sessionId);
    return this.adapter(valid).getSession(valid);
  }
  async history(a: SessionAddress, query: PageQuery = {}, callerId = OWNER) {
    await this.ready();
    const valid = address(a);
    this.access.require(callerId, 'read', valid, valid.sessionId);
    return this.adapter(valid).history(valid, pageQuery(query));
  }
  async search(a: SessionAddress, query: PageQuery & { search: string }, callerId = OWNER) {
    await this.ready();
    const valid = address(a);
    this.access.require(callerId, 'read', valid, valid.sessionId);
    return searchHistory(this.adapter(valid), valid, query, callerId);
  }
  async send(value: MessageInput, callerId = OWNER): Promise<Receipt> {
    if (value.delivery === 'user_input')
      throw new HubError(
        'explicit_prompt_required',
        'Use the explicit prompt operation for user_input',
        422,
      );
    return this.sendInput(value, undefined, callerId);
  }
  async prompt(value: MessageInput, callerId = OWNER) {
    if (value.delivery !== 'user_input' || value.replyTo)
      throw new HubError(
        'invalid_input',
        'Explicit prompts require user_input and cannot auto-forward replies',
      );
    return this.sendInput(value, undefined, callerId);
  }
  async createSession(
    scope: Pick<SessionAddress, 'harness' | 'instance'>,
    cwd: string,
    callerId = OWNER,
  ) {
    await this.ready();
    if (this.access.sessions(callerId, 'manage', scope) !== null)
      throw new HubError('forbidden', 'Creation requires instance-wide manage permission', 403);
    const adapter = this.adapter(scope);
    if (!adapter.createSession)
      throw new HubError('unsupported', 'Only managed adapters can create sessions', 501);
    return adapter.createSession(cwd);
  }
  async cancel(a: SessionAddress, callerId = OWNER) {
    await this.ready();
    const valid = address(a);
    this.access.require(callerId, 'manage', valid, valid.sessionId);
    const adapter = this.adapter(valid);
    if (!adapter.cancel) throw new HubError('unsupported', 'Managed cancellation unavailable', 501);
    await adapter.cancel(valid);
  }
  async attachReplyRoute(
    a: SessionAddress,
    options: { acceptResumeRace: boolean },
    callerId = OWNER,
  ) {
    await this.ready();
    const valid = address(a);
    this.access.require(callerId, 'attach', valid, valid.sessionId);
    const adapter = this.adapter(valid);
    if (!adapter.attachReplyRoute)
      throw new HubError(
        'unsupported',
        'Adapter does not expose explicit reply-route attachment',
        501,
      );
    return adapter.attachReplyRoute(valid, options);
  }
  private async sendInput(value: MessageInput, parent?: Entry, callerId = OWNER): Promise<Receipt> {
    await this.ready();
    const input = messageInput(value);
    this.access.require(
      callerId,
      input.delivery === 'user_input' ? 'prompt' : 'send',
      input.to,
      input.to.sessionId,
    );
    if (input.replyTo)
      this.access.require(callerId, 'send', input.replyTo, input.replyTo.sessionId);
    const hash = fingerprint(input);
    this.prune();
    const existing = this.entries.get(input.messageId);
    if (existing) {
      if ((existing.callerId ?? OWNER) !== callerId)
        throw new HubError('receipt_not_found', 'Receipt not found or expired', 404);
      if (existing.fingerprint !== hash)
        throw new HubError(
          'idempotency_conflict',
          'messageId already used with a different payload',
          409,
        );
      await existing.promise;
      return structuredClone(existing.receipt);
    }
    const adapter = this.adapter(input.to);
    if (this.entries.size >= (this.options.receiptCapacity ?? 10000))
      throw new HubError('receipt_capacity', 'Receipt capacity reached', 429);
    const now = new Date().toISOString();
    const envelope: Envelope = {
      ...input,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
      hopCount: input.hopCount ?? 0,
    };
    if (Date.parse(envelope.expiresAt) <= Date.now())
      throw new HubError('expired', 'Message expired', 409);
    if (envelope.replyTo) this.adapter(envelope.replyTo);
    const receipt: Receipt = {
      messageId: input.messageId,
      to: input.to,
      delivery: input.delivery,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    const entry: Entry = {
      callerId,
      fingerprint: hash,
      envelope,
      receipt,
      promise: Promise.resolve(receipt),
      expires: Date.now() + (this.options.receiptTtlMs ?? 86400000),
      phase: 'reserved',
      forwardState: 'none',
    };
    if (parent) parent.forwardState = 'reserved';
    this.entries.set(input.messageId, entry);
    try {
      this.publish(entry, parent ? [parent] : []);
    } catch (error) {
      this.entries.delete(input.messageId);
      throw error;
    }
    entry.promise = this.submit(adapter, entry).finally(() => {
      if (!this.closed) {
        entry.phase = 'settled';
        entry.expires = Date.now() + (this.options.receiptTtlMs ?? 86400000);
        this.persist(entry);
      }
    });
    return entry.promise;
  }
  private async submit(adapter: Adapter, entry: Entry): Promise<Receipt> {
    try {
      const session = await adapter.getSession(entry.envelope.to);
      if (this.closed) throw new HubError('closed', 'Hub is closed', 503);
      if (!session.capabilities.send.includes(entry.envelope.delivery))
        throw new HubError(
          'unsupported_delivery',
          'Target does not support the requested delivery semantics',
          422,
        );
      if (Date.parse(entry.envelope.expiresAt) <= Date.now())
        throw new HubError('expired', 'Message expired', 409);
      // No await may follow this before adapter.send.
      for (const guard of this.deliveryGuards) guard(entry.envelope);
    } catch (error) {
      this.apply(adapter, {
        messageId: entry.envelope.messageId,
        status: 'failed',
        error: { code: 'not_submitted', message: errorMessage(error) },
      });
      throw error;
    }
    try {
      entry.phase = 'dispatching';
      this.persist(entry);
      const result = await adapter.send(structuredClone(entry.envelope));
      this.apply(adapter, { messageId: entry.envelope.messageId, ...result });
    } catch (error) {
      const e = (error && typeof error === 'object' ? error : {}) as {
        deliveryUnknown?: boolean;
        details?: { deliveryUnknown?: boolean };
        code?: string;
      };
      this.apply(adapter, {
        messageId: entry.envelope.messageId,
        status: e.deliveryUnknown || e.details?.deliveryUnknown ? 'unknown' : 'failed',
        error: {
          code: typeof e.code === 'string' ? e.code : 'send_failed',
          message: errorMessage(error),
        },
      });
    }
    return structuredClone(entry.receipt);
  }
  private apply(adapter: Adapter, update: Update): void {
    if (this.closed) return;
    const entry = this.entries.get(update.messageId);
    if (
      !entry ||
      entry.envelope.to.harness !== adapter.harness ||
      entry.envelope.to.instance !== adapter.instance ||
      !(update.status in rank)
    )
      return;
    if (entry.receipt.status === 'replied') return;
    // Result messages can accumulate transport evidence, never another business reply.
    if (entry.envelope.messageKind === 'result' && (update.status === 'replied' || update.reply))
      return;
    if (update.status !== 'unknown' && rank[update.status] < rank[entry.receipt.status]) return;
    if (
      update.status === 'unknown' &&
      ['replied', 'rejected', 'failed', 'received'].includes(entry.receipt.status)
    )
      return;
    if (
      update.reply &&
      (typeof update.reply.text !== 'string' || update.reply.text.length > 100000)
    )
      return;
    if (update.status === 'replied') delete entry.receipt.noReply;
    Object.assign(entry.receipt, structuredClone(update), { updatedAt: new Date().toISOString() });
    if (
      update.status === 'replied' &&
      update.reply &&
      entry.envelope.replyTo &&
      entry.forwardState === 'none'
    ) {
      entry.forwardState = 'ready';
      entry.receipt.forwardedMessageId = randomUUID();
    }
    this.publish(entry);
    if (update.status === 'replied' && update.reply && entry.forwardState === 'ready') {
      void this.forward(entry, update.reply.text);
    }
  }
  private async forward(entry: Entry, body: string): Promise<void> {
    const original = entry.envelope;
    const to = original.replyTo!;
    const messageId = entry.receipt.forwardedMessageId!;
    try {
      const callerId = entry.callerId ?? OWNER;
      this.access.require(callerId, 'send', original.to, original.to.sessionId);
      this.access.require(callerId, 'send', to, to.sessionId);
      const target = await this.adapter(to).getSession(to);
      const delivery = target.capabilities.send.find((d) => d !== 'user_input');
      if (!delivery)
        throw new HubError('unsupported_delivery', 'Reply destination does not accept messages');
      const result = await this.sendInput(
        {
          messageId,
          messageKind: 'result',
          to,
          delivery,
          text: body,
          origin: {
            name: `${original.to.harness} via AgentHub${
              entry.receipt.reply?.metadata?.source === 'turn_final_message'
                ? ' (taken from its final answer; it did not call reply_agent)'
                : ''
            }`,
            session: original.to,
          },
          inReplyTo: original.messageId,
          correlationId: original.correlationId ?? original.messageId,
          expiresAt: original.expiresAt,
          hopCount: original.hopCount + 1,
        },
        entry,
        entry.callerId ?? OWNER,
      );
      if (['failed', 'rejected', 'unknown'].includes(result.status))
        entry.receipt.forwardError = result.error?.message ?? result.status;
      entry.forwardState = 'done';
    } catch (error) {
      entry.receipt.forwardError = errorMessage(error);
      if (entry.forwardState === 'ready') entry.forwardState = 'blocked';
    }
    if (!this.closed && !this.storageFailure) {
      this.publish(entry);
    }
  }
  private publish(entry: Entry, related: Entry[] = []): void {
    entry.sequence = this.events.nextSequence;
    for (const other of related) other.sequence = entry.sequence;
    this.storeAction(() =>
      this.events.publish(
        'message.status',
        structuredClone(entry.receipt) as unknown as Json,
        addressKey(entry.envelope.to),
        null,
        entry.callerId ?? OWNER,
        [entry, ...related].map(({ promise: _promise, ...record }) => record),
      ),
    );
    this.changes.emit(entry.envelope.messageId);
  }
  receipt(id: string, callerId = OWNER): Receipt {
    this.healthy();
    text(id, 'messageId', 128);
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || !this.access.receipt(callerId, entry.callerId ?? OWNER, entry.envelope.to))
      throw new HubError('receipt_not_found', 'Receipt not found or expired', 404);
    return structuredClone(entry.receipt);
  }
  async wait(id: string, timeoutMs = 30000, callerId = OWNER): Promise<Receipt> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000)
      throw new HubError('invalid_input', 'timeoutMs must be 0..60000');
    const done = () =>
      ['replied', 'rejected', 'failed'].includes(this.receipt(id, callerId).status);
    if (done() || timeoutMs === 0 || this.closed) return this.receipt(id, callerId);
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.changes.off(id, changed);
        this.changes.off('closed', finish);
        try {
          resolve(this.receipt(id, callerId));
        } catch (error) {
          reject(error);
        }
      };
      const changed = () => {
        try {
          if (done()) finish();
        } catch {
          finish();
        }
      };
      const timer = setTimeout(finish, timeoutMs);
      this.changes.on(id, changed);
      this.changes.on('closed', finish);
    });
  }
  private prune(): void {
    const ids = [...this.entries]
      .filter(([, entry]) => entry.phase === 'settled' && entry.expires < Date.now())
      .map(([id]) => id);
    if (this.options.store && ids.length) this.storeAction(() => this.options.store!.remove(ids));
    for (const id of ids) {
      this.noteRemoved(this.entries.get(id)!);
      this.entries.delete(id);
    }
  }
  private noteRemoved(entry: { sequence?: number }) {
    const sequence = entry.sequence ?? 0;
    if (sequence <= this.removedThrough) return;
    this.removedThrough = sequence;
    this.options.store?.setMeta('messages:removed', { sequence });
  }
  private requireOwner(callerId: string, action: string) {
    if (callerId !== OWNER) throw new HubError('forbidden', `${action} require the owner`, 403);
  }
  /**
   * Owner view of retained messages, oldest change first. A message reappears
   * whenever it changes, so consumers upsert by messageId. `gap` means changes
   * after the supplied cursor were removed and can no longer be returned.
   */
  async listMessages(query: { cursor?: string; limit?: number } = {}, callerId = OWNER) {
    await this.ready();
    this.requireOwner(callerId, 'Message listings');
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new HubError('invalid_input', 'limit must be 1..500');
    this.prune();
    const { epoch, sequence } = this.events.position;
    let after = 0,
      afterId = '',
      gap = false;
    if (query.cursor !== undefined) {
      const match = /^([^:]+):(\d+)(?::(.+))?$/.exec(query.cursor);
      if (!match || !Number.isSafeInteger(Number(match[2])))
        throw new HubError('invalid_cursor', 'Malformed message cursor');
      if (match[1] !== epoch || Number(match[2]) > sequence) gap = true;
      else {
        after = Number(match[2]);
        afterId = match[3] ?? '\u{10ffff}';
        gap = after < this.removedThrough;
      }
    }
    const position = (entry: Entry) => [entry.sequence ?? 0, entry.envelope.messageId] as const;
    const rows = [...this.entries.values()]
      .filter((entry) => {
        if (query.cursor === undefined || gap) return true;
        const [rowSequence, id] = position(entry);
        return rowSequence > after || (rowSequence === after && id > afterId);
      })
      .sort((a, b) => {
        const [aSequence, aId] = position(a),
          [bSequence, bId] = position(b);
        return aSequence - bSequence || (aId < bId ? -1 : aId > bId ? 1 : 0);
      });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = page.at(-1);
    return {
      data: page.map(({ envelope, receipt }) => structuredClone({ envelope, receipt })),
      // Messages can share a sequence, so a partial page also records the message ID.
      nextCursor: hasMore
        ? `${epoch}:${last!.sequence ?? 0}:${last!.envelope.messageId}`
        : `${epoch}:${sequence}`,
      hasMore,
      gap,
    };
  }
  /**
   * Removes finished messages and every retained event. Requests still waiting
   * for a reply or a forward are kept, so a late reply isn't lost.
   */
  async clearMessages(callerId = OWNER) {
    await this.ready();
    this.requireOwner(callerId, 'Message clearing');
    this.healthy();
    const store = this.options.store;
    if (store && !store.clearMessages)
      throw new HubError('unsupported', 'This store cannot clear messages', 501);
    const now = Date.now();
    const finished = (entry: Entry) =>
      entry.phase === 'settled' &&
      (Date.parse(entry.envelope.expiresAt) <= now ||
        (['none', 'done'].includes(entry.forwardState) &&
          (entry.envelope.messageKind !== 'request' ||
            ['replied', 'failed', 'rejected'].includes(entry.receipt.status))));
    const removed = [...this.entries.values()].filter(finished);
    const ids = removed.map((entry) => entry.envelope.messageId);
    const removedThrough = this.events.position.sequence;
    this.storeAction(() =>
      this.events.truncate((state) =>
        store?.clearMessages?.(ids, state, { sequence: removedThrough }),
      ),
    );
    for (const id of ids) this.entries.delete(id);
    this.removedThrough = removedThrough;
    const result = { removed: ids.length, retained: this.entries.size };
    this.storeAction(() => this.events.publish('messages.cleared', result, null, null, OWNER));
    return result;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    let failure: unknown;
    try {
      for (const entry of this.entries.values())
        if (entry.phase !== 'settled') {
          if (!['replied', 'received', 'failed', 'rejected'].includes(entry.receipt.status)) {
            entry.receipt.status = 'unknown';
            entry.receipt.error = {
              code: 'closed_during_submission',
              message: 'Hub closed during submission; no automatic replay',
            };
          }
          entry.phase = 'settled';
          if (!this.storageFailure) this.publish(entry);
        }
    } catch (error) {
      failure = error;
    }
    this.closed = true;
    this.changes.emit('closed');
    for (const cleanup of this.cleanups) cleanup();
    try {
      const results = await Promise.allSettled(
        [...this.adapters.values()].map((adapter) => adapter.close()),
      );
      for (const result of results) if (result.status === 'rejected') failure ??= result.reason;
    } finally {
      this.options.store?.close();
    }
    if (failure) throw failure;
  }
}

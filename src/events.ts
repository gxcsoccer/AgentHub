import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { HubError } from './validation.js';
import type { Json } from './types.js';
import type { ReceiptStore, StoredReceipt } from './store.js';
export interface HubEvent {
  id: string;
  type: string;
  timestamp: string;
  sessionId: string | null;
  turnId: string | null;
  data: Json;
  audience?: string;
}
export interface EventSnapshot {
  epoch: string;
  sequence: number;
  dropped: number;
  events: HubEvent[];
}
export class EventLog extends EventEmitter {
  private epoch = randomUUID();
  private sequence = 0;
  private dropped = 0;
  private bytes = 0;
  private entries: { event: HubEvent; size: number; sequence: number }[] = [];
  constructor(
    private readonly store?: ReceiptStore,
    private readonly capacity = 2000,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {
    super();
    this.setMaxListeners(128);
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new HubError('invalid_input', 'Event bounds must be positive integers');
    const saved = store?.loadEvents?.();
    if (saved) {
      this.epoch = saved.epoch as ReturnType<typeof randomUUID>;
      this.sequence = saved.sequence;
      this.dropped = saved.dropped;
      this.entries = saved.events.map((event) => ({
        event,
        size: Buffer.byteLength(JSON.stringify(event)),
        sequence: Number(event.id.split(':')[1]),
      }));
      this.bytes = this.entries.reduce((n, e) => n + e.size, 0);
    } else if (store?.appendEvent) {
      store.setMeta('events:state', { epoch: this.epoch, sequence: 0, dropped: 0 });
    }
  }
  get cursor() {
    return `${this.epoch}:${this.sequence}`;
  }
  /** Sequence the next published event will take. */
  get nextSequence() {
    return this.sequence + 1;
  }
  get position() {
    return { epoch: this.epoch as string, sequence: this.sequence };
  }
  /** Forgets retained events. Older cursors then report event_cursor_expired. */
  truncate(commit: (state: Omit<EventSnapshot, 'events'>) => void) {
    commit({ epoch: this.epoch, sequence: this.sequence, dropped: this.sequence });
    this.entries = [];
    this.bytes = 0;
    this.dropped = this.sequence;
  }
  get durable() {
    return Boolean(this.store?.appendEvent);
  }
  publish(
    type: string,
    data: Json,
    sessionId: string | null = null,
    turnId: string | null = null,
    audience?: string,
    records: StoredReceipt[] = [],
  ): HubEvent {
    const sequence = this.sequence + 1;
    const event: HubEvent = {
      id: `${this.epoch}:${sequence}`,
      type,
      timestamp: new Date().toISOString(),
      sessionId,
      turnId,
      data: structuredClone(data),
      ...(audience ? { audience } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(event));
    const entries = [...this.entries, { event, size, sequence }];
    let bytes = this.bytes + size,
      dropped = this.dropped;
    while (entries.length > this.capacity || bytes > this.maxBytes) {
      const removed = entries.shift()!;
      bytes -= removed.size;
      dropped = removed.sequence;
    }
    if (this.store?.appendEvent)
      this.store.appendEvent(event, { epoch: this.epoch, sequence, dropped }, records);
    else if (this.store && records.length) this.store.save(records);
    this.entries = entries;
    this.bytes = bytes;
    this.dropped = dropped;
    this.sequence = sequence;
    this.emit('event', structuredClone(event));
    return event;
  }
  replay(after: string, sessionId?: string): HubEvent[] {
    const [epoch, raw, extra] = after.split(':');
    if (epoch !== this.epoch)
      throw new HubError(
        'event_cursor_invalid',
        'Cursor belongs to another event log; reload receipts/history',
        409,
      );
    if (extra !== undefined || !raw || !/^\d+$/.test(raw))
      throw new HubError('event_cursor_invalid', 'Malformed event cursor');
    const sequence = Number(raw);
    if (!Number.isSafeInteger(sequence) || sequence > this.sequence)
      throw new HubError('event_cursor_invalid', 'Cursor is in the future', 409);
    if (sequence < this.dropped)
      throw new HubError(
        'event_cursor_expired',
        'Event cursor expired; reload receipts/history',
        409,
      );
    return this.entries
      .filter(
        (x) =>
          x.sequence > sequence &&
          (!sessionId || x.event.sessionId === sessionId || x.event.sessionId === null),
      )
      .map((x) => structuredClone(x.event));
  }
}

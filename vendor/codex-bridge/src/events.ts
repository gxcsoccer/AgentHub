import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BridgeEvent, JsonObject } from './contracts.js';
import { BridgeError } from './errors.js';
export class EventLog extends EventEmitter {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private dropped = 0;
  private bytes = 0;
  private readonly entries: { event: BridgeEvent; bytes: number; sequence: number }[] = [];
  constructor(
    private readonly capacity = 2000,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {
    super();
    this.setMaxListeners(100);
    if (capacity < 1 || maxBytes < 1) throw new Error('Event capacity must be positive');
  }
  get cursor(): string {
    return `${this.epoch}:${this.sequence}`;
  }
  publish(
    type: string,
    data: JsonObject,
    sessionId: string | null = null,
    turnId: string | null = null,
  ): BridgeEvent {
    this.sequence++;
    const event: BridgeEvent = {
      id: this.cursor,
      type,
      sessionId,
      turnId,
      timestamp: new Date().toISOString(),
      data: structuredClone(data),
    };
    const size = Buffer.byteLength(JSON.stringify(event));
    this.entries.push({ event, bytes: size, sequence: this.sequence });
    this.bytes += size;
    while (this.entries.length > this.capacity || this.bytes > this.maxBytes) {
      const removed = this.entries.shift()!;
      this.bytes -= removed.bytes;
      this.dropped = removed.sequence;
    }
    this.emit('event', event);
    return event;
  }
  replay(after: string, sessionId?: string): BridgeEvent[] {
    const [epoch, raw, extra] = after.split(':');
    if (epoch !== this.epoch)
      throw new BridgeError(
        409,
        'event_cursor_invalid',
        'Cursor belongs to a different bridge process; reload session detail',
      );
    if (extra !== undefined || !raw || !/^\d+$/.test(raw))
      throw new BridgeError(400, 'event_cursor_invalid', 'Malformed event cursor');
    const sequence = Number(raw);
    if (!Number.isSafeInteger(sequence) || sequence > this.sequence)
      throw new BridgeError(409, 'event_cursor_invalid', 'Cursor is in the future');
    if (sequence < this.dropped)
      throw new BridgeError(
        409,
        'event_cursor_expired',
        'Event cursor expired; reload session detail',
      );
    return this.entries
      .filter(
        (entry) =>
          entry.sequence > sequence &&
          (!sessionId || entry.event.sessionId === sessionId || entry.event.sessionId === null),
      )
      .map((entry) => structuredClone(entry.event));
  }
}

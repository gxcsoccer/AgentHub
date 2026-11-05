import type { DatabaseSync } from 'node:sqlite';
import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { HubError, messageInput, object, addressKey, address, uuid } from './validation.js';
import type { Envelope, Json, Receipt } from './types.js';
import type { EventSnapshot, HubEvent } from './events.js';

export interface StoredReceipt {
  callerId?: string;
  fingerprint: string;
  envelope: Envelope;
  receipt: Receipt;
  expires: number;
  phase: 'reserved' | 'dispatching' | 'settled';
  forwardState: 'none' | 'ready' | 'reserved' | 'done' | 'blocked';
  /** Event sequence of the last change. Absent on records from older versions. */
  sequence?: number;
}
export interface AdapterState {
  get(key: string): Json | undefined;
  set(key: string, value: Json): void;
}
export interface ReceiptStore {
  load(): StoredReceipt[];
  save(records: StoredReceipt[]): void;
  remove(ids: string[]): void;
  getMeta(key: string): Json | undefined;
  setMeta(key: string, value: Json): void;
  clearMessages?(ids: string[], state: Omit<EventSnapshot, 'events'>, removedThrough: Json): void;
  loadEvents?(): EventSnapshot | undefined;
  appendEvent?(
    event: HubEvent,
    state: Omit<EventSnapshot, 'events'>,
    records?: StoredReceipt[],
  ): void;
  close(): void;
}

function validate(value: unknown): StoredReceipt {
  const row = object(value),
    envelope = object(row.envelope),
    receipt = object(row.receipt);
  const input = messageInput(envelope);
  const statuses = [
    'pending',
    'transport_written',
    'accepted',
    'held',
    'received',
    'replied',
    'rejected',
    'failed',
    'unknown',
  ];
  if (
    typeof row.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
    !Number.isFinite(row.expires) ||
    !['reserved', 'dispatching', 'settled'].includes(String(row.phase)) ||
    !['none', 'ready', 'reserved', 'done', 'blocked'].includes(String(row.forwardState)) ||
    typeof envelope.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(envelope.expiresAt)) ||
    receipt.messageId !== input.messageId ||
    receipt.delivery !== input.delivery ||
    addressKey(address(receipt.to)) !== addressKey(input.to) ||
    !statuses.includes(String(receipt.status)) ||
    typeof receipt.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.createdAt)) ||
    typeof receipt.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(receipt.updatedAt)) ||
    !Number.isSafeInteger(envelope.hopCount) ||
    (row.forwardState !== 'none' &&
      (!input.replyTo ||
        receipt.status !== 'replied' ||
        !receipt.reply ||
        typeof receipt.forwardedMessageId !== 'string')) ||
    (input.messageKind === 'result' &&
      (receipt.status === 'replied' || receipt.reply !== undefined))
  )
    throw new HubError('corrupt_store', 'Invalid persisted receipt; refusing recovery', 500);
  if (receipt.forwardedMessageId !== undefined) uuid(receipt.forwardedMessageId);
  if (
    row.callerId !== undefined &&
    (typeof row.callerId !== 'string' || !row.callerId || row.callerId.length > 128)
  )
    throw new HubError('corrupt_store', 'Invalid caller binding', 500);
  if (receipt.reply !== undefined) {
    const reply = object(receipt.reply);
    if (typeof reply.text !== 'string' || reply.text.length > 100000)
      throw new HubError('corrupt_store', 'Invalid saved reply', 500);
    if (reply.metadata !== undefined) object(reply.metadata);
  }
  if (receipt.native !== undefined) object(receipt.native);
  if (receipt.error !== undefined) {
    const error = object(receipt.error);
    if (typeof error.code !== 'string' || typeof error.message !== 'string')
      throw new HubError('corrupt_store', 'Invalid saved error', 500);
  }
  return value as StoredReceipt;
}

async function privateFile(path: string) {
  try {
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new HubError(
      'unsafe_store',
      'State files must be private regular files owned by this user',
      403,
    );
}

/** Single-process ownership uses a separate SQLite transaction lock. The OS
 * releases it after SIGKILL; no stale PID lock is deleted or guessed. */
export async function openReceiptStore(filename: string): Promise<ReceiptStore> {
  if (process.platform === 'win32')
    throw new HubError(
      'unsupported_platform',
      'SQLite private state currently requires POSIX file ownership; use explicit ephemeral mode on Windows',
      501,
    );
  const path = resolve(filename),
    directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)
    throw new HubError(
      'unsafe_store',
      'State directory must be owned by this user and mode 0700',
      403,
    );
  await privateFile(path);
  await privateFile(path + '.lock');
  const { DatabaseSync } = await import('node:sqlite');
  let lock: DatabaseSync | undefined, db: DatabaseSync | undefined;
  try {
    lock = new DatabaseSync(path + '.lock');
    try {
      lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    } catch {
      throw new HubError('store_in_use', 'State store is already open by another owner', 409);
    }
    db = new DatabaseSync(path);
    const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
      throw new HubError('store_version', 'Unsupported state schema version', 409);
    if (
      version === 0 &&
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length
    )
      throw new HubError('invalid_store', 'Refusing to initialize an unrelated database', 409);
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;
      PRAGMA user_version=3; COMMIT;`);
    return new SqliteReceiptStore(db, lock);
  } catch (error) {
    db?.close();
    lock?.close();
    throw error;
  }
}

class SqliteReceiptStore implements ReceiptStore {
  private closed = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly lock: DatabaseSync,
  ) {}
  load(): StoredReceipt[] {
    try {
      return this.db
        .prepare('SELECT id,value FROM receipts')
        .all()
        .map((row) => {
          const record = validate(JSON.parse(String(row.value)));
          if (row.id !== record.envelope.messageId) throw new Error('Receipt key mismatch');
          return record;
        });
    } catch (error) {
      throw new HubError(
        'corrupt_store',
        `Cannot recover state: ${error instanceof Error ? error.message : error}`,
        500,
      );
    }
  }
  save(records: StoredReceipt[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(
        'INSERT INTO receipts(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      );
      for (const row of records) {
        validate(row);
        stmt.run(row.envelope.messageId, JSON.stringify(row));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  remove(ids: string[]) {
    if (!ids.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare('DELETE FROM receipts WHERE id=?');
      const meta = this.db.prepare('DELETE FROM metadata WHERE key LIKE ?');
      for (const id of ids) {
        stmt.run(id);
        meta.run(`%:outgoing:${id}`);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  clearMessages(ids: string[], state: Omit<EventSnapshot, 'events'>, removedThrough: Json) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare('DELETE FROM receipts WHERE id=?');
      const meta = this.db.prepare('DELETE FROM metadata WHERE key LIKE ?');
      for (const id of ids) {
        stmt.run(id);
        meta.run(`%:outgoing:${id}`);
      }
      // Status events carry reply text. The checkpoint stays so cursors see a gap.
      this.db.exec('DELETE FROM events');
      this.setMeta('events:state', state);
      this.setMeta('messages:removed', removedThrough);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getMeta(key: string): Json | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? object(JSON.parse(String(row.value))) : undefined;
  }
  loadEvents(): EventSnapshot | undefined {
    const meta = this.getMeta('events:state');
    const rows = this.db.prepare('SELECT sequence,value FROM events ORDER BY sequence').all();
    if (!meta && !rows.length) return undefined;
    if (
      !meta ||
      typeof meta.epoch !== 'string' ||
      !Number.isSafeInteger(meta.sequence) ||
      !Number.isSafeInteger(meta.dropped) ||
      Number(meta.dropped) < 0 ||
      Number(meta.sequence) < Number(meta.dropped)
    )
      throw new HubError('corrupt_store', 'Invalid event checkpoint', 500);
    uuid(meta.epoch);
    let previous = Number(meta.dropped);
    const events = rows.map((row) => {
      const event = object(JSON.parse(String(row.value))) as unknown as HubEvent;
      if (
        Number(row.sequence) !== previous + 1 ||
        event.id !== `${meta.epoch}:${row.sequence}` ||
        typeof event.type !== 'string' ||
        !Number.isFinite(Date.parse(event.timestamp)) ||
        (event.sessionId !== null && typeof event.sessionId !== 'string') ||
        (event.audience !== undefined && typeof event.audience !== 'string')
      )
        throw new HubError('corrupt_store', 'Invalid retained event', 500);
      object(event.data);
      previous = Number(row.sequence);
      return event;
    });
    if (previous !== meta.sequence)
      throw new HubError('corrupt_store', 'Event checkpoint gap', 500);
    return {
      epoch: meta.epoch,
      sequence: Number(meta.sequence),
      dropped: Number(meta.dropped),
      events,
    };
  }
  appendEvent(
    event: HubEvent,
    state: Omit<EventSnapshot, 'events'>,
    records: StoredReceipt[] = [],
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare(
        'INSERT INTO receipts(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      );
      for (const row of records) {
        validate(row);
        receipt.run(row.envelope.messageId, JSON.stringify(row));
      }
      this.db
        .prepare('INSERT INTO events(sequence,value) VALUES (?,?)')
        .run(state.sequence, JSON.stringify(event));
      this.db.prepare('DELETE FROM events WHERE sequence<=?').run(state.dropped);
      this.setMeta('events:state', state);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setMeta(key: string, value: Json) {
    this.db
      .prepare(
        'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.lock.close();
    }
  }
}

import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fingerprint, HubError, object, pageQuery, uuid } from '../validation.js';
import type { HistoryEntry, Json, PageQuery } from '../types.js';

export async function readClaudeHistory(root: string, sessionId: string, query: PageQuery = {}) {
  uuid(sessionId);
  const q = pageQuery(query);
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new HubError('history_not_found', 'Claude history directory not found', 404);
    throw error;
  }
  const paths: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const path = join(root, project.name, sessionId + '.jsonl');
    try {
      const info = await lstat(path);
      if (info.isFile() && info.uid === process.getuid?.()) paths.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (paths.length !== 1)
    throw new HubError(
      'history_not_found',
      paths.length ? 'Ambiguous Claude transcript' : 'Claude transcript not found',
      404,
    );
  const path = paths[0]!;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let stat;
  let transcript: string;
  try {
    stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.())
      throw new HubError(
        'unsafe_history',
        'Transcript must be a regular file owned by this user',
        403,
      );
    if (stat.size > 64 * 1024 * 1024)
      throw new HubError('history_too_large', 'Transcript exceeds the 64 MiB read limit', 413);
    const bytes = Buffer.alloc(stat.size);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== stat.size)
      throw new HubError(
        'history_changed',
        'Transcript was truncated while reading; restart pagination',
        409,
      );
    transcript = bytes.toString('utf8');
  } finally {
    await handle.close();
  }
  const binding = fingerprint([sessionId, q.search ?? '', stat.dev, stat.ino]);
  let offset = 0;
  if (q.cursor) {
    let c: Json;
    try {
      c = object(JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')));
    } catch {
      throw new HubError('invalid_cursor', 'Malformed Claude history cursor');
    }
    if (
      c.binding !== binding ||
      typeof c.size !== 'number' ||
      c.size > stat.size ||
      !Number.isSafeInteger(c.offset) ||
      Number(c.offset) < 0
    )
      throw new HubError(
        'invalid_cursor',
        'History changed or cursor belongs to another query',
        409,
      );
    offset = Number(c.offset);
  }
  const lines = transcript.split('\n');
  const entries: HistoryEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 2 * 1024 * 1024)
      throw new HubError('history_record_too_large', 'Transcript record exceeds 2 MiB', 413);
    let row: Json;
    try {
      row = object(JSON.parse(line));
    } catch {
      if (i === lines.length - 1) break;
      throw new HubError('corrupt_history', 'Malformed complete transcript record', 502);
    }
    const attachment =
      row.attachment && typeof row.attachment === 'object' ? object(row.attachment) : undefined;
    if (
      row.type !== 'user' &&
      row.type !== 'assistant' &&
      !(row.type === 'attachment' && attachment?.type === 'queued_command')
    )
      continue;
    if (typeof row.uuid !== 'string' || seen.has(row.uuid)) continue;
    seen.add(row.uuid);
    const msg = row.message && typeof row.message === 'object' ? object(row.message) : {};
    const origin = row.origin ?? attachment?.origin;
    const content = attachment?.prompt ?? msg.content;
    const body =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((x) =>
                typeof x === 'object' && x
                  ? String(object(x).text ?? object(x).content ?? JSON.stringify(x))
                  : String(x),
              )
              .join('\n')
          : '';
    if (q.search && !body.toLocaleLowerCase().includes(q.search.toLocaleLowerCase())) continue;
    entries.push({
      id: row.uuid,
      kind:
        attachment?.type === 'queued_command'
          ? 'peerMessage'
          : origin && object(origin).kind === 'peer'
            ? 'peerMessage'
            : String(row.type),
      text: body,
      ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}),
      ...(origin && typeof origin === 'object' ? { origin: object(origin) } : {}),
      native: row,
    });
  }
  const end = offset + (q.limit ?? 50);
  return {
    data: entries.slice(offset, end),
    nextCursor:
      end < entries.length
        ? Buffer.from(JSON.stringify({ binding, size: stat.size, offset: end })).toString(
            'base64url',
          )
        : null,
  };
}

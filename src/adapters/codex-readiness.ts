import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Json, ReplyReadiness } from '../types.js';

/** Local persisted session metadata is evidence of registration, not proof that
 * a model will invoke the tool. Missing/remote/changed metadata stays unknown. */
export async function replyToolState(thread: Json): Promise<ReplyReadiness['tool']> {
  if (typeof thread.path !== 'string') return 'unknown';
  let file;
  try {
    file = await open(thread.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.()) return 'unknown';
    const bytes = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, bytesRead).toString('utf8'),
      end = text.indexOf('\n');
    if (end < 0) return 'unknown';
    const row = JSON.parse(text.slice(0, end));
    if (row.type !== 'session_meta' || row.payload?.id !== thread.id) return 'unknown';
    if (row.payload.dynamic_tools == null) return 'missing';
    if (!Array.isArray(row.payload.dynamic_tools)) return 'unknown';
    const tool = row.payload.dynamic_tools.find(
      (x: Json) => x.type === 'function' && x.name === 'agenthub_reply',
    );
    if (!tool) return 'missing';
    const schema = tool.inputSchema;
    if (
      schema?.type !== 'object' ||
      schema.properties?.inReplyTo?.type !== 'string' ||
      schema.properties?.text?.type !== 'string' ||
      !schema.required?.includes('inReplyTo') ||
      !schema.required?.includes('text')
    )
      return 'unknown';
    return 'present';
  } catch {
    return 'unknown';
  } finally {
    await file?.close();
  }
}

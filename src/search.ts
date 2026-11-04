import type { Adapter, HistoryEntry, PageQuery, SessionAddress } from './types.js';
import { fingerprint, HubError, object, pageQuery, text } from './validation.js';
/** Literal, case-insensitive search of normalized history. A bounded scan can
 * return an empty page with a continuation. No hidden index or session resume. */
export async function searchHistory(
  adapter: Adapter,
  address: SessionAddress,
  query: PageQuery & { search: string },
  callerId: string,
) {
  const q = pageQuery(query),
    needle = text(q.search, 'search', 2000).toLocaleLowerCase();
  const binding = fingerprint([callerId, address, needle]);
  let cursor: string | undefined;
  if (q.cursor) {
    let parsed;
    try {
      parsed = object(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
    } catch {
      throw new HubError('invalid_cursor', 'Malformed search cursor');
    }
    if (parsed.binding !== binding || typeof parsed.native !== 'string')
      throw new HubError(
        'invalid_cursor',
        'Search cursor belongs to another caller, target or query',
      );
    cursor = parsed.native;
  }
  const data: HistoryEntry[] = [],
    seen = new Set<string>();
  let scanned = 0;
  for (let page = 0; page < 10; page++) {
    const result = await adapter.history(address, {
      limit: (q.limit ?? 50) - data.length,
      ...(cursor ? { cursor } : {}),
    });
    scanned += result.data.length;
    data.push(...result.data.filter((row) => row.text.toLocaleLowerCase().includes(needle)));
    cursor = result.nextCursor ?? undefined;
    if (!cursor || data.length >= (q.limit ?? 50)) break;
    if (seen.has(cursor)) throw new HubError('backend_protocol', 'Repeated history cursor', 502);
    seen.add(cursor);
  }
  return {
    data,
    nextCursor: cursor
      ? Buffer.from(JSON.stringify({ binding, native: cursor })).toString('base64url')
      : null,
    scanned,
    semantics: 'literal_case_insensitive' as const,
  };
}

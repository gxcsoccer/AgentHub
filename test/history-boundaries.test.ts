import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  symlink,
  truncate,
  appendFile,
  rename,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readClaudeHistory } from '../src/adapters/claude-history.js';
async function fixture(t: test.TestContext) {
  const root = await mkdtemp('/tmp/hh-history-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID();
  await mkdir(join(root, 'a'));
  const path = join(root, 'a', id + '.jsonl');
  return { root, id, path };
}
const row = (id: string, text: string) =>
  JSON.stringify({
    uuid: id,
    type: 'assistant',
    timestamp: '2026-11-04',
    message: { content: [{ type: 'text', text }] },
  }) + '\n';

test('history rejects missing, ambiguous and symlink transcripts without following them', async (t) => {
  const { root, id, path } = await fixture(t);
  await assert.rejects(readClaudeHistory(root + '/missing', id), /directory not found/);
  await assert.rejects(readClaudeHistory(root, id), /not found/);
  const outside = join(root, 'private');
  await writeFile(outside, row('1', 'secret'));
  await symlink(outside, path);
  await assert.rejects(readClaudeHistory(root, id), /not found/);
  await rm(path);
  await writeFile(path, row('1', 'text'));
  await mkdir(join(root, 'b'));
  await writeFile(join(root, 'b', id + '.jsonl'), row('2', 'other'));
  await assert.rejects(readClaudeHistory(root, id), /Ambiguous/);
});

test('history bounds files and records and distinguishes partial tails from corrupt complete rows', async (t) => {
  const { root, id, path } = await fixture(t);
  await writeFile(path, row('1', 'valid') + '{broken');
  assert.equal((await readClaudeHistory(root, id)).data.length, 1);
  await appendFile(path, '\n');
  await assert.rejects(readClaudeHistory(root, id), /Malformed complete/);
  await writeFile(path, row('1', 'x'.repeat(2 * 1024 * 1024)));
  await assert.rejects(readClaudeHistory(root, id), /record exceeds/);
  await truncate(path, 64 * 1024 * 1024 + 1);
  await assert.rejects(readClaudeHistory(root, id), /64 MiB/);
});

test('history search cursors bind query and file identity, survive appends and reject truncation', async (t) => {
  const { root, id, path } = await fixture(t);
  await writeFile(path, row('1', 'Match one') + row('2', 'match two') + row('3', 'different'));
  const first = await readClaudeHistory(root, id, { search: 'match', limit: 1 });
  assert.equal(first.data[0]?.text, 'Match one');
  assert(first.nextCursor);
  await assert.rejects(readClaudeHistory(root, id, { cursor: 'garbage' }), /Malformed/);
  await assert.rejects(
    readClaudeHistory(root, id, { cursor: first.nextCursor, search: 'different' }),
    /another query/,
  );
  await appendFile(path, row('4', 'match appended'));
  const rest = await readClaudeHistory(root, id, { cursor: first.nextCursor, search: 'match' });
  assert.deepEqual(
    rest.data.map((x) => x.id),
    ['2', '4'],
  );
  await truncate(path, 0);
  await assert.rejects(
    readClaudeHistory(root, id, { cursor: first.nextCursor, search: 'match' }),
    /History changed/,
  );
  await writeFile(path, row('1', 'Match one') + row('2', 'match two') + row('3', 'different'));
  await rename(path, path + '.old');
  await writeFile(path, row('1', 'Match one') + row('2', 'match two') + row('3', 'different'));
  await assert.rejects(
    readClaudeHistory(root, id, { cursor: first.nextCursor, search: 'match' }),
    /History changed/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessHub } from '../src/hub.js';
import { TestAdapter, testAddress } from './helpers.js';
test('full-text cursor binds caller, target and query, with bounded empty pages', async (t) => {
  const a = new TestAdapter();
  let reads = 0;
  a.history = async (_address, q = {}) => {
    reads++;
    const offset = Number(q.cursor ?? 0);
    return {
      data: [
        {
          id: String(offset),
          kind: 'message',
          text: offset < 12 ? 'nothing' : 'NEEDLE',
          native: {},
        },
      ],
      nextCursor: offset < 15 ? String(offset + 1) : null,
    };
  };
  const hub = new HarnessHub([a], {
    callers: [
      { id: 'a', grants: [{ ...testAddress, operations: ['read'] }] },
      { id: 'b', grants: [{ ...testAddress, operations: ['read'] }] },
    ],
  });
  t.after(() => hub.close());
  const first = await hub.search(testAddress, { search: 'needle', limit: 1 }, 'a');
  assert.equal(first.data.length, 0);
  assert.equal(reads, 10);
  assert(first.nextCursor);
  for (const [address, query, caller] of [
    [testAddress, 'other', 'a'],
    [{ ...testAddress, sessionId: 'other' }, 'needle', 'a'],
    [testAddress, 'needle', 'b'],
  ] as const)
    await assert.rejects(
      hub.search(address, { search: query, cursor: first.nextCursor }, caller),
      /another caller/,
    );
  const next = await hub.search(
    testAddress,
    { search: 'needle', limit: 1, cursor: first.nextCursor },
    'a',
  );
  assert.equal(next.data[0]?.id, '12');
  await assert.rejects(
    hub.search(testAddress, { search: 'needle', cursor: 'broken' }, 'a'),
    /Malformed/,
  );
  a.history = async () => ({ data: [], nextCursor: 'same' });
  await assert.rejects(hub.search(testAddress, { search: 'needle' }, 'a'), /Repeated/);
});

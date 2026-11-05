import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessInspector } from '../src/connectors/process.js';

test('native process inspection validates PID and uses precise macOS start identity', async () => {
  const calls: string[][] = [];
  const inspect = createProcessInspector({
    platform: 'darwin',
    execute: async (_cmd, args) => {
      calls.push(args);
      return JSON.stringify([{ pid: 44, ppid: 20, uid: 501, start_sec: 12, start_usec: 34 }]);
    },
  });
  assert.deepEqual(await inspect(44), { pid: 44, ppid: 20, uid: 501, start: 'darwin:12:34' });
  assert.equal(calls[0]![0], '-I');
  assert.equal(calls[0]!.at(-1), '44');
  for (const value of [0, -1, 0.5, NaN, 2147483648]) await assert.rejects(inspect(value), /PID/);
  assert.equal(calls.length, 1);
});
test('native inspector rejects malformed, unavailable and mismatched macOS processes', async () => {
  for (const output of [
    'bad',
    '[]',
    '[{"error":"not_available"}]',
    '[{"pid":8,"ppid":2,"uid":1,"start_sec":1,"start_usec":0}]',
    '[{"pid":44,"ppid":2,"uid":1,"start_sec":1,"start_usec":1000000}]',
  ]) {
    const inspect = createProcessInspector({ platform: 'darwin', execute: async () => output });
    await assert.rejects(inspect(44), /process identity/);
  }
  await assert.rejects(
    createProcessInspector({
      platform: 'darwin',
      execute: async () => {
        throw Error('missing python');
      },
    })(44),
    /process identity/,
  );
  await assert.rejects(createProcessInspector({ platform: 'win32' })(44), /platform/);
});
test('Linux identity includes boot id, start ticks and effective UID; command names can contain parentheses', async () => {
  const fields = ['S', '20', ...Array(17).fill('0'), '98765'];
  const inspect = createProcessInspector({
    platform: 'linux',
    read: async (path) => {
      if (path.endsWith('/stat')) return `44 (worker (name)) ${fields.join(' ')}`;
      if (path.endsWith('/status')) return 'Name:\tworker\nUid:\t7\t8\t8\t8\n';
      return 'boot-id\n';
    },
  });
  assert.deepEqual(await inspect(44), { pid: 44, ppid: 20, uid: 8, start: 'linux:boot-id:98765' });
  await assert.rejects(
    createProcessInspector({ platform: 'linux', read: async () => '' })(44),
    /process identity/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Json, Page, SessionInfo } from '../src/types.js';

const exec = promisify(execFile);
const cli = new URL('../src/cli.js', import.meta.url).pathname;
async function fixture(t: test.TestContext) {
  const root = await mkdtemp('/tmp/ah-targets-');
  const home = join(root, 'home');
  await mkdir(home);
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => {
    try {
      await Promise.all(cleanups.map((close) => close()));
    } finally {
      try {
        assert.deepEqual(
          await readdir(home),
          [],
          'Discovery must not create home configuration or state',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const env = {
    ...process.env,
    HOME: home,
    PATH: root, // Never resolve a real Claude binary.
    CODEX_HOME: join(home, 'codex'),
    CODEX_BRIDGE_SOCKET: join(root, 'codex.sock'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    AGENTHUB_TOKEN_FILE: join(root, 'MUST_NOT_READ_OWNER'),
    AGENTHUB_STATE_FILE: join(home, 'MUST_NOT_WRITE_STATE'),
  };
  const run = async (...args: string[]) => {
    try {
      return {
        ...(await exec(process.execPath, [cli, 'setup', 'targets', ...args], {
          env,
          timeout: 8000,
        })),
        code: 0,
      };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string; killed: boolean };
      if (typeof e.code !== 'number' || e.killed) throw error;
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };
  const page = async (harness: string, cursor?: string): Promise<Page<SessionInfo>> => {
    const result = await run('--harness', harness, ...(cursor ? ['--cursor', cursor] : []));
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, env, run, page, cleanups };
}
async function claudeFixture(t: test.TestContext, rows: unknown) {
  const f = await fixture(t);
  await writeFile(
    join(f.root, 'rows.json'),
    JSON.stringify(
      Array.isArray(rows)
        ? rows.map((row) => ({ ...row, socketPath: join(f.root, 'missing-inbox') }))
        : rows,
    ),
  );
  await writeFile(join(f.root, 'calls.jsonl'), '');
  await writeFile(
    join(f.root, 'claude'),
    `#!${process.execPath}
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(f.root, 'calls.jsonl'))}, JSON.stringify(args) + '\\n');
if (JSON.stringify(args) === '["agents","--json"]') process.stdout.write(readFileSync(${JSON.stringify(join(f.root, 'rows.json'))}));
else if (JSON.stringify(args) === '["--version"]') console.log('2.1.318 (fixture)');
else process.exit(99);
`,
    { mode: 0o700 },
  );
  const calls = async () =>
    (await readFile(join(f.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { ...f, calls };
}
async function codexFixture(
  t: test.TestContext,
  handler: (method: string, params: Json) => unknown,
) {
  const f = await fixture(t);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const calls: { method: string; params: Json }[] = [];
  const closed: Promise<unknown>[] = [];
  wss.on('connection', (ws) => {
    closed.push(once(ws, 'close'));
    ws.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      calls.push({ method: message.method, params: message.params ?? {} });
      if (message.id === undefined) return;
      try {
        const result =
          message.method === 'initialize' ? {} : handler(message.method, message.params ?? {});
        ws.send(JSON.stringify({ id: message.id, result }));
      } catch (error) {
        ws.send(
          JSON.stringify({ id: message.id, error: { code: -32000, message: String(error) } }),
        );
      }
    });
  });
  server.listen(f.env.CODEX_BRIDGE_SOCKET);
  await once(server, 'listening');
  f.cleanups.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { ...f, calls, closed };
}
function failure(result: { code: number; stdout: string; stderr: string }, code?: string) {
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim().split('\n').at(-1)!).error;
  if (code) assert.equal(error.code, code);
  assert.equal(typeof error.message, 'string');
}

test('setup targets discovers and paginates Claude sessions through the real CLI without mutations', async (t) => {
  const rows = Array.from({ length: 101 }, (_, n) => ({
    sessionId: randomUUID(),
    pid: process.pid,
    name: `peer-${n}`,
    status: n % 2 ? 'busy' : 'idle',
  }));
  const f = await claudeFixture(t, rows);
  const first = await f.page('claude');
  assert.equal(first.data.length, 100);
  assert(first.nextCursor);
  const second = await f.page('claude', first.nextCursor);
  assert.equal(second.data.length, 1);
  assert.equal(second.nextCursor, null);
  const expected = rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  assert.deepEqual(
    [...first.data, ...second.data].map((s) => ({
      sessionId: s.address.sessionId,
      name: s.name,
      status: s.status,
    })),
    expected.map(({ sessionId, name, status }) => ({ sessionId, name, status })),
  );
  assert(
    first.data.every(
      (s) =>
        s.address.harness === 'claude' &&
        s.address.instance === 'local' &&
        s.capabilities.send.length === 0,
    ),
  );
  assert.deepEqual(await f.calls(), [
    ['agents', '--json'],
    ['--version'],
    ['agents', '--json'],
    ['--version'],
  ]);
});

test('setup targets preserves empty Claude discovery and rejects malformed responses and cursors', async (t) => {
  const f = await claudeFixture(t, []);
  assert.deepEqual(await f.page('claude'), { data: [], nextCursor: null });
  failure(await f.run('--harness', 'claude', '--cursor', 'invalid'), 'invalid_cursor');
  await writeFile(join(f.root, 'rows.json'), JSON.stringify({ data: [] }));
  failure(await f.run('--harness', 'claude'), 'backend_protocol');
  await writeFile(join(f.root, 'rows.json'), 'not JSON');
  failure(await f.run('--harness', 'claude'));
  assert((await f.calls()).every((args) => JSON.stringify(args) === '["agents","--json"]'));
});

test('setup targets uses Codex loaded pages and forwards cursors without listing history or writing', async (t) => {
  const ids = [randomUUID(), randomUUID()];
  const f = await codexFixture(t, (method, params) => {
    if (method === 'thread/loaded/list')
      return params.cursor
        ? { data: [ids[1]], nextCursor: null }
        : { data: [ids[0]], nextCursor: 'next-loaded-page' };
    if (method === 'thread/read')
      return {
        thread: {
          id: params.threadId,
          name: 'loaded peer',
          status: { type: 'idle' },
          canAcceptDirectInput: true,
        },
      };
    throw Error('Unexpected RPC: ' + method);
  });
  const first = await f.page('codex');
  assert.equal(first.nextCursor, 'next-loaded-page');
  const second = await f.page('codex', first.nextCursor!);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    [...first.data, ...second.data].map((s) => s.address),
    ids.map((sessionId) => ({ harness: 'codex', instance: 'local', sessionId })),
  );
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'thread/loaded/list').map((c) => c.params),
    [{ limit: 100 }, { limit: 100, cursor: 'next-loaded-page' }],
  );
  assert.deepEqual(
    f.calls.filter((c) => c.method === 'thread/read').map((c) => c.params),
    ids.map((threadId) => ({ threadId, includeTurns: false })),
  );
  assert(
    f.calls.every((c) =>
      ['initialize', 'initialized', 'thread/loaded/list', 'thread/read'].includes(c.method),
    ),
  );
  await Promise.all(f.closed);
});

test('setup targets preserves empty Codex discovery and reports malformed pages and rejected cursors', async (t) => {
  let mode = 'empty';
  const f = await codexFixture(t, (method, params) => {
    assert.equal(method, 'thread/loaded/list');
    if (params.cursor) throw Error('Invalid cursor');
    return { data: mode === 'empty' ? [] : 'bad page', nextCursor: null };
  });
  assert.deepEqual(await f.page('codex'), { data: [], nextCursor: null });
  mode = 'malformed';
  failure(await f.run('--harness', 'codex'), 'backend_protocol');
  failure(await f.run('--harness', 'codex', '--cursor', 'invalid'));
  assert(
    f.calls.every((c) => ['initialize', 'initialized', 'thread/loaded/list'].includes(c.method)),
  );
  await Promise.all(f.closed);
});

test('setup targets rejects invalid harnesses and unavailable isolated backends with an error exit', async (t) => {
  const f = await fixture(t);
  failure(await f.run(), 'invalid_input');
  failure(await f.run('--harness', 'other'), 'command_failed');
  failure(await f.run('--harness', 'claude'), 'ENOENT');
  failure(await f.run('--harness', 'codex'), 'backend_unavailable');
});

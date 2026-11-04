import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { httpFixture, TestAdapter, testAddress, testToken } from './helpers.js';
import { HarnessHubClient } from '../src/client.js';

const cli = new URL('../src/cli.js', import.meta.url).pathname;
const exec = promisify(execFile);
async function nextLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('CLI output timed out'));
    }, 10000);
    const got = (chunk: Buffer) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        cleanup();
        resolve(data.split('\n')[0]!);
      }
    };
    const exit = () => {
      cleanup();
      reject(new Error('CLI exited before output: ' + data));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', got);
      child.off('exit', exit);
    };
    child.stdout?.on('data', got);
    child.once('exit', exit);
  });
}
async function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
}

test('JSON CLI exercises every client command against HTTP and preserves explicit inputs', async (t) => {
  const adapter = new TestAdapter();
  const { baseUrl, hub } = await httpFixture(t, adapter);
  const dir = await mkdtemp('/tmp/hh-cli-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenPath = join(dir, 'token');
  await writeFile(tokenPath, testToken, { mode: 0o600 });
  const env = { ...process.env };
  delete env.HARNESSHUB_TOKEN;
  const run = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(process.execPath, [cli, ...args, '--url', baseUrl, '--token-file', tokenPath], {
          env,
        })
      ).stdout,
    );
  assert.equal((await run('instances')).data.length, 1);
  assert.equal(
    (
      await run(
        'sessions',
        '--harness',
        'test',
        '--limit',
        '1',
        '--search',
        'a & b',
        '--cursor',
        'cursor',
      )
    ).data.length,
    1,
  );
  assert.deepEqual(adapter.queries.at(-1), { limit: 1, search: 'a & b', cursor: 'cursor' });
  assert.deepEqual(
    (await run('session', '--harness', 'test', '--session-id', testAddress.sessionId)).address,
    testAddress,
  );
  assert.equal(
    (await run('history', '--harness', 'test', '--session-id', testAddress.sessionId)).data[0].id,
    'h1',
  );
  const message = {
    messageId: randomUUID(),
    to: testAddress,
    origin: { name: 'cli' },
    delivery: 'peer_message',
    text: 'hello',
  };
  const file = join(dir, 'message.json');
  await writeFile(file, JSON.stringify(message));
  assert.equal((await run('send', '--message-file', file)).status, 'accepted');
  assert.equal(
    (await run('status', '--message-id', message.messageId, '--wait-ms', '1')).messageId,
    message.messageId,
  );
  const cursor = hub.events.cursor;
  hub.events.publish('test', { marker: 'CLI_EVENT' });
  const events = spawn(
    process.execPath,
    [cli, 'events', '--url', baseUrl, '--token-file', tokenPath, '--after', cursor],
    { env },
  );
  t.after(() => stop(events));
  assert.equal(JSON.parse(await nextLine(events)).data.data.marker, 'CLI_EVENT');
  await stop(events);
  assert.match((await exec(process.execPath, [cli, '--help'])).stdout, /HarnessHub/);
  await assert.rejects(run('invalid'), (e: unknown) =>
    String((e as { stderr?: string }).stderr).includes('Unknown command'),
  );
  await writeFile(file, 'broken');
  await assert.rejects(run('send', '--message-file', file));
  assert.equal(adapter.calls.length, 1);
});

test('serve CLI creates a private reusable token and shuts down gracefully with an open SSE client', async (t) => {
  const dir = await mkdtemp('/tmp/hh-daemon-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json'),
    tokenFile = join(dir, 'token');
  await writeFile(config, JSON.stringify({ codex: false, claude: false }));
  const env = { ...process.env };
  delete env.HARNESSHUB_TOKEN;
  const child = spawn(
    process.execPath,
    [cli, 'serve', '--config', config, '--port', '0', '--token-file', tokenFile],
    { env },
  );
  t.after(() => stop(child));
  const ready = JSON.parse(await nextLine(child));
  const token = (await readFile(tokenFile, 'utf8')).trim();
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert(!JSON.stringify(ready).includes(token));
  const api = new HarnessHubClient({ baseUrl: ready.url, token });
  assert.deepEqual((await api.instances()).data, []);
  const events = api.events();
  assert.equal((await events.next()).value?.event, 'ready');
  await stop(child);
  assert.equal(child.exitCode, 0);
  await events.return(undefined);
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), token);
});

test('official MCP client calls all seven tools over a real stdio child and HTTP boundary', async (t) => {
  const adapter = new TestAdapter();
  const { baseUrl, hub } = await httpFixture(t, adapter);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, 'mcp', '--url', baseUrl, '--origin-name', 'stdio-test'],
    env: { HARNESSHUB_TOKEN: testToken },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'harnesshub-stdio-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return (result.structuredContent as { result: Record<string, unknown> }).result;
  };
  assert.equal((await client.listTools()).tools.length, 7);
  assert.equal(((await call('list_instances')).data as unknown[]).length, 1);
  assert.equal(
    (
      (await call('list_sessions', { harness: 'test', search: 'find', limit: 1, cursor: 'next' }))
        .data as unknown[]
    ).length,
    1,
  );
  assert.deepEqual((await call('get_session', testAddress)).address, testAddress);
  assert.equal(
    ((await call('get_history', { ...testAddress, search: 'body' })).data as unknown[]).length,
    1,
  );
  await call('search_history', { ...testAddress, search: 'body' });
  const id = randomUUID();
  await call('send_message', {
    messageId: id,
    to: testAddress,
    delivery: 'peer_message',
    text: 'hello',
    origin: { name: 'spoof' },
  });
  assert.equal(adapter.calls[0]?.origin.name, 'stdio-test');
  adapter.emit('update', { messageId: id, status: 'replied', reply: { text: 'stdio answer' } });
  assert.equal(
    (await call('get_message_status', { messageId: id, waitMs: 100 })).status,
    'replied',
  );
  const missing = await client.callTool({
    name: 'get_session',
    arguments: { ...testAddress, harness: 'missing' },
  });
  assert.equal(missing.isError, true);
  const invalid = await client.callTool({
    name: 'send_message',
    arguments: { messageId: randomUUID(), to: testAddress, delivery: 'user_input', text: 'wrong' },
  });
  assert.equal(invalid.isError, true);
  assert.equal(adapter.calls.length, 1);
  assert.equal(hub.receipt(id).reply?.text, 'stdio answer');
  await client.close();
});

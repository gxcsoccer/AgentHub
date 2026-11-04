import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

test(
  'CLI connects to an existing socket, authenticates HTTP and shuts down without stopping Codex',
  { timeout: 8000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'cb-cli-'));
    const socket = join(directory, 's.sock');
    const http = createServer();
    const upstream = new WebSocketServer({ server: http });
    upstream.on('connection', (ws) =>
      ws.on('message', (bytes) => {
        const message = JSON.parse(bytes.toString());
        if (message.method === 'initialize')
          ws.send(JSON.stringify({ id: message.id, result: {} }));
      }),
    );
    http.listen(socket);
    await once(http, 'listening');
    const token = 'cli-test-token-that-must-never-appear-in-logs';
    const child = spawn(
      process.execPath,
      [new URL('../src/cli.js', import.meta.url).pathname, '--socket', socket, '--port', '0'],
      { env: { ...process.env, CODEX_BRIDGE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (data) => {
      output += data;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      for (const ws of upstream.clients) ws.terminate();
      upstream.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`CLI exited early (${code}): ${output}`)));
      child.stdout.on('data', (data) => {
        output += data;
        if (output.includes('Codex connected.')) resolve();
      });
    });
    const base = /Bridge: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    assert.ok(base);
    const capabilities = await (
      await fetch(base + '/v1/capabilities', { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    assert.equal(capabilities.connected, true);
    assert.equal(output.includes(token), false);
    child.kill('SIGTERM');
    assert.equal((await exited)[0], 0);
    assert.equal(http.listening, true);
  },
);

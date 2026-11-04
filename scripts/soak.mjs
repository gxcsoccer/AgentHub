import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  HarnessHub,
  HarnessHubClient,
  createHubServer,
  openReceiptStore,
} from '../dist/src/index.js';
const duration = Number(process.argv[process.argv.indexOf('--seconds') + 1] || 30);
assert(duration >= 5 && duration <= 3600);
const dir = await mkdtemp(join(tmpdir(), 'hh-soak-'));
const target = { harness: 'test', instance: 'isolated', sessionId: 'owned' },
  token = randomUUID() + randomUUID();
let nativeCalls = 0,
  app,
  hub,
  client,
  restarts = 0,
  sent = 0,
  last,
  duplicateChecks = 0;
class TestAdapter extends EventEmitter {
  harness = 'test';
  instance = 'isolated';
  async listSessions() {
    return { data: [await this.getSession()], nextCursor: null };
  }
  async getSession() {
    return {
      address: target,
      status: 'idle',
      capabilities: { send: ['peer_message'], history: false, liveEvents: false },
    };
  }
  async history() {
    return { data: [], nextCursor: null };
  }
  async send(m) {
    nativeCalls++;
    this.emit('update', { messageId: m.messageId, status: 'replied', reply: { text: m.text } });
    return { status: 'accepted' };
  }
  async close() {}
}
async function open() {
  hub = new HarnessHub([new TestAdapter()], {
    store: await openReceiptStore(join(dir, 'state.sqlite')),
    receiptCapacity: 512,
    receiptTtlMs: 10000,
  });
  app = createHubServer({ hub, token });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  client = new HarnessHubClient({
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    token,
  });
}
async function fdCount() {
  if (process.platform === 'linux') return (await readdir('/proc/self/fd')).length;
  if (process.platform === 'darwin')
    return (
      await promisify(execFile)('/usr/sbin/lsof', ['-p', String(process.pid), '-Ff'], {
        timeout: 5000,
      })
    ).stdout
      .split('\n')
      .filter((line) => /^f\d/.test(line)).length;
  return null;
}
const samples = [],
  report = {
    scope:
      'Synthetic owned adapter with real HTTP/SSE/SQLite. No model workload, no working sessions.',
    seconds: duration,
    passed: false,
  };
try {
  await open();
  const start = Date.now();
  let nextRestart = start + 5000,
    warm;
  while (Date.now() - start < duration * 1000) {
    const batch = Array.from({ length: 8 }, () => ({
      messageId: randomUUID(),
      to: target,
      delivery: 'peer_message',
      origin: { name: 'soak' },
      text: 'x'.repeat(1024),
    }));
    const receipts = await Promise.all(batch.map((m) => client.send(m)));
    assert(receipts.every((r) => r.status === 'replied'));
    sent += batch.length;
    last = batch.at(-1);
    const before = nativeCalls;
    await client.send(last);
    assert.equal(nativeCalls, before);
    duplicateChecks++;
    // Open/read/close concurrent consumers every batch, exercising listener cleanup.
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const s = client.events();
        assert.equal((await s.next()).value.event, 'ready');
        await s.return();
      }),
    );
    if (Date.now() >= nextRestart) {
      const cursor = hub.events.cursor;
      await app.close();
      await open();
      restarts++;
      assert.equal(hub.events.cursor, cursor);
      const calls = nativeCalls;
      await client.send(last);
      assert.equal(nativeCalls, calls);
      duplicateChecks++;
      global.gc?.();
      samples.push({
        elapsedMs: Date.now() - start,
        ...process.memoryUsage(),
        activeResources: process.getActiveResourcesInfo().length,
        fileDescriptors: await fdCount(),
      });
      warm ??= samples[0];
      nextRestart = Date.now() + 5000;
    }
    // Fixed bounded arrival rate keeps the 10-second receipt TTL below capacity.
    await new Promise((r) => setTimeout(r, 250));
  }
  global.gc?.();
  const end = process.memoryUsage();
  if (samples.length >= 2) {
    assert(end.heapUsed - samples[0].heapUsed < 64 * 1024 * 1024);
    assert(end.rss - samples[0].rss < 128 * 1024 * 1024);
    assert(samples.at(-1).activeResources <= samples[0].activeResources + 16);
    if (samples[0].fileDescriptors !== null)
      assert(samples.at(-1).fileDescriptors <= samples[0].fileDescriptors + 8);
  }
  assert.equal(sent, nativeCalls);
  assert(hub.events.replay(hub.events.cursor).length === 0);
  Object.assign(report, {
    passed: true,
    sent,
    nativeCalls,
    duplicateChecks,
    restarts,
    samples,
    end,
    thresholds: { heapGrowthMiB: 64, rssGrowthMiB: 128, activeResourceGrowth: 16 },
  });
} finally {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
  await mkdir(resolve('.local/verification'), { recursive: true, mode: 0o700 });
  await writeFile(resolve('.local/verification/soak.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report));
}

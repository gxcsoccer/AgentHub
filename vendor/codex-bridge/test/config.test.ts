import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToken, localPort } from '../src/config.js';

test('token creation is private, reusable and safe under concurrent startup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token');
  const [a, b] = await Promise.all([loadToken(path), loadToken(path)]);
  assert.equal(a, b);
  assert.ok(a.length >= 32);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await loadToken(path), a);
});

test('invalid token files and insecure overrides fail instead of silently rotating credentials', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token');
  await writeFile(path, 'short', { mode: 0o600 });
  await assert.rejects(loadToken(path), /32/);
  await assert.rejects(loadToken(path, 'short'), /32/);
  assert.equal(await loadToken(path, 'x'.repeat(32)), 'x'.repeat(32));
});

test('port validation rejects invalid values and accepts ephemeral binding for tests', () => {
  assert.equal(localPort('0'), 0);
  assert.equal(localPort('3210'), 3210);
  for (const value of ['-1', '1.5', '65536', 'NaN', ''])
    assert.throws(() => localPort(value), /port/);
});

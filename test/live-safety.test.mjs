import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cleanEnv, SESSION_ENV_KEYS, exec, stopOwned } from '../scripts/live-processes.mjs';

async function wrapperArgs(t, args) {
  const dir = await mkdtemp(join(tmpdir(), 'ah-wrapper-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, 'fixture.mjs');
  await writeFile(
    command,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o700 },
  );
  return JSON.parse(
    (
      await exec(process.execPath, [resolve('scripts/live-claude-executable.mjs'), ...args], {
        env: { ...process.env, AGENTHUB_TEST_CLAUDE: command },
        timeout: 5000,
      })
    ).stdout,
  );
}
function assertRestricted(args) {
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('--tools'), '');
  assert.equal(value('--allowedTools'), '');
  assert.equal(value('--permission-mode'), 'dontAsk');
  assert.deepEqual(JSON.parse(value('--settings')), {
    disableAllHooks: true,
    crossSessionInbound: 'refuse',
  });
  assert.equal(value('--mcp-config'), '{"mcpServers":{}}');
  assert(args.includes('--strict-mcp-config'));
  assert(!args.some((a) => /LEAK|Bash|Write|Read|bypassPermissions/.test(a)));
}
test('session environment overrides remain cleared after parent environment merging', () => {
  const parent = {
    KEEP: 'preserved',
    ...Object.fromEntries(SESSION_ENV_KEYS.map((key) => [key, 'parent-session'])),
  };
  const merged = { ...parent, ...cleanEnv(parent) };
  assert.equal(merged.KEEP, 'preserved');
  for (const key of SESSION_ENV_KEYS) assert.equal(merged[key], '');
});
test('Claude wrapper handles equals forms, repeated options and variadic values', async (t) => {
  const args = await wrapperArgs(t, [
    '--output-format',
    'stream-json',
    '--settings=LEAK',
    '--allowedTools=Bash',
    'Write',
    '--mcp-config',
    'LEAK',
    'LEAK',
    '--tools',
    'Bash',
    'Read',
    '--permission-mode=bypassPermissions',
    '--settings',
    'LEAK',
    '--permission-prompt-tool',
    'stdio',
  ]);
  assertRestricted(args);
  assert.equal(args[args.indexOf('--permission-prompt-tool') + 1], 'stdio');
});
test('equals output-format still activates Claude restrictions; auth probes remain unchanged', async (t) => {
  assertRestricted(
    await wrapperArgs(t, [
      '--output-format=stream-json',
      '--allowed-tools',
      'Bash',
      'Write',
      '-p',
      'probe',
    ]),
  );
  assert.deepEqual(await wrapperArgs(t, ['auth', 'status', '--json']), [
    'auth',
    'status',
    '--json',
  ]);
});
test('Claude wrapper rejects a positional separator that would turn appended controls into prompt text', async (t) => {
  await assert.rejects(
    wrapperArgs(t, ['--output-format', 'stream-json', '--', 'prompt']),
    /separator/,
  );
});
test('an exited leader is never used as authority to signal a recycled group', async (t) => {
  const signals = [];
  t.mock.method(process, 'kill', (...args) => {
    signals.push(args);
    return true;
  });
  await stopOwned({ pid: 123456789, exitCode: 0, signalCode: null });
  assert.deepEqual(signals, []);
});
async function childFixture(t, ignoreTerm) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}setInterval(() => {}, 1000); process.stdout.write('ready');`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await once(child.stdout, 'data');
  return child;
}
test('graceful owned process exit does not escalate to a group SIGKILL', async (t) => {
  const child = await childFixture(t, false),
    signals = [],
    kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push(signal);
    return kill(pid, signal);
  });
  await stopOwned(child, 1000);
  assert.deepEqual(signals, ['SIGTERM']);
  await stopOwned(child, 1000);
  assert.deepEqual(signals, ['SIGTERM']);
});
test('a still-owned live leader is force-stopped only after the grace period', async (t) => {
  const child = await childFixture(t, true),
    signals = [],
    kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push(signal);
    return kill(pid, signal);
  });
  await stopOwned(child, 100);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.signalCode, 'SIGKILL');
});

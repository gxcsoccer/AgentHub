import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import * as live from '../scripts/live-processes.mjs';
const { cleanEnv, SESSION_ENV_KEYS, exec, stopOwned } = live;

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
  const merged = { ...parent, ...cleanEnv(parent, { blank: true }) };
  assert.equal(merged.KEEP, 'preserved');
  for (const key of SESSION_ENV_KEYS) assert.equal(merged[key], '');
});
test('directly spawned children receive absent session variables, not empty values', async () => {
  const parent = {
    KEEP: 'preserved',
    ...Object.fromEntries(SESSION_ENV_KEYS.map((key) => [key, 'parent-session'])),
  };
  const result = await exec(
    process.execPath,
    [
      '-e',
      `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(SESSION_ENV_KEYS)}.map(k => [k, Object.hasOwn(process.env, k)]))))`,
    ],
    { env: cleanEnv(parent) },
  );
  assert.deepEqual(
    JSON.parse(result.stdout),
    Object.fromEntries(SESSION_ENV_KEYS.map((k) => [k, false])),
  );
  assert.equal(parent.CODEX_THREAD_ID, 'parent-session');
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
  await assert.rejects(
    stopOwned({ pid: 123456789, exitCode: null, signalCode: null }),
    /without an owned supervisor/,
  );
  assert.deepEqual(signals, []);
});
async function childFixture(t, code) {
  const child = live.spawnOwned(process.execPath, ['-e', code]);
  t.after(() =>
    stopOwned(child, 50).catch((e) => {
      if (!child.expectedSupervisorLoss) throw e;
    }),
  );
  await once(child.stdout, 'data');
  return child;
}
test('graceful command exit keeps the owned group reserved until explicit cleanup', async (t) => {
  const child = await childFixture(t, "process.stdout.write('ready');"),
    result = await child.completion;
  assert.equal(result.code, 0);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  await stopOwned(child, 50);
  assert.notEqual(child.signalCode, null);
  const signals = [];
  t.mock.method(process, 'kill', (...args) => {
    signals.push(args);
    return true;
  });
  await stopOwned(child, 50);
  assert.deepEqual(signals, []);
});
test('a still-owned live group is force-stopped only after the grace period', async (t) => {
  const child = await childFixture(
      t,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');",
    ),
    signals = [],
    kill = process.kill.bind(process);
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push(signal);
    return kill(pid, signal);
  });
  const started = Date.now();
  await stopOwned(child, 100);
  assert(Date.now() - started >= 100);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.signalCode, 'SIGKILL');
});
test('command exit before its SIGTERM-resistant descendant does not leave the descendant running', async (t) => {
  // The descendant owns stdout until it exits. Its ten-second self-exit bounds a broken cleanup.
  const descendant =
    "process.on('SIGTERM',()=>{}); process.on('SIGHUP',()=>{}); process.stdout.write('ready'); setTimeout(()=>process.exit(0),10000);";
  const child = await childFixture(
    t,
    `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','ignore']}); c.unref();`,
  );
  assert.equal((await child.completion).code, 0);
  const outputClosed = once(child.stdout, 'close');
  await stopOwned(child, 100);
  // An open pipe would mean the descendant survived the supervisor's group shutdown.
  await Promise.race([
    outputClosed,
    delay(1500).then(() => {
      throw Error('descendant survived cleanup');
    }),
  ]);
});
test('loss of the supervisor fails cleanup without signalling a possibly recycled group', async (t) => {
  const child = await childFixture(t, "process.stdout.write('ready');");
  await child.completion;
  child.expectedSupervisorLoss = true;
  child.kill('SIGKILL');
  await once(child, 'exit');
  const signals = [];
  t.mock.method(process, 'kill', (...args) => {
    signals.push(args);
    return true;
  });
  await assert.rejects(stopOwned(child, 50), /supervisor/i);
  assert.deepEqual(signals, []);
});
test('controller IPC loss terminates the anchored group without leaving its command', async (t) => {
  const child = await childFixture(t, "setInterval(()=>{},1000); process.stdout.write('ready');");
  child.expectedSupervisorLoss = true;
  const exited = once(child, 'exit');
  child.disconnect();
  await exited;
  await live.until(
    () => child.stdout.destroyed && child.stderr.destroyed,
    'controller-loss pipe closure',
    1500,
  );
  assert.equal(child.signalCode, 'SIGKILL');
  assert(child.stdout.destroyed);
});
for (const phase of ['descendants', 'close', 'descendant']) {
  test(`copied credentials are removed even when ${phase} cleanup fails and workspace is retained`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'ah-cleanup-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const home = join(dir, 'codex-home'),
      workspace = join(dir, 'workspace');
    await mkdir(home);
    await mkdir(workspace);
    await writeFile(join(home, 'auth.json'), 'synthetic credential');
    await writeFile(join(workspace, 'log'), 'debug evidence');
    let closeCalled = false;
    const result = await live.cleanupManagedRun({
      home,
      descendants: async () => {
        if (phase === 'descendants') throw Error('fixture snapshot failure');
        return [123];
      },
      close: async () => {
        closeCalled = true;
        if (phase === 'close') throw Error('fixture close failure');
      },
      waitForExit: async () => {
        if (phase === 'descendant') throw Error('fixture live descendant');
      },
    });
    assert(closeCalled);
    assert.equal(result.errors.length, 1);
    assert.equal(result.credentialsRemoved, true);
    assert.equal(result.retainDirectory, true);
    await assert.rejects(stat(home), { code: 'ENOENT' });
    assert.equal(await readFile(join(workspace, 'log'), 'utf8'), 'debug evidence');
  });
}

test('owned command capture drains output and stops its supervisor after completion', async () => {
  const run = live.execOwned(
    process.execPath,
    [
      '-e',
      "const b=Buffer.from('验收'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>{process.stdout.write(b.subarray(1)); process.stderr.write('diagnostic');},10);",
    ],
    { graceMs: 50 },
  );
  assert.deepEqual(await run, { stdout: '验收', stderr: 'diagnostic' });
  assert.notEqual(run.child.signalCode, null);
});
for (const [name, code, options, error] of [
  [
    'failure',
    "process.stdout.write('before failure'); process.stderr.write('diagnostic'); process.exit(7)",
    {},
    /exited: 7/,
  ],
  ['early timeout', 'setInterval(()=>{},1000)', { timeout: 1 }, /timed out/],
  [
    'output limit',
    "setInterval(()=>process.stdout.write('xxxxxxxx'),1)",
    { maxBuffer: 4 },
    /output exceeds/,
  ],
]) {
  test(`owned command ${name} still closes its supervisor and pipes`, async () => {
    const run = live.execOwned(process.execPath, ['-e', code], { ...options, graceMs: 50 });
    await assert.rejects(run, (failure) => {
      assert.match(failure.message, error);
      if (name === 'failure') {
        assert.equal(failure.stdout, 'before failure');
        assert.equal(failure.stderr, 'diagnostic');
      }
      return true;
    });
    assert.notEqual(run.child.signalCode, null);
    assert(run.child.stdout.destroyed);
  });
}

for (const code of [7, 0]) {
  test(`supervisor loss after command exit ${code} preserves the correct primary error`, async (t) => {
    let run, termSent;
    const term = new Promise((resolve) => {
      termSent = resolve;
    });
    const kill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid, signal) => {
      const result = kill(pid, signal);
      if (pid === -run.child.pid && signal === 'SIGTERM') termSent();
      return result;
    });
    run = live.execOwned(
      process.execPath,
      [
        '-e',
        `process.stdout.write('command output'); process.stderr.write('command diagnostic'); process.exitCode=${code};`,
      ],
      { graceMs: 100 },
    );
    // Observe rejection immediately, before deliberately losing this test's supervisor.
    const failure = run.then(
      () => assert.fail('cleanup must fail'),
      (error) => error,
    );
    assert.equal((await run.child.completion).code, code);
    await term;
    const exited = once(run.child, 'exit');
    assert(run.child.kill('SIGKILL'));
    await exited;
    const error = await failure;
    if (code !== 0) {
      assert.match(error.message, /Owned command exited: 7/);
      assert.match(error.cleanupError?.message ?? '', /supervisor lost/i);
    } else {
      assert.match(error.message, /supervisor lost/i);
      assert.equal(error.cleanupError, undefined);
    }
    assert.equal(error.stdout, 'command output');
    assert.equal(error.stderr, 'command diagnostic');
  });
}

test('App Server startup failure retains stderr and attaches a later cleanup error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-start-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = join(dir, 'synthetic-auth');
  await mkdir(auth);
  await writeFile(join(auth, 'auth.json'), '{"synthetic":true}', { mode: 0o600 });
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = auth;
  t.after(() => {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  });
  const command = join(dir, 'fixture.mjs');
  await writeFile(
    command,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) process.stdout.write('fixture 1');
else process.stderr.write('fixture startup diagnostic', () => {
  // This parent is the supervisor created exclusively for this fake command.
  process.kill(process.ppid, 'SIGKILL');
  process.exitCode = 7;
});
`,
    { mode: 0o700 },
  );
  await assert.rejects(live.startCodex(join(dir, 'backend'), command), (error) => {
    assert.match(error.message, /^Owned App Server exited:/);
    assert.match(error.stderr ?? '', /fixture startup diagnostic/);
    assert.match(error.cleanupError?.message ?? '', /supervisor lost/i);
    return true;
  });
});

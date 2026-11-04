// Helpers for opt-in acceptance only. Never connect to or stop a user's daemon.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, chmod, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexRpc } from '../dist/vendor/codex-bridge/src/rpc.js';

export const exec = promisify(execFile);
export const SESSION_ENV_KEYS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CODEX_THREAD_ID',
]);
export const cleanEnv = (source = process.env, { blank = false } = {}) => {
  const env = { ...source };
  // Direct spawn gets absent keys. Only merge-based launchers need empty overrides.
  for (const key of SESSION_ENV_KEYS) {
    if (blank) env[key] = '';
    else delete env[key];
  }
  return env;
};
export async function until(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
const ownedGroups = new WeakMap();
export function spawnOwned(command, args = [], options = {}) {
  assert(process.platform !== 'win32', 'Owned acceptance groups require POSIX');
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./live-process-supervisor.mjs', import.meta.url)), command, ...args],
    { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], shell: false },
  );
  const state = { ready: false, stop: undefined };
  ownedGroups.set(child, state);
  child.completion = new Promise((resolve) => {
    child.on('message', (result) => {
      if (result.ready) state.ready = true;
      else resolve(result);
    });
    child.once('error', (error) => resolve({ error: error.message }));
    child.once('exit', () =>
      resolve({ error: 'Owned supervisor exited before command completion' }),
    );
  });
  return child;
}
export function stopOwned(child, graceMs = 3000) {
  const running = () => child?.pid && child.exitCode === null && child.signalCode === null;
  const state = ownedGroups.get(child);
  if (!state) {
    if (!running()) return Promise.resolve();
    return Promise.reject(Error('Refusing to signal a process without an owned supervisor'));
  }
  return (state.stop ??= (async () => {
    const signal = (value) => {
      if (!running())
        throw Error('Owned supervisor lost; process-group cleanup cannot be confirmed');
      // The live supervisor reserves this PGID even after the backend command exits.
      process.kill(-child.pid, value);
    };
    await until(() => state.ready || !running(), 'owned supervisor ready', 5000);
    signal('SIGTERM');
    await delay(graceMs);
    signal('SIGKILL');
    await until(
      () => !running() && child.stdout.destroyed && child.stderr.destroyed,
      'owned process-group pipes closed',
      3000,
    );
  })());
}
export function execOwned(command, args, options = {}) {
  const child = spawnOwned(command, args, { env: options.env, cwd: options.cwd });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '',
    stderr = '',
    capturedBytes = 0,
    overflow = false,
    timer;
  const result = new Promise((resolve, reject) => {
    const capture = (key, chunk) => {
      if (overflow) return;
      capturedBytes += Buffer.byteLength(chunk);
      if (capturedBytes > (options.maxBuffer ?? 1024 * 1024)) {
        overflow = true;
        reject(Error('Owned command output exceeds limit'));
        return;
      }
      if (key === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', (c) => capture('stdout', c));
    child.stderr.on('data', (c) => capture('stderr', c));
    timer = setTimeout(() => reject(Error('Owned command timed out')), options.timeout ?? 600000);
    child.completion.then((value) =>
      value.code === 0
        ? resolve()
        : reject(Error(value.error ?? `Owned command exited: ${value.code ?? value.signal}`)),
    );
  })
    .finally(async () => {
      clearTimeout(timer);
      await stopOwned(child, options.graceMs ?? 3000);
    })
    .then(() => ({ stdout, stderr }));
  result.child = child;
  return result;
}
export async function cleanupManagedRun({ home, close, descendants, waitForExit }) {
  const result = { cleanup: [], errors: [], retainDirectory: false, credentialsRemoved: false };
  const failed = (phase, error, extra = {}) => {
    result.errors.push(error);
    result.retainDirectory = true;
    result.cleanup.push({ phase, error: String(error), ...extra });
  };
  try {
    let pids = [];
    try {
      pids = await descendants();
    } catch (e) {
      failed('descendants', e);
    }
    try {
      await close();
    } catch (e) {
      failed('close', e);
    }
    for (const pid of pids) {
      try {
        await waitForExit(pid);
        result.cleanup.push({ pid, stopped: true });
      } catch (e) {
        failed('descendant', e, { pid, exitUnconfirmed: true });
      }
    }
  } finally {
    // Never retain copied authentication with debug workspaces, even when shutdown fails.
    try {
      await rm(home, { recursive: true, force: true });
      result.credentialsRemoved = true;
    } catch (e) {
      failed('credentials', e);
    }
  }
  return result;
}
export async function isolatedCodexHome(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  // Copy only auth, never sessions, settings, MCP configuration, or skills.
  const source = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  await writeFile(join(root, 'auth.json'), await readFile(source), { mode: 0o600, flag: 'wx' });
  await writeFile(
    join(root, 'config.toml'),
    'cli_auth_credentials_store = "file"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n',
    { mode: 0o600, flag: 'wx' },
  );
  return root;
}
export async function startCodex(root, command = 'codex') {
  const home = await isolatedCodexHome(join(root, 'home'));
  const socketPath = join(root, 'control.sock');
  const version = (await exec(command, ['--version'], { timeout: 15000 })).stdout.trim();
  const child = spawnOwned(command, ['app-server', '--listen', `unix://${socketPath}`], {
    cwd: root,
    env: { ...cleanEnv(), CODEX_HOME: home },
  });
  child.stdout.resume();
  let stderr = '',
    commandExit;
  void child.completion.then((result) => {
    commandExit = result;
  });
  child.stderr.on('data', (c) => {
    stderr = (stderr + c).slice(-8000);
  });
  try {
    await until(async () => {
      if (commandExit) throw Error(`Owned App Server exited: ${commandExit.error ?? stderr}`);
      return (await stat(socketPath).catch(() => null))?.isSocket();
    }, 'isolated App Server socket');
    const rpc = new CodexRpc({ socketPath });
    await rpc.connect();
    assert.equal((await rpc.request('thread/loaded/list')).data.length, 0);
    return { child, rpc, home, socketPath, version, stop: () => stopOwned(child) };
  } catch (e) {
    await stopOwned(child);
    throw e;
  }
}

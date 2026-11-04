// Helpers for opt-in acceptance only. Never connect to or stop a user's daemon.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
export const cleanEnv = (source = process.env) => {
  const env = { ...source };
  // Empty overrides remain cleared even when a launcher merges process.env.
  for (const key of SESSION_ENV_KEYS) env[key] = '';
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
export async function stopOwned(child, graceMs = 3000) {
  const running = () => child?.pid && child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  // Only children started with detached:true by this helper own these groups.
  const signal = (value) => {
    try {
      process.kill(-child.pid, value);
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (running() && Date.now() < deadline) await delay(50);
  // Once the tracked leader exits, its numeric PGID is no longer our authority.
  // Signal only while the ChildProcess still owns a live group leader.
  if (running()) signal('SIGKILL');
  await until(() => child.exitCode !== null || child.signalCode !== null, 'owned child exit', 3000);
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
  const child = spawn(command, ['app-server', '--listen', `unix://${socketPath}`], {
    cwd: root,
    env: { ...cleanEnv(), CODEX_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  let stderr = '',
    spawnError;
  child.stderr.on('data', (c) => {
    stderr = (stderr + c).slice(-8000);
  });
  child.on('error', (e) => {
    spawnError = e;
  });
  try {
    await until(async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error(`Owned App Server exited: ${stderr}`);
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

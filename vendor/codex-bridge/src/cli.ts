#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { CodexRpc } from './rpc.js';
import { createBridgeServer } from './server.js';
import { loadToken, localPort } from './config.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      port: { type: 'string', default: '3210' },
      socket: { type: 'string' },
      'token-file': { type: 'string' },
      'allow-origin': { type: 'string', multiple: true },
    },
  });
  if (values.help) {
    console.log(
      `Codex Session Bridge 0.1.0\n\nUsage: codex-session-bridge [options]\n\n  --port PORT          Local HTTP port (default 3210)\n  --socket PATH        Existing Codex App Server control socket\n  --token-file PATH    Private bearer-token file\n  --allow-origin URL   Allow one browser origin; repeat as needed\n\nEnvironment: CODEX_HOME, CODEX_BRIDGE_TOKEN, CODEX_BRIDGE_TOKEN_FILE\nAlways binds to 127.0.0.1. Never starts or restarts Codex.`,
    );
    return;
  }
  const socketPath = resolve(
    values.socket ??
      join(
        process.env.CODEX_HOME ?? join(homedir(), '.codex'),
        'app-server-control',
        'app-server-control.sock',
      ),
  );
  const tokenPath = resolve(
    values['token-file'] ??
      process.env.CODEX_BRIDGE_TOKEN_FILE ??
      join(homedir(), '.codex-session-bridge', 'token'),
  );
  const token = await loadToken(tokenPath, process.env.CODEX_BRIDGE_TOKEN);
  const rpc = new CodexRpc({ socketPath });
  const app = createBridgeServer({ rpc, token, allowedOrigins: values['allow-origin'] });
  const abort = new AbortController();
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    abort.abort();
    await app.close();
  };
  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });
  app.server.listen(localPort(values.port), '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  if (address && typeof address !== 'string')
    console.log(`Bridge: http://127.0.0.1:${address.port}`);
  console.log(
    process.env.CODEX_BRIDGE_TOKEN
      ? 'Token: CODEX_BRIDGE_TOKEN environment variable'
      : `Token file: ${tokenPath}`,
  );
  console.log(`Codex socket: ${socketPath}`);
  let backoff = 1000;
  while (!stopping) {
    try {
      await rpc.connect();
      if (stopping) {
        rpc.close();
        break;
      }
      console.log('Codex connected. Existing subscriptions must be attached explicitly.');
      backoff = 1000;
      await once(rpc, 'disconnect', { signal: abort.signal });
    } catch (error) {
      if (!stopping)
        console.error(error instanceof Error ? error.message : 'Codex connection failed');
    }
    if (!stopping) {
      await delay(backoff, undefined, { signal: abort.signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Bridge startup failed');
  process.exitCode = 1;
});

import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { CodexRpc } from '../dist/src/rpc.js';
import { createBridgeServer } from '../dist/src/server.js';
import { CodexBridgeClient } from '../dist/src/sdk.js';

const socketPath =
  process.env.CODEX_BRIDGE_SOCKET ??
  join(
    process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    'app-server-control/app-server-control.sock',
  );
const rpc = new CodexRpc({ socketPath, timeoutMs: 15_000 });
const token = randomBytes(32).toString('hex');
const app = createBridgeServer({ rpc, token });
try {
  await rpc.connect();
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const client = new CodexBridgeClient({
    token,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
  });
  const loaded = await client.loadedSessions({ limit: 10 });
  const listed = await client.listSessions({ limit: 2 });
  const searched = await client.search('Codex', { limit: 2 });
  const result = {
    connected: true,
    loadedCountOnPage: loaded.data.length,
    listCountOnPage: listed.data.length,
    searchCountOnPage: searched.data.length,
  };
  const id = loaded.data[0] ?? listed.data[0]?.id;
  if (id) {
    const detail = await client.detail(id);
    result.detailRead = detail.thread.id === id;
    for (const [name, read] of [
      ['turns', () => client.turns(id, { limit: 1 })],
      ['items', () => client.items(id, { limit: 1 })],
      ['occurrences', () => client.searchOccurrences(id, 'Codex', { limit: 1 })],
    ]) {
      try {
        const page = await read();
        result[name] = { ok: true, countOnPage: page.data.length };
      } catch (error) {
        result[name] = { ok: false, code: error.code, message: error.message };
      }
    }
  }
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(result).some((value) => value?.ok === false)) process.exitCode = 1;
} finally {
  await app.close();
}

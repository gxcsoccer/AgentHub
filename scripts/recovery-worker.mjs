// Isolated live test daemon. The controller supplies a private, newly-created
// session allowlist; this is never the production daemon's configuration.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { CodexRpc } from '../dist/vendor/codex-bridge/src/rpc.js';
import {
  CodexAdapter,
  ClaudeAdapter,
  AgentHub,
  openReceiptStore,
  createHubServer,
} from '../dist/src/index.js';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert(/^\/tmp\/hh-live-[^/]+\/state.sqlite$/.test(config.stateFile));
const rpc = new CodexRpc({ socketPath: config.socketPath });
const raw = rpc.request.bind(rpc),
  owned = new Set(config.owned);
rpc.request = async (method, params = {}) => {
  const read = [
    'thread/read',
    'thread/loaded/list',
    'thread/items/list',
    'thread/turns/list',
  ].includes(method);
  assert(
    read || (owned.has(params.threadId) && ['thread/resume', 'turn/start'].includes(method)),
    'Non-owned/unsupported write: ' + method,
  );
  if (method === 'thread/resume')
    assert.deepEqual(Object.keys(params).sort(), ['excludeTurns', 'threadId']);
  const result = await raw(method, params);
  if (!read)
    process.send?.({
      mutation: {
        method,
        threadId: params.threadId,
        ...(method === 'thread/resume'
          ? {
              settings: {
                cwd: result.cwd,
                model: result.model,
                approvalPolicy: result.approvalPolicy,
                approvalsReviewer: result.approvalsReviewer,
                sandbox: result.sandbox,
              },
            }
          : {}),
      },
    });
  return result;
};
const claude = new ClaudeAdapter({ nativeMessaging: true, discover: async () => [config.claude] });
const codex = new CodexAdapter({ rpc });
const hub = new AgentHub([codex, claude], { store: await openReceiptStore(config.stateFile) });
await hub.ready();
const app = createHubServer({ hub, token: config.token });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
process.send?.({ ready: `http://127.0.0.1:${app.server.address().port}` });
process.on('message', (message) => {
  if (message === 'disconnect') {
    rpc.close();
    process.send?.({ disconnected: true });
  }
});
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});

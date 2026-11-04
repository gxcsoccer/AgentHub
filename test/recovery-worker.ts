// A separate process is required to test OS lock release and stale UDS recovery.
import { HarnessHub } from '../src/hub.js';
import { openReceiptStore } from '../src/store.js';
import { createHubServer } from '../src/server.js';
import { ClaudeAdapter } from '../src/adapters/claude.js';
import { TestAdapter, testToken } from './helpers.js';
import { once } from 'node:events';

const config = JSON.parse(process.argv[2]!);
const local = new TestAdapter();
if (config.stall || config.stallForward)
  local.send = async (message) => {
    local.calls.push(message);
    if (config.stall || message.inReplyTo) {
      process.send?.({ submitted: message.messageId });
      return new Promise(() => {});
    }
    return { status: 'accepted' };
  };
const adapters = [
  local,
  ...(config.claude
    ? [
        new ClaudeAdapter({
          nativeMessaging: true,
          version: async () => '2.1.318',
          discover: async () => [config.claude],
        }),
      ]
    : []),
];
const hub = new HarnessHub(adapters, { store: await openReceiptStore(config.path) });
await hub.ready();
const app = createHubServer({ hub, token: testToken });
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
process.send?.({ url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` });
process.on('message', (message) => {
  if (message === 'calls') process.send?.({ calls: local.calls });
  if (message === 'reply')
    local.emit('update', {
      messageId: config.originalId,
      status: 'replied',
      reply: { text: 'forward once' },
    });
});
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0));
});

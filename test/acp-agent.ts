import { agent, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
const pending = new Map<string, () => void>();
let created = 0;
const app = agent({ name: 'agenthub-test-agent' })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
  .onRequest('session/new', async () => {
    created++;
    if (created === 2 && process.env.AGENTHUB_TEST_HANG_NEW === '1') await new Promise(() => {});
    if (created === 2 && process.env.AGENTHUB_TEST_REJECT_NEW === '1')
      throw RequestError.invalidParams();
    if (created === 2 && process.env.AGENTHUB_TEST_FAIL_NEW === '1')
      throw RequestError.internalError();
    return { sessionId: randomUUID() };
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');
    if (text === 'disconnect') process.exit(0);
    if (text === 'wait') {
      await new Promise<void>((resolve) => pending.set(params.sessionId, resolve));
      return { stopReason: 'cancelled' as const };
    }
    if (text === 'permission') {
      const result = await client.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Test action', kind: 'other', status: 'pending' },
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: JSON.stringify(result) },
        },
      });
    } else
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'echo:' + text },
        },
      });
    return { stopReason: 'end_turn' as const };
  })
  .onNotification('session/cancel', ({ params }) => {
    pending.get(params.sessionId)?.();
    pending.delete(params.sessionId);
  });
app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ),
);

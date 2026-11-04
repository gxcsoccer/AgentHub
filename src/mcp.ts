import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { HarnessHubClient } from './client.js';

const scope = z.object({
  harness: z.string().min(1),
  instance: z.string().min(1).default('local'),
});
const address = scope.extend({ sessionId: z.string().min(1) });
const page = {
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
};
async function result(action: () => Promise<unknown>) {
  try {
    const value = await action();
    return {
      resultType: 'complete' as const,
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
      structuredContent: { result: value },
    };
  } catch (error) {
    return {
      resultType: 'complete' as const,
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        },
      ],
    };
  }
}
export function createMcpServer(client: HarnessHubClient, originName = 'HarnessHub MCP') {
  const server = new McpServer({ name: 'harnesshub', version: '0.1.0' });
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool(
    'list_instances',
    {
      description: 'List configured harness instances. Does not start or resume sessions.',
      inputSchema: z.object({}),
      annotations: read,
    },
    () => result(() => client.instances()),
  );
  server.registerTool(
    'list_sessions',
    {
      description:
        'List or search session metadata. Claude lists active sessions; Codex can search persisted sessions.',
      inputSchema: scope.extend(page),
      annotations: read,
    },
    ({ harness, instance, ...query }) =>
      result(() => client.listSessions({ harness, instance }, query)),
  );
  server.registerTool(
    'get_session',
    {
      description: 'Get session state and actual capabilities without resuming it.',
      inputSchema: address,
      annotations: read,
    },
    (input) => result(() => client.getSession(input)),
  );
  server.registerTool(
    'get_history',
    {
      description:
        'Read a history page, preserving native identity. Claude includes busy peer-message attachments. No session resume.',
      inputSchema: address.extend(page),
      annotations: read,
    },
    ({ harness, instance, sessionId, ...query }) =>
      result(() => client.history({ harness, instance, sessionId }, query)),
  );
  server.registerTool(
    'search_history',
    {
      description:
        'Literal case-insensitive full-text search over one authorized session history. Bounded scans may return empty pages with a continuation. No resume or hidden index.',
      inputSchema: address.extend({ ...page, search: z.string().min(1).max(2000) }),
      annotations: read,
    },
    ({ harness, instance, sessionId, ...query }) =>
      result(() => client.search({ harness, instance, sessionId }, query)),
  );
  server.registerTool(
    'send_message',
    {
      description:
        'Send external content to a running session. Explicit tool_output (Codex) or peer_message (Claude); never user input. Reuse messageId only for the identical payload. Acceptance is not proof of a reply. Optional replyTo forwards the first correlated reply once.',
      inputSchema: z.object({
        messageId: z.string().uuid(),
        to: address,
        delivery: z.enum(['tool_output', 'peer_message']),
        text: z.string().min(1).max(100000),
        correlationId: z.string().optional(),
        inReplyTo: z.string().optional(),
        replyTo: address.optional(),
        expiresAt: z.string().optional(),
        hopCount: z.number().int().min(0).max(8).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (input) => result(() => client.send({ ...input, origin: { name: originName } })),
  );
  server.registerTool(
    'get_message_status',
    {
      description:
        'Read delivery evidence and correlated reply; optionally wait up to 60 seconds. Unknown delivery is not a reason to resend with a new ID.',
      inputSchema: z.object({
        messageId: z.string().uuid(),
        waitMs: z.number().int().min(0).max(60000).default(0),
      }),
      annotations: read,
    },
    ({ messageId, waitMs }) => result(() => client.receipt(messageId, waitMs)),
  );
  return server;
}
export async function serveMcp(client: HarnessHubClient, originName?: string) {
  const server = createMcpServer(client, originName);
  await server.connect(new StdioServerTransport());
  return server;
}

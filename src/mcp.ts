import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { AgentHubClient } from './client.js';
import { VERSION } from './version.js';
export { createConnectorMcpServer, serveConnectorMcp } from './connectors/mcp.js';

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
export function createMcpServer(client: AgentHubClient, originName = 'AgentHub MCP') {
  const server = new McpServer({ name: 'agenthub', version: VERSION });
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
        'Send a user-authorized request to a discovered running session. Set messageKind=request when asking for a reply; result is a terminal notification. Use tool_output for Codex or peer_message for Claude. Preserve the UUID and identical payload on retries. Poll get_message_status for the answer; acceptance alone is not a reply. Omit replyTo for an external client without a verified native return session. There is no automatic client wake-up.',
      inputSchema: z.object({
        messageId: z.string().uuid(),
        messageKind: z.enum(['request', 'result']).optional(),
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
        'Read delivery evidence and the correlated reply; optionally wait up to 60 seconds. Only status=replied with reply.text is an answer. For an interactive request, poll at most three times with waitMs=30000, then report the pending messageId so the user can check later. Unknown delivery is not a reason to resend with a new ID. Results do not wake this client automatically.',
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
export async function serveMcp(client: AgentHubClient, originName?: string) {
  const server = createMcpServer(client, originName);
  await server.connect(new StdioServerTransport());
  return server;
}

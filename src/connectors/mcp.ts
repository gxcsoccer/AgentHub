import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import type { ConnectorClient } from './client.js';
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
export function createConnectorMcpServer(client: ConnectorClient) {
  const server = new McpServer({
    name: 'agenthub-connector',
    version: `0.1.0+${client.connectionId}`,
  });
  server.registerTool(
    'list_peers',
    {
      description:
        'Discover authorized peers and canonical addresses. gaps identifies instances whose discovery failed or exceeded its bound; the list may be incomplete. Names may be ambiguous; source identity is verified by the connector.',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (_input, context) => result(() => client.listPeers(context.mcpReq._meta)),
  );
  server.registerTool(
    'ask_agent',
    {
      description:
        'Ask a peer asynchronously. Source and return route come from this session. Continue independent work or end the turn; the result arrives as a new external message with its request ID. Keep intervening user requests separate. No automatic retry after uncertain delivery.',
      inputSchema: z.strictObject({
        to: z.union([
          z.string().min(1).max(1024),
          z.strictObject({
            harness: z.string().min(1),
            instance: z.string().min(1),
            sessionId: z.string().min(1),
          }),
        ]),
        message: z.string().min(1).max(100000),
        deadlineSeconds: z.number().int().min(1).max(14400).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (input, context) => result(() => client.ask(input, context.mcpReq._meta)),
  );
  server.registerTool(
    'reply_agent',
    {
      description:
        'Reply once to a request addressed to this session. Use its request ID. Results do not request another reply.',
      inputSchema: z.strictObject({
        request: z.string().uuid(),
        message: z.string().min(1).max(100000),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (input, context) => result(() => client.reply(input, context.mcpReq._meta)),
  );
  return server;
}
export async function serveConnectorMcp(client: ConnectorClient) {
  const server = createConnectorMcpServer(client);
  await server.connect(new StdioServerTransport());
  return server;
}

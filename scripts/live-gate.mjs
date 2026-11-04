// Test-only deterministic barrier. The harness has no filesystem tool; only its
// isolated controller can release this gate in the temporary test directory.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const directory = process.argv[2];
if (!/^\/(?:private\/)?tmp\/hh-live-[^/]+\/claude$/.test(directory ?? ''))
  throw Error('Isolated directory required');
const server = new McpServer({ name: 'agenthub-test-gate', version: '1' });
server.registerTool(
  'wait',
  {
    description: 'Wait for the isolated test controller. No user work or external operations.',
    inputSchema: z.object({ token: z.string() }),
  },
  async ({ token }) => {
    await writeFile(
      join(directory, 'gate-entered.json'),
      JSON.stringify({ token, at: Date.now() }),
      { mode: 0o600 },
    );
    const deadline = Date.now() + 90000;
    for (;;) {
      try {
        await access(join(directory, 'gate-release'));
        break;
      } catch {}
      if (Date.now() > deadline) throw Error('Test gate timed out');
      await delay(50);
    }
    return { content: [{ type: 'text', text: 'Gate released; return the correlated replies.' }] };
  },
);
await server.connect(new StdioServerTransport());

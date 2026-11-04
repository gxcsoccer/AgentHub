import * as z from 'zod/v4';
import { AgentHub } from './hub.js';
import { ClaudePipeAdapter } from './adapters/claude-pipe.js';
import { AcpAdapter } from './adapters/acp.js';
import { CodexAdapter } from './adapters/codex.js';
import { ClaudeAdapter } from './adapters/claude.js';
import type { CallerPolicy } from './access.js';
import type { Adapter } from './types.js';
import { openReceiptStore, type ReceiptStore } from './store.js';

const configSchema = z
  .object({
    claudeWindows: z
      .array(
        z
          .object({
            instance: z.string().min(1),
            sessions: z.array(
              z
                .object({
                  sessionId: z.string().uuid(),
                  pipe: z.string().min(1),
                  token: z.string().min(1),
                  cwd: z.string().optional(),
                })
                .strict(),
            ),
            historyRoot: z.string().optional(),
            experimental: z.literal(true),
            timeoutMs: z.number().int().min(1).max(30000).optional(),
          })
          .strict(),
      )
      .optional(),
    acp: z
      .array(
        z
          .object({
            instance: z.string().min(1),
            command: z.string().min(1),
            args: z.array(z.string()).optional(),
            env: z.record(z.string(), z.string()).optional(),
            timeoutMs: z.number().int().min(100).max(300000).optional(),
            permissionTtlMs: z.number().int().min(100).max(300000).optional(),
          })
          .strict(),
      )
      .optional(),
    codex: z
      .union([
        z.literal(false),
        z.array(
          z
            .object({ instance: z.string().min(1), socketPath: z.string().min(1).optional() })
            .strict(),
        ),
      ])
      .optional(),
    claude: z
      .union([
        z.literal(false),
        z.array(
          z
            .object({
              instance: z.string().min(1),
              command: z.string().min(1).optional(),
              socketDirectory: z.string().min(1).optional(),
              historyRoot: z.string().min(1).optional(),
              nativeMessaging: z.boolean().default(false),
            })
            .strict(),
        ),
      ])
      .optional(),
  })
  .strict();
export function createLocalHub(
  value: unknown = {},
  options: { store?: ReceiptStore; callers?: CallerPolicy[] } = {},
) {
  const config = configSchema.parse(value);
  const adapters: Adapter[] = [];
  if (config.codex !== false)
    for (const entry of config.codex ?? [{ instance: 'local' }])
      adapters.push(new CodexAdapter(entry));
  if (config.claude !== false)
    for (const entry of config.claude ?? [{ instance: 'local', nativeMessaging: false }])
      adapters.push(new ClaudeAdapter(entry));
  for (const entry of config.claudeWindows ?? []) adapters.push(new ClaudePipeAdapter(entry));
  for (const entry of config.acp ?? []) adapters.push(new AcpAdapter(entry));
  return new AgentHub(adapters, options);
}
export async function openLocalHub(
  value: unknown,
  options: { stateFile: string | false; callers?: CallerPolicy[] },
) {
  const store = options.stateFile ? await openReceiptStore(options.stateFile) : undefined;
  let hub: AgentHub | undefined;
  try {
    hub = createLocalHub(value, { store, callers: options.callers });
    await hub.ready();
    return hub;
  } catch (error) {
    if (hub) await hub.close();
    else store?.close();
    throw error;
  }
}

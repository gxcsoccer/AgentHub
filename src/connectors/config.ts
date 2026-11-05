import * as z from 'zod/v4';
import { dirname, resolve } from 'node:path';
import { privateRead } from '../access-file.js';
import { HubError } from '../validation.js';
import type { ConnectorProfile } from './types.js';
async function read<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(JSON.parse(await privateRead(file)));
  if (!parsed.success) throw new HubError('invalid_profile', 'Invalid connector configuration');
  return parsed.data;
}
const filePath = z.string().min(1).max(4096);
export async function loadConnectorProfiles(filename: string): Promise<ConnectorProfile[]> {
  const file = resolve(filename),
    data = await read(
      file,
      z.strictObject({
        profiles: z
          .array(
            z.strictObject({
              id: z.string(),
              callerId: z.string(),
              harness: z.enum(['claude', 'codex']),
              transport: z.enum(['mcp', 'cli']).optional(),
              mcpServerName: z
                .string()
                .regex(/^[A-Za-z0-9_-]{1,64}$/)
                .optional(),
              instance: z.string(),
              enrollmentTokenFile: filePath,
              epoch: z.number().int().nonnegative().optional(),
              enabled: z.boolean().optional(),
            }),
          )
          .max(100),
      }),
    );
  return Promise.all(
    data.profiles.map(async ({ enrollmentTokenFile, ...profile }) => ({
      ...profile,
      enrollmentToken: (await privateRead(resolve(dirname(file), enrollmentTokenFile))).trim(),
    })),
  );
}
export async function loadConnectorClientProfile(filename: string) {
  const file = resolve(filename),
    profile = await read(
      file,
      z.strictObject({
        url: z.url(),
        enrollmentTokenFile: filePath,
        harness: z.enum(['claude', 'codex']).optional(),
      }),
    );
  return {
    baseUrl: profile.url,
    harness: profile.harness,
    enrollmentToken: (
      await privateRead(resolve(dirname(file), profile.enrollmentTokenFile))
    ).trim(),
  };
}

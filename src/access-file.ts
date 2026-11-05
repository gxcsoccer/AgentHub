import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AccessPolicy, type CallerCredential, type CallerPolicy } from './access.js';
import { HubError, object, text } from './validation.js';
export async function privateRead(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 1024 * 1024
    )
      throw new HubError(
        'unsafe_credentials',
        'Access configuration and tokens must be private owner files under 1 MiB',
        403,
      );
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
export async function loadAccessFile(
  filename: string,
): Promise<{ policies: CallerPolicy[]; credentials: CallerCredential[] }> {
  const file = resolve(filename),
    data = object(JSON.parse(await privateRead(file)));
  if (!Array.isArray(data.callers) || data.callers.length > 100)
    throw new HubError('invalid_policy', 'Expected at most 100 callers');
  const policies: CallerPolicy[] = [],
    credentials: CallerCredential[] = [];
  for (const value of data.callers) {
    const row = object(value),
      id = text(row.id, 'id', 128);
    policies.push({ id, grants: row.grants as CallerPolicy['grants'] });
    credentials.push({
      id,
      token: (
        await privateRead(resolve(dirname(file), text(row.tokenFile, 'tokenFile', 4096)))
      ).trim(),
    });
  }
  new AccessPolicy(policies);
  return { policies, credentials };
}

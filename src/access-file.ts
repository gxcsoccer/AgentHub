import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AccessPolicy, type CallerCredential, type CallerPolicy } from './access.js';
import { HubError, object, text } from './validation.js';
async function privateRead(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new HubError(
      'unsafe_credentials',
      'Access configuration and tokens must be private owner files',
      403,
    );
  return readFile(path, 'utf8');
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

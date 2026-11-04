import { randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function validateToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || /\s/.test(token))
    throw new Error('Token must have at least 32 characters and contain no whitespace');
  return token;
}
async function readToken(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error('Token path must be a regular file, not a symlink');
  if (process.platform !== 'win32' && stat.mode & 0o077)
    throw new Error('Token file permissions must be 0600');
  return validateToken(await readFile(path, 'utf8'));
}
export async function loadToken(path: string, override?: string): Promise<string> {
  if (override !== undefined) return validateToken(override);
  try {
    return await readToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    // Publish only a complete file, without replacing another process's token.
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return await readToken(path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
export function localPort(input: string): number {
  if (!/^\d+$/.test(input) || Number(input) > 65535)
    throw new Error('port must be an integer from 0 through 65535');
  return Number(input);
}

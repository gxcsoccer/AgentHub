import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, mkdtemp, link, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const exec = promisify(execFile);
export const pluginFiles = [
  'plugin.json',
  'com.doubao/cli.json',
  'skills/gxcsoccer-agenthub-collaboration/SKILL.md',
];
export async function packageDoubao(source, destination) {
  const root = resolve(source),
    out = resolve(destination);
  // An explicit allowlist keeps local configuration, tokens and reports outside the ZIP.
  for (const name of pluginFiles) {
    const stat = await lstat(join(root, name));
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('Invalid plugin file: ' + name);
  }
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  const cli = JSON.parse(await readFile(join(root, 'com.doubao/cli.json'), 'utf8'));
  if (
    manifest.name !== 'gxcsoccer-agenthub' ||
    Object.keys(cli.connectors).join() !== 'agenthub-local'
  )
    throw Error('Unexpected plugin identity');
  new RegExp(cli.connectors['agenthub-local'].statusMatchRegex);
  await mkdir(dirname(out), { recursive: true });
  const temporary = await mkdtemp(join(dirname(out), '.doubao-pack-'));
  try {
    const archive = join(temporary, 'plugin.zip');
    await exec('zip', ['-X', '-q', archive, ...pluginFiles], { cwd: root, timeout: 10000 });
    const bytes = await readFile(archive);
    if (bytes.length > 16 * 1024 * 1024) throw Error('Plugin ZIP exceeds 16 MiB');
    await link(archive, out); // Fails atomically if the destination already exists.
    return {
      path: out,
      bytes: bytes.length,
      files: pluginFiles,
      version: manifest.version,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      validation: 'Local package checks only; platform validation and host acceptance are separate',
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' } } });
    const source = fileURLToPath(new URL('../plugins/doubao', import.meta.url));
    console.log(
      JSON.stringify(
        await packageDoubao(source, values.output ?? '.local/doubao/agenthub-plugin-0.1.0.zip'),
      ),
    );
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

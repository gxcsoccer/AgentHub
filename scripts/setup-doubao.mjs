import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

// Generates a new, isolated Hub configuration. Never edits an existing daemon or host setup.
export async function setupDoubao({ directory, targets }) {
  if (process.platform === 'win32') throw Error('Doubao local setup requires macOS or Linux');
  if (!Array.isArray(targets) || !targets.length || targets.length > 100)
    throw Error('Provide 1–100 explicit target addresses');
  const groups = new Map();
  for (const t of targets) {
    if (
      !t ||
      Object.keys(t).sort().join(',') !== 'harness,instance,sessionId' ||
      !['claude', 'codex'].includes(t.harness) ||
      t.instance !== 'local' ||
      typeof t.sessionId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(t.sessionId)
    )
      throw Error('Targets must be explicit local Claude/Codex UUID addresses');
    if (!groups.has(t.harness)) groups.set(t.harness, new Set());
    groups.get(t.harness).add(t.sessionId);
  }
  const dest = resolve(directory);
  const parent = dirname(dest);
  // Require an existing real parent, avoiding recursive traversal through symlinks.
  if ((await lstat(parent)).isSymbolicLink() || (await realpath(parent)) !== parent)
    throw Error('Setup parent must be an existing canonical directory');
  await mkdir(dest, { mode: 0o700 }); // EEXIST is deliberate; never overwrite credentials.
  try {
    const write = (name, value) => writeFile(join(dest, name), value, { flag: 'wx', mode: 0o600 });
    await write('owner.token', randomBytes(32).toString('hex') + '\n');
    await write('caller.token', randomBytes(32).toString('hex') + '\n');
    const profiles = [];
    for (const harness of groups.keys()) {
      await write(harness + '-enrollment.token', randomBytes(32).toString('hex') + '\n');
      await write(
        harness + '-client.json',
        JSON.stringify(
          {
            url: 'http://127.0.0.1:3214',
            harness,
            enrollmentTokenFile: harness + '-enrollment.token',
          },
          null,
          2,
        ) + '\n',
      );
      profiles.push({
        id: 'doubao-' + harness,
        callerId: 'doubao-local',
        harness,
        instance: 'local',
        ...(harness === 'claude' ? { transport: 'cli' } : { mcpServerName: 'agenthub_doubao' }),
        enrollmentTokenFile: harness + '-enrollment.token',
      });
    }
    await write('connectors.json', JSON.stringify({ profiles }, null, 2) + '\n');
    await write(
      'access.json',
      JSON.stringify(
        {
          callers: [
            {
              id: 'doubao-local',
              tokenFile: 'caller.token',
              grants: [...groups].map(([harness, ids]) => ({
                harness,
                instance: 'local',
                operations: ['read', 'send'],
                sessions: [...ids],
              })),
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
    await write(
      'hub.json',
      JSON.stringify(
        {
          codex: groups.has('codex') ? [{ instance: 'local' }] : false,
          claude: groups.has('claude') ? [{ instance: 'local', nativeMessaging: true }] : false,
        },
        null,
        2,
      ) + '\n',
    );
    return {
      directory: dest,
      targets: targets.length,
      grants: ['read', 'send'],
      started: false,
      nativeSessionIdentity: false,
      startArgv: [
        'env',
        '-u',
        'AGENTHUB_TOKEN',
        'agenthub',
        'serve',
        '--port',
        '3214',
        '--config',
        join(dest, 'hub.json'),
        '--token-file',
        join(dest, 'owner.token'),
        '--access-file',
        join(dest, 'access.json'),
        '--connector-file',
        join(dest, 'connectors.json'),
        '--state-file',
        join(dest, 'state.sqlite'),
      ],
    };
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        directory: { type: 'string' },
        targets: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'node scripts/setup-doubao.mjs --targets FILE [--directory NEW_PRIVATE_DIRECTORY]',
      );
    else {
      if (!values.targets) throw Error('--targets FILE is required');
      const result = await setupDoubao({
        directory: values.directory ?? join(homedir(), '.agenthub', 'doubao'),
        targets: JSON.parse(await readFile(resolve(values.targets), 'utf8')),
      });
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

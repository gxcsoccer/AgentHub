import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath, lstat, rm, rename, unlink } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod/v4';
import { privateRead, loadAccessFile } from './access-file.js';
import { loadConnectorProfiles } from './connectors/config.js';
import { openLocalHub } from './runtime.js';
import { ConnectorService } from './connectors/service.js';
import { createHubServer } from './server.js';
import { AgentHubClient } from './client.js';
import { HubError } from './validation.js';
import { openDoubaoHost, type DoubaoHostApi, type DoubaoConnector } from './doubao-host.js';

const setupTargetsSchema = z
  .array(
    z.strictObject({
      harness: z.enum(['claude', 'codex']),
      instance: z.literal('local'),
      sessionId: z.string().uuid(),
    }),
  )
  .min(1)
  .max(100);

// Generates a new, isolated Hub configuration. Never edits an existing daemon or host setup.
export async function setupDoubao({
  directory,
  targets,
  port = 3214,
  cliPath = fileURLToPath(new URL('./cli.js', import.meta.url)),
}: {
  directory: string;
  targets: unknown;
  port?: number;
  cliPath?: string;
}) {
  if (process.platform === 'win32') throw Error('Doubao local setup requires macOS or Linux');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('port must be an integer between 1 and 65535');
  if (!isAbsolute(cliPath) || !(await lstat(cliPath)).isFile())
    throw Error('Build AgentHub first; cliPath must name an absolute CLI file');
  const url = `http://127.0.0.1:${port}`;
  const parsedTargets = setupTargetsSchema.safeParse(targets);
  if (!parsedTargets.success)
    throw Error('Provide 1–100 explicit local Claude/Codex UUID addresses');
  const checkedTargets = parsedTargets.data;
  const groups = new Map<string, Set<string>>();
  for (const t of checkedTargets) {
    if (!groups.has(t.harness)) groups.set(t.harness, new Set());
    groups.get(t.harness)!.add(t.sessionId);
  }
  const dest = resolve(directory);
  const parent = dirname(dest);
  // Require an existing real parent, avoiding recursive traversal through symlinks.
  if ((await lstat(parent)).isSymbolicLink() || (await realpath(parent)) !== parent)
    throw Error('Setup parent must be an existing canonical directory');
  await mkdir(dest, { mode: 0o700 }); // EEXIST is deliberate; never overwrite credentials.
  try {
    const files: Record<string, string> = {};
    const write = async (name: string, value: string) => {
      await writeFile(join(dest, name), value, { flag: 'wx', mode: 0o600 });
      files[name] = hash(value);
    };
    await write('owner.token', randomBytes(32).toString('hex') + '\n');
    await write('caller.token', randomBytes(32).toString('hex') + '\n');
    await write(
      'mcp.json',
      JSON.stringify(
        {
          mcpServers: {
            agenthub: {
              command: '/usr/bin/env',
              args: [
                '-u',
                'AGENTHUB_TOKEN',
                process.execPath,
                cliPath,
                'mcp',
                '--url',
                url,
                '--token-file',
                join(dest, 'caller.token'),
                '--origin-name',
                'Doubao Work',
              ],
            },
          },
        },
        null,
        2,
      ) + '\n',
    );
    const profiles = [];
    for (const harness of groups.keys()) {
      await write(harness + '-enrollment.token', randomBytes(32).toString('hex') + '\n');
      await write(
        harness + '-client.json',
        JSON.stringify(
          {
            url,
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
    const launcherPath = join(dest, 'agenthub-mcp');
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const launcher =
      '#!/bin/sh\nexec ' +
      [
        '/usr/bin/env',
        '-u',
        'AGENTHUB_TOKEN',
        process.execPath,
        cliPath,
        'setup',
        'mcp',
        '--directory',
        dest,
      ]
        .map(quote)
        .join(' ') +
      '\n';
    await writeFile(launcherPath, launcher, { flag: 'wx', mode: 0o700 });
    files['agenthub-mcp'] = hash(launcher);
    for (const name of ['setup.control.lock', 'setup.runtime.lock'])
      await writeFile(join(dest, name), '', { flag: 'wx', mode: 0o600 });
    await writeFile(
      join(dest, 'setup.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          port,
          targets: checkedTargets,
          enabled: true,
          uninstalled: false,
          files,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    return {
      directory: dest,
      launcherPath,
      managedStartArgv: [process.execPath, cliPath, 'setup', 'serve', '--directory', dest],
      targets: checkedTargets.length,
      grants: ['read', 'send'],
      started: false,
      nativeSessionIdentity: false,
      mcpConfigPath: join(dest, 'mcp.json'),
      startArgv: [
        'env',
        '-u',
        'AGENTHUB_TOKEN',
        process.execPath,
        cliPath,
        'serve',
        '--port',
        String(port),
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

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const baseFiles = [
  'owner.token',
  'caller.token',
  'mcp.json',
  'access.json',
  'hub.json',
  'connectors.json',
  'agenthub-mcp',
];
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  port: z.number().int().min(1).max(65535),
  targets: setupTargetsSchema,
  enabled: z.boolean(),
  uninstalled: z.boolean(),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  doubaoHost: z
    .strictObject({
      name: z.string().regex(/^agenthub-[a-f0-9-]{36}$/),
      attempted: z.boolean(),
      connectorId: z.string().regex(/^\d+$/).optional(),
      phase: z.enum(['pending', 'installed', 'removed', 'forgotten']),
    })
    .optional(),
});
function creationUnattempted(host: NonNullable<z.infer<typeof schema>['doubaoHost']>) {
  return host.phase === 'pending' && !host.attempted && !host.connectorId;
}
export async function loadSetup(directory: string, verify = true) {
  const dir = resolve(directory),
    stat = await lstat(dir);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    (await realpath(dir)) !== dir
  )
    throw new HubError(
      'unsafe_setup',
      'Setup directory must be canonical, private and owned by this user',
    );
  const parsed = schema.safeParse(JSON.parse(await privateRead(join(dir, 'setup.json'))));
  if (!parsed.success) throw new HubError('invalid_setup', 'Invalid setup manifest');
  const data = parsed.data;
  const expectedNames = [
    ...baseFiles,
    ...new Set(
      data.targets.flatMap((t) => [t.harness + '-enrollment.token', t.harness + '-client.json']),
    ),
  ].sort();
  if (JSON.stringify(Object.keys(data.files).sort()) !== JSON.stringify(expectedNames))
    throw new HubError('invalid_setup', 'Invalid setup manifest file set');
  if (data.uninstalled && data.enabled)
    throw new HubError('invalid_setup', 'Uninstalled setup cannot be enabled');
  if (verify && !data.uninstalled)
    for (const [name, expected] of Object.entries(data.files)) {
      if (hash(await privateRead(join(dir, name))) !== expected)
        throw new HubError('setup_modified', 'Generated file was modified: ' + name);
    }
  return data;
}
async function saveSetup(directory: string, data: z.infer<typeof schema>) {
  const file = join(directory, 'setup.json'),
    tmp = join(directory, '.setup-' + randomUUID());
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}
async function lock(directory: string, name: 'setup.control.lock' | 'setup.runtime.lock') {
  const file = join(directory, name);
  // Existing private lock files are created at initialization, never guessed from PIDs.
  await privateRead(file);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    return () => db.close();
  } catch {
    db.close();
    throw new HubError('setup_busy', 'Setup is in use', 409);
  }
}
async function runtimeStopped(directory: string) {
  try {
    const release = await lock(directory, 'setup.runtime.lock');
    release();
    return true;
  } catch (e) {
    if (e instanceof HubError && e.code === 'setup_busy') return false;
    throw e;
  }
}
async function ownHubReachable(directory: string, port: number) {
  const token = (await privateRead(join(directory, 'owner.token'))).trim();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/instances`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(1000),
    });
    try {
      // A different authenticated Hub or a service without this route is not ours.
      if ([401, 403, 404, 405].includes(response.status)) return false;
      if (!response.ok) throw Error('Hub identity probe failed');
      return z
        .object({
          data: z.array(z.object({ harness: z.string(), instance: z.string() })),
          eventCursor: z.string(),
        })
        .safeParse(await response.json()).success;
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  } catch (e) {
    if (e instanceof SyntaxError) return false;
    if (
      e instanceof TypeError &&
      (e.cause as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED'
    )
      return false;
    // A timeout, connection reset or server failure can still be our hung legacy Hub.
    throw new HubError(
      'setup_hub_unknown',
      'Cannot determine whether the configured port belongs to this Hub. Inspect or stop that service, then retry; credentials were retained.',
      409,
    );
  }
}
async function disable(directory: string, data: z.infer<typeof schema>) {
  if ((await runtimeStopped(directory)) && (await ownHubReachable(directory, data.port)))
    throw new HubError(
      'unmanaged_setup',
      'A Hub is using these credentials outside setup serve; stop that Hub first',
      409,
    );
  data.enabled = false;
  await saveSetup(directory, data);
  const deadline = Date.now() + 5000;
  while (!(await runtimeStopped(directory))) {
    if (Date.now() >= deadline)
      throw new HubError('setup_stopping', 'Disable recorded; Hub has not finished stopping', 409);
    await delay(50);
  }
  if (await ownHubReachable(directory, data.port))
    throw new HubError(
      'unmanaged_setup',
      'Another Hub still uses these credentials; stop it before proceeding',
      409,
    );
}
export async function setSetupEnabled(directory: string, enabled: boolean) {
  directory = resolve(directory);
  await loadSetup(directory);
  const release = await lock(directory, 'setup.control.lock');
  try {
    const data = await loadSetup(directory);
    if (data.uninstalled) throw new HubError('setup_uninstalled', 'Setup was uninstalled');
    if (enabled) {
      data.enabled = true;
      await saveSetup(directory, data);
    } else await disable(directory, data);
    return { directory, enabled, hubStarted: false, hostEntriesChanged: false };
  } finally {
    release();
  }
}
export async function uninstallSetup(directory: string) {
  directory = resolve(directory);
  await loadSetup(directory);
  const release = await lock(directory, 'setup.control.lock');
  try {
    const data = await loadSetup(directory);
    if (data.doubaoHost && creationUnattempted(data.doubaoHost)) {
      data.doubaoHost.phase = 'removed';
      await saveSetup(directory, data);
    }
    if (data.doubaoHost && !['removed', 'forgotten'].includes(data.doubaoHost.phase))
      throw new HubError(
        'host_cleanup_required',
        'Run setup host-remove first, or explicitly acknowledge possible remaining host entries with setup host-forget --confirm-host-name ' +
          data.doubaoHost.name,
      );
    if (!data.uninstalled) {
      await disable(directory, data);
      data.uninstalled = true;
      await saveSetup(directory, data);
    }
    // A previous uninstall may have stopped midway. Check every remaining file before deleting.
    for (const [name, expected] of Object.entries(data.files)) {
      let contents: string;
      try {
        contents = await privateRead(join(directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (hash(contents) !== expected)
        throw new HubError('setup_modified', 'Generated file was modified: ' + name);
    }
    const removed = [];
    for (const name of Object.keys(data.files)) {
      await unlink(join(directory, name)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      removed.push(name);
    }
    return {
      directory,
      uninstalled: true,
      removed,
      statePreserved: true,
      hostCleanupRequired: true,
      nextAction:
        'Remove only this AgentHub entry from the host UI and any installed native connector configuration. The state directory and unrelated files were preserved.',
    };
  } finally {
    release();
  }
}
export async function diagnoseSetup(directory: string) {
  directory = resolve(directory);
  const data = await loadSetup(directory);
  const base = {
    schemaVersion: 1,
    readOnly: true,
    hostLoadingVerified: false,
    deliveryTested: false,
    enabled: data.enabled,
    uninstalled: data.uninstalled,
    hostRegistration: data.doubaoHost ?? null,
  };
  if (!data.enabled || data.uninstalled)
    return {
      ...base,
      status: 'warning',
      code: data.uninstalled ? 'setup_uninstalled' : 'setup_disabled',
    };
  const client = new AgentHubClient({
    baseUrl: 'http://127.0.0.1:' + data.port,
    token: (await privateRead(join(directory, 'caller.token'))).trim(),
    timeoutMs: 3000,
  });
  const targets = [];
  for (const target of data.targets) {
    try {
      targets.push(await client.doctor({ scope: target, sessionId: target.sessionId }));
    } catch {
      return {
        ...base,
        status: 'error',
        code: 'hub_unreachable',
        nextAction: 'Start setup serve in another terminal and check its output.',
      };
    }
  }
  return {
    ...base,
    status: targets.some((r) => r.status === 'error') ? 'error' : 'warning',
    code: 'host_loading_unverified',
    targets,
    nextAction:
      'A read-only check cannot prove host tool loading or a model reply. Use a dedicated test conversation.',
  };
}
export async function serveSetup(directory: string, onStarted: (value: unknown) => void) {
  directory = resolve(directory);
  await loadSetup(directory);
  const release = await lock(directory, 'setup.runtime.lock');
  let app: ReturnType<typeof createHubServer> | undefined, timer: NodeJS.Timeout | undefined;
  let closeError: unknown;
  let stopping = false,
    resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void Promise.resolve(app?.close())
      .catch((error) => {
        closeError = error;
      })
      .finally(resolveDone);
  };
  try {
    const data = await loadSetup(directory);
    if (!data.enabled || data.uninstalled)
      throw new HubError('setup_disabled', 'Setup is disabled or uninstalled');
    const access = await loadAccessFile(join(directory, 'access.json'));
    const hub = await openLocalHub(JSON.parse(await privateRead(join(directory, 'hub.json'))), {
      stateFile: join(directory, 'state.sqlite'),
      callers: access.policies,
    });
    try {
      const connectors = new ConnectorService(
        hub,
        await loadConnectorProfiles(join(directory, 'connectors.json')),
      );
      app = createHubServer({
        hub,
        connectors,
        callers: access.credentials,
        token: (await privateRead(join(directory, 'owner.token'))).trim(),
      });
    } catch (e) {
      await hub.close();
      throw e;
    }
    app.server.listen(data.port, '127.0.0.1');
    await once(app.server, 'listening');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    timer = setInterval(() => {
      void loadSetup(directory, false)
        .then((current) => {
          if (!current.enabled || current.uninstalled) stop();
        })
        .catch(stop);
    }, 100);
    onStarted({ directory, url: 'http://127.0.0.1:' + data.port, managed: true });
    await done;
    if (closeError) throw closeError;
  } finally {
    if (timer) clearInterval(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try {
      if (app && !stopping) await app.close();
    } finally {
      release();
    }
  }
}
export async function setupMcp(directory: string) {
  directory = resolve(directory);
  const data = await loadSetup(directory);
  if (!data.enabled || data.uninstalled)
    throw new HubError('setup_disabled', 'Setup is disabled or uninstalled');
  const { serveMcp } = await import('./mcp.js');
  return serveMcp(
    new AgentHubClient({
      baseUrl: 'http://127.0.0.1:' + data.port,
      token: (await privateRead(join(directory, 'caller.token'))).trim(),
    }),
    'Doubao Work',
  );
}

// Local recovery only: keep the identity and uncertainty, rather than claiming remote removal.
export async function forgetDoubaoHost(directory: string, confirmHostName?: string) {
  directory = resolve(directory);
  await loadSetup(directory);
  const release = await lock(directory, 'setup.control.lock');
  try {
    const data = await loadSetup(directory);
    const host = data.doubaoHost;
    if (!host || host.phase === 'removed')
      return { changed: false, phase: host?.phase ?? 'absent' };
    if (confirmHostName !== host.name)
      throw new HubError(
        'host_confirmation_required',
        'The connector may still exist in Doubao. To stop managing it locally, pass --confirm-host-name ' +
          host.name,
      );
    const changed = host.phase !== 'forgotten';
    host.phase = 'forgotten';
    if (changed) await saveSetup(directory, data);
    return {
      changed,
      phase: host.phase,
      name: host.name,
      connectorId: host.connectorId,
      remoteCleanupVerified: false,
      hostCleanupRequired: true,
      nextAction:
        'You may now run setup uninstall. Check this exact connector name/ID in Doubao and remove it manually; its record remains in setup.json.',
    };
  } finally {
    release();
  }
}

// Explicit host operation, separate from stopping the Hub or canceling model work.
export async function configureDoubaoHost(
  directory: string,
  operation: 'install' | 'remove' | 'disable' | 'enable',
  port: number,
  connect: (port: number) => Promise<DoubaoHostApi> = openDoubaoHost,
) {
  directory = resolve(directory);
  await loadSetup(directory);
  const release = await lock(directory, 'setup.control.lock');
  let api: DoubaoHostApi | undefined;
  try {
    const data = await loadSetup(directory);
    if (data.uninstalled || (!data.enabled && (operation === 'install' || operation === 'enable')))
      throw new HubError(
        'setup_disabled',
        'Enable the setup before installing or enabling its host entry',
      );
    if ((!data.doubaoHost || data.doubaoHost.phase === 'removed') && operation !== 'install')
      return { changed: false, phase: 'absent', hostLoadingVerified: false };
    if (data.doubaoHost?.phase === 'forgotten')
      throw new HubError(
        'host_registration_forgotten',
        'Host registration was explicitly forgotten. Its record is retained for manual cleanup; automatic host operations are disabled for this setup.',
      );
    if (operation === 'remove' && data.doubaoHost && creationUnattempted(data.doubaoHost)) {
      data.doubaoHost.phase = 'removed';
      await saveSetup(directory, data);
      return {
        changed: true,
        phase: 'removed',
        creationAttempted: false,
        hostLoadingVerified: false,
      };
    }
    api = await connect(port);
    if (!data.doubaoHost || data.doubaoHost.phase === 'removed') {
      data.doubaoHost = { name: 'agenthub-' + randomUUID(), attempted: false, phase: 'pending' };
      await saveSetup(directory, data);
    }
    const host = data.doubaoHost;
    const alreadyInstalled = host.phase === 'installed';
    const command = join(directory, 'agenthub-mcp');
    const owned = (entry: DoubaoConnector) => {
      const config = entry?.mcp_config;
      if (
        entry?.name !== host.name ||
        (host.connectorId && entry.connector_id !== host.connectorId) ||
        config?.transport_type !== 3 ||
        config.stdio_config?.command !== command ||
        (config.stdio_config.params?.length ?? 0) !== 0 ||
        Object.keys(config.stdio_config.env ?? {}).length !== 0
      )
        throw new HubError(
          'host_configuration_changed',
          'Host connector no longer matches this setup; refusing to modify it',
        );
    };
    const entries = await api.list();
    const matches = entries.filter((e) =>
      host.connectorId ? e.connector_id === host.connectorId : e.name === host.name,
    );
    if (matches.length > 1)
      throw new HubError(
        'ambiguous_host_connector',
        'Multiple host entries match the recorded registration',
      );
    let entry = matches[0];
    if (!entry && operation === 'remove' && host.connectorId && host.phase === 'pending')
      entry = await api.detail(host.connectorId);
    if (!entry) {
      if (operation === 'remove') {
        // Without a received ID an uncertain create may still finish later.
        if (host.attempted && !host.connectorId)
          throw new HubError(
            'host_install_unknown',
            'Creation outcome is unknown; preserve the setup and verify the recorded unique name',
          );
        host.phase = 'removed';
        await saveSetup(directory, data);
        return { changed: false, phase: 'removed', hostLoadingVerified: false };
      }
      if (operation !== 'install' || host.attempted)
        throw new HubError(
          'host_install_unknown',
          'Recorded connector is absent; no create is retried automatically',
        );
      host.attempted = true;
      await saveSetup(directory, data); // Persist intent before the write, including lost responses.
      const created = await api.create(host.name, command);
      if (!created || !/^\d+$/.test(created.connector_id) || created.name !== host.name)
        throw new HubError(
          'host_install_unknown',
          'Create response did not identify the expected connector',
        );
      host.connectorId = created.connector_id;
      await saveSetup(directory, data);
      entry = await api.detail(host.connectorId);
    } else {
      entry = await api.detail(entry.connector_id);
      owned(entry);
      host.connectorId = entry.connector_id;
      await saveSetup(directory, data);
    }
    owned(entry);
    const id = host.connectorId!;
    if (operation === 'remove') {
      await api.remove(id);
      if ((await api.list()).some((e) => e.connector_id === id))
        throw new HubError(
          'host_removal_unverified',
          'Host still lists the connector after removal',
        );
      host.phase = 'removed';
    } else if (operation === 'disable' || operation === 'enable') {
      const enabled = operation === 'enable';
      await api.enabled(id, enabled);
      const after = await api.detail(id);
      owned(after);
      if (after.enabled !== enabled)
        throw new HubError('host_update_unverified', 'Host enabled state did not match');
    } else if (host.phase !== 'installed') {
      await api.connect(id);
      owned(await api.detail(id));
      if (!(await api.list()).some((e) => e.connector_id === id))
        throw new HubError(
          'host_install_unverified',
          'Created connector is not yet visible in the complete host list',
        );
      host.phase = 'installed';
    }
    await saveSetup(directory, data);
    return {
      changed: operation === 'install' ? !alreadyInstalled : true,
      phase: host.phase,
      connectorId: id,
      name: host.name,
      hostLoadingVerified: false,
      deliveryTested: false,
    };
  } finally {
    api?.close();
    release();
  }
}

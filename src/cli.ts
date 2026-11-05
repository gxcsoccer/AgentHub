#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { once } from 'node:events';
import { loadToken, localPort } from '../vendor/codex-bridge/src/config.js';
import { AgentHubClient } from './client.js';
import { createHubServer } from './server.js';
import { loadAccessFile } from './access-file.js';
import { loadConnectorProfiles, loadConnectorClientProfile } from './connectors/config.js';
import { ConnectorService } from './connectors/service.js';
import { ConnectorClient } from './connectors/client.js';
import { openLocalHub } from './runtime.js';
import { address, object, text } from './validation.js';
import type { MessageInput } from './types.js';
import { VERSION } from './version.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      port: { type: 'string' },
      directory: { type: 'string' },
      'doubao-cdp-port': { type: 'string' },
      'confirm-host-name': { type: 'string' },
      targets: { type: 'string' },
      url: { type: 'string' },
      config: { type: 'string' },
      cwd: { type: 'string' },
      'access-file': { type: 'string' },
      'connector-file': { type: 'string' },
      'connector-profile': { type: 'string' },
      'token-file': { type: 'string' },
      'state-file': { type: 'string' },
      ephemeral: { type: 'boolean' },
      'accept-resume-race': { type: 'boolean' },
      harness: { type: 'string' },
      instance: { type: 'string', default: 'local' },
      'session-id': { type: 'string' },
      'message-id': { type: 'string' },
      'message-file': { type: 'string' },
      'wait-ms': { type: 'string' },
      limit: { type: 'string' },
      cursor: { type: 'string' },
      search: { type: 'string' },
      after: { type: 'string' },
      'origin-name': { type: 'string' },
      'timeout-ms': { type: 'string' },
      to: { type: 'string' },
      message: { type: 'string' },
      request: { type: 'string' },
      'deadline-seconds': { type: 'string' },
      'activation-id': { type: 'string' },
      'retry-activation': { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    console.log(`AgentHub ${VERSION}

  agenthub serve [--config FILE] [--port 3211] [--token-file FILE]
                  [--state-file FILE | --ephemeral] [--access-file FILE] [--connector-file FILE]
  agenthub instances
  agenthub doctor [--harness NAME --instance local] [--session-id ID] [--timeout-ms 10000]
  agenthub sessions --harness codex|claude [--instance local] [--search TEXT]
  agenthub session|history --harness NAME --session-id ID [--cursor CURSOR]
  agenthub attach-reply --harness codex --session-id ID --accept-resume-race
  agenthub search --harness NAME --session-id ID --search TEXT
  agenthub create --harness acp --instance NAME --cwd ABSOLUTE_PATH
  agenthub prompt --message-file FILE
  agenthub cancel --harness acp --instance NAME --session-id ID
  agenthub send --message-file FILE
  agenthub status --message-id UUID [--wait-ms 30000]
  agenthub events [--after CURSOR]
  agenthub mcp [--origin-name NAME]
  agenthub mcp --connector-profile FILE
  agenthub connector-hook --connector-profile FILE  (Claude lifecycle JSON on stdin)
  agenthub connections
  agenthub agent --connector-profile FILE list-peers
  agenthub agent --connector-profile FILE ask --to @harness/name --message TEXT [--deadline-seconds 3600]
  agenthub agent --connector-profile FILE reply --request UUID --message TEXT
  agenthub agent --connector-profile FILE activate --activation-id UUID
  agenthub connect --harness codex|claude --session-id ID [--connector-profile FILE] [--wait-ms 30000]
                   [--retry-activation] (Claude CLI: explicitly replace an expired handshake)
  agenthub disconnect --harness codex|claude --session-id ID
  agenthub setup targets --harness claude|codex [--cursor CURSOR]
  agenthub setup init --directory NEW_DIR --targets FILE [--port 3214]
  agenthub setup init --directory NEW_DIR --harness claude|codex --session-id UUID
  agenthub setup serve|connect|doctor|disable|enable|uninstall --directory DIR
  agenthub setup mcp --directory DIR (generated local host launcher)
  agenthub setup host-install|host-disable|host-enable|host-remove --directory DIR --doubao-cdp-port PORT
                   (experimental Doubao 2.35.15 API; requires an already enabled debug port)
  agenthub setup host-forget --directory DIR --confirm-host-name NAME
                   (offline recovery; host entry may remain and its record is retained)

Clients: --url http://127.0.0.1:3211 --token-file FILE
Environment: AGENTHUB_URL, AGENTHUB_TOKEN, AGENTHUB_TOKEN_FILE, AGENTHUB_STATE_FILE
Claude native sends require nativeMessaging:true in the config and CLI 2.1.318.
Receipts persist by default beside the token file (state.sqlite). Node >=22.13 required.
attach-reply explicitly uses thread/resume after a loaded check; a concurrent unload may resume it.
JSON goes to stdout. Agent-facing MCP never exposes attach or approval operations.
doctor checks read-only prerequisites, not delivery: exit 0=ok, 2=warning, 1=error.
No session is launched, resumed or interrupted implicitly.`);
    return;
  }
  if (command === 'setup') {
    const setup = await import('./setup.js');
    const operation = positionals[1];
    if (operation === 'targets') {
      const harness = text(values.harness, '--harness', 64);
      if (!['claude', 'codex'].includes(harness)) throw Error('Expected claude or codex');
      const hub = await openLocalHub(
        {
          codex: harness === 'codex' ? [{ instance: 'local' }] : false,
          claude: harness === 'claude' ? [{ instance: 'local' }] : false,
        },
        { stateFile: false },
      );
      try {
        const adapter = hub.adapter({ harness, instance: 'local' });
        const query = { limit: 100, ...(values.cursor ? { cursor: values.cursor } : {}) };
        console.log(
          JSON.stringify(await (adapter.listPeerSessions?.(query) ?? adapter.listSessions(query))),
        );
      } finally {
        await hub.close();
      }
      return;
    }
    const directory = resolve(values.directory ?? join(homedir(), '.agenthub', 'doubao'));
    if (operation === 'init') {
      if (values.targets && (values.harness || values['session-id']))
        throw Error('Choose --targets or one explicit harness/session');
      const targets = values.targets
        ? JSON.parse(await readFile(values.targets, 'utf8'))
        : [{ harness: values.harness, instance: values.instance, sessionId: values['session-id'] }];
      if (!values.directory) await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      console.log(
        JSON.stringify(
          await setup.setupDoubao({ directory, targets, port: Number(values.port ?? 3214) }),
        ),
      );
    } else if (operation === 'host-forget') {
      console.log(
        JSON.stringify(await setup.forgetDoubaoHost(directory, values['confirm-host-name'])),
      );
    } else if (
      ['host-install', 'host-disable', 'host-enable', 'host-remove'].includes(operation ?? '')
    ) {
      if (!values['doubao-cdp-port'])
        throw Error('--doubao-cdp-port is required for explicit host operations');
      console.log(
        JSON.stringify(
          await setup.configureDoubaoHost(
            directory,
            operation!.slice(5) as 'install' | 'remove' | 'disable' | 'enable',
            Number(values['doubao-cdp-port']),
          ),
        ),
      );
    } else if (operation === 'serve')
      await setup.serveSetup(directory, (value) => console.log(JSON.stringify(value)));
    else if (operation === 'mcp') await setup.setupMcp(directory);
    else if (operation === 'disable' || operation === 'enable')
      console.log(JSON.stringify(await setup.setSetupEnabled(directory, operation === 'enable')));
    else if (operation === 'uninstall')
      console.log(JSON.stringify(await setup.uninstallSetup(directory)));
    else if (operation === 'doctor') {
      const report = await setup.diagnoseSetup(directory);
      console.log(JSON.stringify(report));
      process.exitCode = report.status === 'error' ? 1 : 2;
    } else if (operation === 'connect') {
      const config = await setup.loadSetup(directory);
      if (!config.enabled || config.uninstalled) throw Error('Setup is disabled or uninstalled');
      const { privateRead } = await import('./access-file.js');
      const client = new AgentHubClient({
        baseUrl: 'http://127.0.0.1:' + config.port,
        token: (await privateRead(join(directory, 'owner.token'))).trim(),
      });
      const targets = config.targets.filter(
        (t) =>
          (!values.harness || t.harness === values.harness) &&
          (!values['session-id'] || t.sessionId === values['session-id']),
      );
      if (!targets.length) throw Error('Target is outside the generated allowlist');
      const results = [];
      for (const target of targets)
        results.push(
          await client.connectSession(target, {
            clientProfilePath: join(directory, target.harness + '-client.json'),
            waitMs: Number(values['wait-ms'] ?? 60000),
          }),
        );
      console.log(JSON.stringify({ results }));
      process.exitCode = results.some((r) => r.exitCode !== 0) ? 2 : 0;
    } else
      throw Error(
        'Expected setup init, targets, serve, connect, doctor, disable, enable, uninstall, mcp, host-install, host-disable, host-enable, host-remove or host-forget',
      );
    return;
  }
  if (
    ![
      'serve',
      'instances',
      'doctor',
      'sessions',
      'session',
      'attach-reply',
      'history',
      'search',
      'create',
      'cancel',
      'prompt',
      'send',
      'status',
      'events',
      'mcp',
      'connector-hook',
      'connections',
      'connect',
      'disconnect',
      'agent',
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  if (
    (values['connector-profile'] && command !== 'connect') ||
    command === 'connector-hook' ||
    command === 'agent'
  ) {
    if (command !== 'mcp' && command !== 'connector-hook' && command !== 'agent')
      throw new Error('--connector-profile requires mcp, connector-hook or agent');
    const profile = await loadConnectorClientProfile(
      text(values['connector-profile'], '--connector-profile', 4096),
    );
    if (command === 'agent') {
      if (profile.harness === 'codex')
        throw new Error('Agent CLI transport currently requires Claude');
      const client = new ConnectorClient({ ...profile, transport: 'cli' });
      const operation = positionals[1];
      let result: unknown;
      if (operation === 'list-peers') result = await client.listPeers();
      else if (operation === 'activate')
        result = await client.activate(text(values['activation-id'], '--activation-id', 64));
      else if (operation === 'ask')
        result = await client.ask({
          to: text(values.to, '--to', 1024),
          message: text(values.message, '--message', 100000),
          ...(values['deadline-seconds']
            ? { deadlineSeconds: Number(values['deadline-seconds']) }
            : {}),
        });
      else if (operation === 'reply')
        result = await client.reply({
          request: text(values.request, '--request', 64),
          message: text(values.message, '--message', 100000),
        });
      else throw new Error('Expected agent list-peers, ask, reply or activate');
      console.log(JSON.stringify(result));
    } else if (command === 'mcp') {
      const { serveConnectorMcp } = await import('./connectors/mcp.js');
      await serveConnectorMcp(new ConnectorClient(profile));
    } else {
      let raw = '';
      for await (const chunk of process.stdin) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 65536) throw new Error('Lifecycle input too large');
      }
      const event = object(JSON.parse(raw));
      if (event.hook_event_name !== 'SessionStart' && event.hook_event_name !== 'SessionEnd')
        throw new Error('Expected SessionStart or SessionEnd hook');
      const client = new AgentHubClient({
        baseUrl: profile.baseUrl,
        token: profile.enrollmentToken,
        timeoutMs: 5000,
      });
      console.log(
        JSON.stringify(
          await client.connectorHook({
            pid: process.pid,
            event: event.hook_event_name,
            sessionId: text(event.session_id, 'session_id', 64),
          }),
        ),
      );
    }
    return;
  }
  const tokenPath = resolve(
    values['token-file'] ??
      process.env.AGENTHUB_TOKEN_FILE ??
      join(homedir(), '.agenthub', 'token'),
  );
  if (command === 'serve') {
    const config = values.config ? JSON.parse(await readFile(resolve(values.config), 'utf8')) : {};
    const token = await loadToken(tokenPath, process.env.AGENTHUB_TOKEN);
    if (values.ephemeral && values['state-file'])
      throw new Error('Choose --state-file or --ephemeral');
    const stateFile = values.ephemeral
      ? false
      : resolve(
          values['state-file'] ??
            process.env.AGENTHUB_STATE_FILE ??
            join(dirname(tokenPath), 'state.sqlite'),
        );
    const access = values['access-file'] ? await loadAccessFile(values['access-file']) : undefined;
    const hub = await openLocalHub(config, { stateFile, callers: access?.policies });
    let app: ReturnType<typeof createHubServer>;
    try {
      const connectors = values['connector-file']
        ? new ConnectorService(hub, await loadConnectorProfiles(values['connector-file']))
        : undefined;
      app = createHubServer({ hub, token, callers: access?.credentials, connectors });
    } catch (error) {
      await hub.close();
      throw error;
    }
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void app.close().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      app.server.listen(localPort(values.port ?? '3211'), '127.0.0.1');
      await once(app.server, 'listening');
    } catch (error) {
      await app.close();
      throw error;
    }
    const addr = app.server.address();
    console.log(
      JSON.stringify({
        url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : values.port}`,
        tokenSource: process.env.AGENTHUB_TOKEN ? 'AGENTHUB_TOKEN' : tokenPath,
        stateFile,
      }),
    );
    return;
  }
  // Client commands never create a new credential or silently start a daemon.
  const token = (process.env.AGENTHUB_TOKEN ?? (await readFile(tokenPath, 'utf8'))).trim();
  const client = new AgentHubClient({
    baseUrl: values.url ?? process.env.AGENTHUB_URL ?? 'http://127.0.0.1:3211',
    token,
    ...(command === 'doctor' ? { timeoutMs: Number(values['timeout-ms'] ?? 10000) } : {}),
  });
  if (command === 'connections') {
    console.log(JSON.stringify(await client.connections()));
    return;
  }
  const scope = () => ({
    harness: text(values.harness, '--harness', 64),
    instance: values.instance,
  });
  const target = () => address({ ...scope(), sessionId: values['session-id'] });
  if (command === 'disconnect') {
    console.log(JSON.stringify(await client.disconnect({ address: target() })));
    return;
  }
  if (command === 'connect') {
    const result = await client.connectSession(target(), {
      ...(values['connector-profile']
        ? { clientProfilePath: resolve(values['connector-profile']) }
        : {}),
      waitMs: Number(values['wait-ms'] ?? 0),
      ...(values['retry-activation'] ? { retryActivation: true } : {}),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
    return;
  }
  const query = {
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.cursor ? { cursor: values.cursor } : {}),
    ...(values.search ? { search: values.search } : {}),
  };
  if (command === 'create') {
    console.log(
      JSON.stringify(await client.createSession(scope(), text(values.cwd, '--cwd', 4096))),
    );
    return;
  }
  if (command === 'cancel') {
    console.log(JSON.stringify(await client.cancel(target())));
    return;
  }
  if (command === 'prompt') {
    const input = object(
      JSON.parse(await readFile(text(values['message-file'], '--message-file', 4096), 'utf8')),
    );
    if (input.delivery !== 'user_input') throw new Error('Explicit user_input required');
    console.log(
      JSON.stringify(
        await client.prompt(input as unknown as MessageInput & { delivery: 'user_input' }),
      ),
    );
    return;
  }
  if (command === 'search') {
    console.log(
      JSON.stringify(
        await client.search(target(), { ...query, search: text(values.search, '--search', 2000) }),
      ),
    );
    return;
  }
  if (command === 'doctor') {
    if (!values.harness && (values['session-id'] !== undefined || values.instance !== 'local'))
      throw new Error('doctor --session-id or --instance requires --harness');
    const report = await client.doctor({
      ...(values.harness ? { scope: scope() } : {}),
      ...(values['session-id'] !== undefined ? { sessionId: values['session-id'] } : {}),
    });
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'ok' ? 0 : report.status === 'warning' ? 2 : 1;
    return;
  }
  if (command === 'mcp') {
    const { serveMcp } = await import('./mcp.js');
    await serveMcp(client, values['origin-name']);
    return;
  }
  if (command === 'events') {
    for await (const event of client.events({ after: values.after }))
      console.log(JSON.stringify(event));
    return;
  }
  if (command === 'attach-reply') {
    if (!values['accept-resume-race'])
      throw new Error('attach-reply requires --accept-resume-race acknowledgment');
    console.log(
      JSON.stringify(await client.attachReplyRoute(target(), { acceptResumeRace: true })),
    );
    return;
  }
  const result =
    command === 'instances'
      ? await client.instances()
      : command === 'sessions'
        ? await client.listSessions(scope(), query)
        : command === 'session'
          ? await client.getSession(target())
          : command === 'history'
            ? await client.history(target(), query)
            : command === 'status'
              ? await client.receipt(
                  text(values['message-id'], '--message-id', 128),
                  Number(values['wait-ms'] ?? 0),
                )
              : await client.send(
                  object(
                    JSON.parse(
                      await readFile(
                        resolve(text(values['message-file'], '--message-file', 4096)),
                        'utf8',
                      ),
                    ),
                  ) as unknown as MessageInput,
                );
  console.log(JSON.stringify(result));
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: {
        code: error?.code ?? 'command_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
  process.exitCode = 1;
});

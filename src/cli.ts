#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { once } from 'node:events';
import { loadToken, localPort } from '../vendor/codex-bridge/src/config.js';
import { HarnessHubClient } from './client.js';
import { createHubServer } from './server.js';
import { loadAccessFile } from './access-file.js';
import { openLocalHub } from './runtime.js';
import { address, object, text } from './validation.js';
import type { MessageInput } from './types.js';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      port: { type: 'string', default: '3211' },
      url: { type: 'string' },
      config: { type: 'string' },
      cwd: { type: 'string' },
      'access-file': { type: 'string' },
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
    },
  });
  const command = positionals[0] ?? 'help';
  if (values.help || command === 'help') {
    console.log(`HarnessHub 0.1.0

  harnesshub serve [--config FILE] [--port 3211] [--token-file FILE]
                  [--state-file FILE | --ephemeral] [--access-file FILE]
  harnesshub instances
  harnesshub doctor [--harness NAME --instance local] [--session-id ID] [--timeout-ms 10000]
  harnesshub sessions --harness codex|claude [--instance local] [--search TEXT]
  harnesshub session|history --harness NAME --session-id ID [--cursor CURSOR]
  harnesshub attach-reply --harness codex --session-id ID --accept-resume-race
  harnesshub search --harness NAME --session-id ID --search TEXT
  harnesshub create --harness acp --instance NAME --cwd ABSOLUTE_PATH
  harnesshub prompt --message-file FILE
  harnesshub cancel --harness acp --instance NAME --session-id ID
  harnesshub send --message-file FILE
  harnesshub status --message-id UUID [--wait-ms 30000]
  harnesshub events [--after CURSOR]
  harnesshub mcp [--origin-name NAME]

Clients: --url http://127.0.0.1:3211 --token-file FILE
Environment: HARNESSHUB_URL, HARNESSHUB_TOKEN, HARNESSHUB_TOKEN_FILE, HARNESSHUB_STATE_FILE
Claude native sends require nativeMessaging:true in the config and CLI 2.1.318.
Receipts persist by default beside the token file (state.sqlite). Node >=22.13 required.
attach-reply explicitly uses thread/resume after a loaded check; a concurrent unload may resume it.
JSON goes to stdout. Agent-facing MCP never exposes attach or approval operations.
doctor checks read-only prerequisites, not delivery: exit 0=ok, 2=warning, 1=error.
No session is launched, resumed or interrupted implicitly.`);
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
    ].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  const tokenPath = resolve(
    values['token-file'] ??
      process.env.HARNESSHUB_TOKEN_FILE ??
      join(homedir(), '.harnesshub', 'token'),
  );
  if (command === 'serve') {
    const config = values.config ? JSON.parse(await readFile(resolve(values.config), 'utf8')) : {};
    const token = await loadToken(tokenPath, process.env.HARNESSHUB_TOKEN);
    if (values.ephemeral && values['state-file'])
      throw new Error('Choose --state-file or --ephemeral');
    const stateFile = values.ephemeral
      ? false
      : resolve(
          values['state-file'] ??
            process.env.HARNESSHUB_STATE_FILE ??
            join(dirname(tokenPath), 'state.sqlite'),
        );
    const access = values['access-file'] ? await loadAccessFile(values['access-file']) : undefined;
    const hub = await openLocalHub(config, { stateFile, callers: access?.policies });
    const app = createHubServer({ hub, token, callers: access?.credentials });
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
      app.server.listen(localPort(values.port), '127.0.0.1');
      await once(app.server, 'listening');
    } catch (error) {
      await app.close();
      throw error;
    }
    const addr = app.server.address();
    console.log(
      JSON.stringify({
        url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : values.port}`,
        tokenSource: process.env.HARNESSHUB_TOKEN ? 'HARNESSHUB_TOKEN' : tokenPath,
        stateFile,
      }),
    );
    return;
  }
  // Client commands never create a new credential or silently start a daemon.
  const token = (process.env.HARNESSHUB_TOKEN ?? (await readFile(tokenPath, 'utf8'))).trim();
  const client = new HarnessHubClient({
    baseUrl: values.url ?? process.env.HARNESSHUB_URL ?? 'http://127.0.0.1:3211',
    token,
    ...(command === 'doctor' ? { timeoutMs: Number(values['timeout-ms'] ?? 10000) } : {}),
  });
  const scope = () => ({
    harness: text(values.harness, '--harness', 64),
    instance: values.instance,
  });
  const target = () => address({ ...scope(), sessionId: values['session-id'] });
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

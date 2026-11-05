import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter, once } from 'node:events';
import { setupDoubao } from '../scripts/setup-doubao.mjs';
import { packageDoubao, pluginFiles } from '../scripts/package-doubao.mjs';
import { AgentHub, createHubServer, loadAccessFile } from '../dist/src/index.js';
import { loadConnectorProfiles } from '../dist/src/connectors/config.js';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const target = { harness: 'claude', instance: 'local', sessionId: randomUUID() };
async function folder(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ah-doubao-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('Doubao setup creates private scoped credentials without starting or overwriting anything', async (t) => {
  const root = await folder(t),
    directory = join(root, 'profile');
  const result = await setupDoubao({ directory, targets: [target] });
  assert.equal(result.started, false);
  assert.equal(result.nativeSessionIdentity, false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of [
    'owner.token',
    'caller.token',
    'access.json',
    'hub.json',
    'connectors.json',
    'claude-enrollment.token',
    'claude-client.json',
  ])
    assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
  const owner = await readFile(join(directory, 'owner.token'), 'utf8');
  const caller = await readFile(join(directory, 'caller.token'), 'utf8');
  assert.notEqual(owner, caller);
  const profiles = await loadConnectorProfiles(join(directory, 'connectors.json'));
  assert.equal(profiles[0].transport, 'cli');
  assert.equal(profiles[0].callerId, 'doubao-local');
  assert.notEqual(profiles[0].enrollmentToken, caller.trim());
  assert(!JSON.stringify(result).includes(caller.trim()));
  const access = await loadAccessFile(join(directory, 'access.json'));
  assert.deepEqual(access.policies[0].grants, [
    {
      harness: 'claude',
      instance: 'local',
      operations: ['read', 'send'],
      sessions: [target.sessionId],
    },
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'hub.json'), 'utf8')), {
    codex: false,
    claude: [{ instance: 'local', nativeMessaging: true }],
  });
  await assert.rejects(setupDoubao({ directory, targets: [target] }), { code: 'EEXIST' });
  assert.equal(await readFile(join(directory, 'caller.token'), 'utf8'), caller);
});
test('Doubao setup rejects wildcard, unverified harness and invalid targets before creating credentials', async (t) => {
  const root = await folder(t);
  for (const targets of [
    [],
    [{ ...target, sessionId: '*' }],
    [{ ...target, harness: 'doubao' }],
    [{ ...target, instance: 'remote' }],
    [{ ...target, extra: 'value' }],
  ])
    await assert.rejects(setupDoubao({ directory: join(root, 'invalid'), targets }));
  await assert.rejects(stat(join(root, 'invalid')), { code: 'ENOENT' });
});
test('Doubao plugin ZIP contains only the published CLI configuration and workflow, never credentials', async (t) => {
  const root = await folder(t),
    archive = join(root, 'plugin.zip');
  const source = fileURLToPath(new URL('../plugins/doubao', import.meta.url));
  const result = await packageDoubao(source, archive);
  const listing = (await exec('unzip', ['-Z1', archive])).stdout.trim().split('\n');
  assert.deepEqual(listing, pluginFiles);
  assert(result.bytes < 16 * 1024 * 1024);
  await assert.rejects(packageDoubao(source, archive), { code: 'EEXIST' });
  const config = JSON.parse((await exec('unzip', ['-p', archive, 'com.doubao/cli.json'])).stdout);
  const c = config.connectors['agenthub-local'];
  assert.equal(c.install.default[0], 'npm install -g @gxcsoccer/agenthub@0.2.0');
  assert(c.status.default[0].startsWith('env -u AGENTHUB_TOKEN agenthub'));
  assert(c.status.default[0].includes('/doubao/caller.token'));
  const pattern = new RegExp(c.statusMatchRegex);
  assert(pattern.test('{"data":[],"eventCursor":"id:0"}\n'));
  assert(!pattern.test('{"error":"unauthorized"}'));
  const skill = (await exec('unzip', ['-p', archive, pluginFiles[2]])).stdout;
  assert(skill.includes('messageKind'));
  assert(skill.includes('不要承诺结果会主动唤醒当前豆包对话'));
});
test('Doubao workflow uses real CLI and scoped HTTP: request, reply, duplicate and forbidden target', async (t) => {
  const root = await folder(t),
    directory = join(root, 'profile');
  await setupDoubao({ directory, targets: [target] });
  const access = await loadAccessFile(join(directory, 'access.json'));
  const owner = (await readFile(join(directory, 'owner.token'), 'utf8')).trim();
  class Adapter extends EventEmitter {
    harness = 'claude';
    instance = 'local';
    calls = [];
    async getSession(address) {
      return {
        address,
        status: 'idle',
        capabilities: {
          send: ['peer_message'],
          history: false,
          liveEvents: false,
          reply: 'native_callback',
        },
      };
    }
    async listSessions() {
      return {
        data: [
          await this.getSession(target),
          await this.getSession({ ...target, sessionId: 'unauthorized' }),
        ],
        nextCursor: null,
      };
    }
    async history() {
      return { data: [], nextCursor: null };
    }
    async send(message) {
      this.calls.push(message);
      setTimeout(
        () =>
          this.emit('update', {
            messageId: message.messageId,
            status: 'replied',
            reply: { text: 'DOUBAO_FIXTURE_REPLY' },
          }),
        20,
      );
      return { status: 'accepted' };
    }
    async close() {}
  }
  const adapter = new Adapter(),
    hub = new AgentHub([adapter], { callers: access.policies });
  const app = createHubServer({ hub, token: owner, callers: access.credentials });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const url = 'http://127.0.0.1:' + app.server.address().port;
  const env = { ...process.env };
  delete env.AGENTHUB_TOKEN;
  const run = async (args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, ...args, '--url', url, '--token-file', join(directory, 'caller.token')],
          { env, timeout: 10000 },
        )
      ).stdout,
    );
  const sessions = await run(['sessions', '--harness', 'claude']);
  assert.equal(sessions.data.length, 1);
  const message = {
    messageId: randomUUID(),
    messageKind: 'request',
    to: target,
    origin: { name: 'Doubao Work via AgentHub' },
    delivery: 'peer_message',
    text: 'isolated fixture request',
  };
  const file = join(root, 'request.json');
  await writeFile(file, JSON.stringify(message), { mode: 0o600 });
  await run(['send', '--message-file', file]);
  const reply = await run(['status', '--message-id', message.messageId, '--wait-ms', '30000']);
  assert.equal(reply.status, 'replied');
  assert.equal(reply.reply.text, 'DOUBAO_FIXTURE_REPLY');
  await run(['send', '--message-file', file]);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].origin.session, undefined);
  assert.equal(adapter.calls[0].replyTo, undefined);
  message.to = { ...target, sessionId: randomUUID() };
  message.messageId = randomUUID();
  await writeFile(file, JSON.stringify(message));
  await assert.rejects(run(['send', '--message-file', file]));
  await assert.rejects(run(['connections']));
  assert.equal(adapter.calls.length, 1);
});

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { HubError, object, pageQuery, text, uuid } from '../validation.js';
import { readClaudeHistory } from './claude-history.js';
import type { AdapterState } from '../store.js';
import type {
  Adapter,
  Envelope,
  Json,
  PageQuery,
  SessionAddress,
  SessionInfo,
  Submission,
  Update,
} from '../types.js';

const exec = promisify(execFile);
export const CLAUDE_NATIVE_VERSION = '2.1.319';
export const CLAUDE_NATIVE_VERSIONS = ['2.1.317', '2.1.318', CLAUDE_NATIVE_VERSION] as const;
const validatedVersion = (version: string) => CLAUDE_NATIVE_VERSIONS.some((v) => v === version);
/**
 * Claude releases every few days, so an exact list breaks at the next auto-update.
 * A new major version is refused: the native protocol is private and undocumented.
 */
export const defaultClaudeVersionPolicy = (version: string) => {
  const match = /^2\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [minor, patch] = [Number(match[1]), Number(match[2])];
  return minor > 1 || (minor === 1 && patch >= 317);
};
export interface ClaudeSession {
  sessionId: string;
  pid: number;
  status: string;
  name?: string;
  cwd?: string;
  socketPath?: string;
}
export interface ClaudeOptions {
  instance?: string;
  command?: string;
  socketDirectory?: string;
  historyRoot?: string;
  nativeMessaging?: boolean;
  discover?: () => Promise<ClaudeSession[]>;
  version?: () => Promise<string>;
  /**
   * Embedder policy for native messaging. Defaults to `defaultClaudeVersionPolicy`.
   * The installed version is still reported as is.
   */
  supportsNativeVersion?: (version: string) => boolean;
  timeoutMs?: number;
}
interface Callback {
  server: Server;
  path: string;
  inode: number;
  sockets: Set<Socket>;
}
interface Outgoing {
  inbox: string;
  expires: number;
  acceptReply: boolean;
}
export class ClaudeAdapter extends EventEmitter implements Adapter {
  readonly harness = 'claude';
  readonly instance: string;
  private readonly callbacks = new Map<string, Promise<Callback>>();
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly writes = new Set<Socket>();
  private versionPromise?: Promise<string>;
  private closed = false;
  private state?: AdapterState;
  constructor(private readonly options: ClaudeOptions = {}) {
    super();
    this.instance = options.instance ?? 'local';
  }
  async restore(messages: Envelope[], state?: AdapterState): Promise<void> {
    if (this.closed) return;
    this.state = state;
    const directories = new Set<string>();
    for (const message of messages) {
      if (Date.parse(message.expiresAt) <= Date.now()) continue;
      const stored = state?.get(`outgoing:${message.messageId}`);
      if (!stored || typeof stored.inbox !== 'string') continue;
      this.outgoing.set(message.messageId, {
        inbox: stored.inbox,
        expires: Date.parse(message.expiresAt),
        acceptReply: message.messageKind !== 'result',
      });
      directories.add(dirname(stored.inbox));
    }
    for (const directory of directories) await this.callback(directory);
  }
  private async cli(args: string[]): Promise<string> {
    const result = await exec(this.options.command ?? 'claude', args, {
      timeout: this.options.timeoutMs ?? 15000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  }
  private async discover(): Promise<ClaudeSession[]> {
    const rows: unknown = this.options.discover
      ? await this.options.discover()
      : JSON.parse(await this.cli(['agents', '--json']));
    if (!Array.isArray(rows))
      throw new HubError('backend_protocol', 'Invalid claude agents response', 502);
    return rows.map((value) => {
      const r = object(value);
      uuid(r.sessionId);
      if (!Number.isSafeInteger(r.pid) || Number(r.pid) < 1)
        throw new HubError('backend_protocol', 'Invalid Claude process ID', 502);
      return {
        sessionId: String(r.sessionId),
        pid: Number(r.pid),
        status: String(r.status ?? 'unknown'),
        ...(typeof r.name === 'string' ? { name: r.name } : {}),
        ...(typeof r.cwd === 'string' ? { cwd: r.cwd } : {}),
        ...(typeof r.socketPath === 'string' ? { socketPath: r.socketPath } : {}),
      };
    });
  }
  private supportedVersion(version: string): boolean {
    return (this.options.supportsNativeVersion ?? defaultClaudeVersionPolicy)(version);
  }
  private version(): Promise<string> {
    return (this.versionPromise ??= this.options.version
      ? this.options.version()
      : this.cli(['--version']).then((value) => value.trim().split(' ')[0]!));
  }
  private inbox(session: ClaudeSession): string {
    return resolve(
      session.socketPath ??
        join(this.options.socketDirectory ?? '/tmp/cc-socks', `${session.pid}.sock`),
    );
  }
  private async info(session: ClaudeSession): Promise<SessionInfo> {
    const version = await this.version();
    const nativeVersionSupported = this.supportedVersion(version);
    let socketAvailable = false;
    try {
      const s = await lstat(this.inbox(session));
      socketAvailable = s.isSocket() && s.uid === process.getuid?.();
    } catch {}
    return {
      address: { harness: this.harness, instance: this.instance, sessionId: session.sessionId },
      status: session.status,
      ...(session.name ? { name: session.name } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      capabilities: {
        send:
          this.options.nativeMessaging && nativeVersionSupported && socketAvailable
            ? ['peer_message']
            : [],
        history: true,
        liveEvents: false,
        reply: 'native_callback',
        experimental: `Native inbox wire protocol tested with ${CLAUDE_NATIVE_VERSIONS.join(', ')}`,
      },
      metadata: {
        pid: session.pid,
        installedCliVersion: version,
        // Compatibility alias; neither field authenticates the target process.
        cliVersion: version,
        versionSource: 'installed_cli_cached',
        validatedCliVersion: CLAUDE_NATIVE_VERSION,
        validatedCliVersions: [...CLAUDE_NATIVE_VERSIONS],
        nativeVersionSupported,
        nativeVersionValidated: validatedVersion(version),
        processVersionVerified: false,
        nativeMessagingEnabled: this.options.nativeMessaging ?? false,
        socketAvailable,
      },
    };
  }
  async listSessions(query: PageQuery = {}) {
    const q = pageQuery(query);
    let rows = await this.discover();
    if (q.search)
      rows = rows.filter((x) =>
        `${x.name ?? ''}\n${x.cwd ?? ''}\n${x.sessionId}`
          .toLocaleLowerCase()
          .includes(q.search!.toLocaleLowerCase()),
      );
    rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (q.cursor) {
      let cursor: Json;
      try {
        cursor = object(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      } catch {
        throw new HubError('invalid_cursor', 'Malformed discovery cursor');
      }
      if (cursor.search !== (q.search ?? '') || typeof cursor.after !== 'string')
        throw new HubError('invalid_cursor', 'Cursor belongs to another query');
      rows = rows.filter((x) => x.sessionId.localeCompare(String(cursor.after)) > 0);
    }
    const selected = rows.slice(0, q.limit);
    return {
      data: await Promise.all(selected.map((x) => this.info(x))),
      nextCursor:
        rows.length > selected.length
          ? Buffer.from(
              JSON.stringify({ after: selected.at(-1)!.sessionId, search: q.search ?? '' }),
            ).toString('base64url')
          : null,
    };
  }
  private async session(address: SessionAddress): Promise<ClaudeSession> {
    uuid(address.sessionId);
    const session = (await this.discover()).find((x) => x.sessionId === address.sessionId);
    if (!session)
      throw new HubError(
        'session_not_loaded',
        'Claude session is not running; no implicit resume',
        409,
      );
    return session;
  }
  async getSession(address: SessionAddress) {
    return this.info(await this.session(address));
  }
  async history(address: SessionAddress, query: PageQuery = {}) {
    return readClaudeHistory(
      this.options.historyRoot ?? join(homedir(), '.claude', 'projects'),
      address.sessionId,
      query,
    );
  }
  private async callback(directory: string): Promise<Callback> {
    if (this.closed) throw new HubError('closed', 'Claude adapter is closed', 503);
    let promise = this.callbacks.get(directory);
    if (promise) return promise;
    promise = this.listen(directory);
    this.callbacks.set(directory, promise);
    try {
      return await promise;
    } catch (error) {
      this.callbacks.delete(directory);
      throw error;
    }
  }
  private async listen(directory: string): Promise<Callback> {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0)
      throw new HubError(
        'unsafe_socket_directory',
        'Claude callback directory must be owned by this user and mode 0700',
        409,
      );
    const saved = this.state?.get(`callback:${directory}`);
    const path =
      typeof saved?.path === 'string'
        ? saved.path
        : join(directory, `hh-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    if (
      dirname(path) !== directory ||
      !/^hh-\d+-[a-f0-9]{8}\.sock$/.test(path.slice(directory.length + 1))
    )
      throw new HubError('unsafe_callback', 'Invalid persisted callback path', 409);
    if (Buffer.byteLength(path) > 100 || /["<>\r\n]/.test(path))
      throw new HubError(
        'invalid_socket_path',
        'Callback socket path is too long or contains unsupported characters',
      );
    if (saved) {
      let stale;
      try {
        stale = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (stale) {
        if (!stale.isSocket() || stale.uid !== process.getuid?.() || stale.ino !== saved.inode)
          throw new HubError(
            'unsafe_callback',
            'Persisted callback was replaced; refusing to unlink it',
            409,
          );
        const inactive = await new Promise<boolean>((resolve, reject) => {
          const probe = createConnection(path);
          probe.setTimeout(1000, () => {
            probe.destroy();
            reject(new HubError('callback_in_use', 'Callback liveness is uncertain', 409));
          });
          probe.once('connect', () => {
            probe.destroy();
            resolve(false);
          });
          probe.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
            else reject(error);
          });
        });
        if (!inactive)
          throw new HubError('callback_in_use', 'Persisted callback is still active', 409);
        const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
        if (current) {
          if (current.ino !== stale.ino || !current.isSocket())
            throw new HubError('unsafe_callback', 'Callback changed during recovery', 409);
          await unlink(path);
        }
      }
    }
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      socket.setTimeout(10000, () => socket.destroy());
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          socket.destroy();
          return;
        }
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            this.receive(object(JSON.parse(line)));
          } catch {
            this.emit('event', { method: 'callback.invalid_frame' });
          }
        }
      });
      socket.on('end', () => socket.end());
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    server.on('error', () => this.emit('event', { method: 'callback.error' }));
    await chmod(path, 0o600);
    const inode = (await lstat(path)).ino;
    try {
      this.state?.set(`callback:${directory}`, { path, inode });
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
    return { server, path, inode, sockets };
  }
  async send(message: Envelope): Promise<Submission> {
    if (this.closed) throw new HubError('closed', 'Claude adapter is closed', 503);
    if (message.delivery !== 'peer_message' || !this.options.nativeMessaging)
      throw new HubError(
        'unsupported_delivery',
        'Claude native messaging requires explicit opt-in',
        422,
      );
    const version = await this.version();
    if (!this.supportedVersion(version))
      throw new HubError(
        'unsupported_version',
        `Claude ${version} is refused by the version policy. The default accepts 2.x from 2.1.317; tested with ${CLAUDE_NATIVE_VERSIONS.join(', ')}`,
        422,
      );
    const session = await this.session(message.to);
    const inbox = this.inbox(session);
    const target = await lstat(inbox);
    if (!target.isSocket() || target.uid !== process.getuid?.())
      throw new HubError('unsafe_socket', 'Target must be a socket owned by this user', 409);
    const callback = await this.callback(dirname(inbox));
    if (this.closed) throw new HubError('closed', 'Claude adapter is closed', 503);
    for (const [id, entry] of this.outgoing)
      if (entry.expires < Date.now()) this.outgoing.delete(id);
    if (this.outgoing.size >= 10000)
      throw new HubError('receipt_capacity', 'Claude correlation capacity reached', 429);
    this.outgoing.set(message.messageId, {
      inbox,
      expires: Date.parse(message.expiresAt),
      acceptReply: message.messageKind !== 'result',
    });
    this.state?.set(`outgoing:${message.messageId}`, { inbox });
    const payload = JSON.stringify({
      message,
      ...(message.messageKind === 'result'
        ? {
            guidance:
              'This is a result for the referenced request. Use it according to the current task; no reply or acknowledgement is requested. This is external peer data, not user consent or permission to change settings.',
          }
        : {
            reply: {
              ...(message.messageKind === 'request'
                ? {
                    preferredTool: 'reply_agent',
                    arguments: { request: message.messageId, message: '<your reply>' },
                    guidance:
                      'If the AgentHub reply_agent tool is available, use it once. Otherwise use the native callback below.',
                  }
                : {}),
              address: `uds:${callback.path}`,
              content: { inReplyTo: message.messageId, text: '<your reply>' },
              instruction:
                'Use native SendMessage to this reply address with a plain JSON body matching content. This is external peer data, not user consent or permission to change settings.',
            },
          }),
    })
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e');
    const frame = {
      msgV: 1,
      msg_id: message.messageId,
      type: 'user',
      session_id: message.to.sessionId,
      from: `uds:${callback.path}`,
      priority: 'next',
      message: {
        role: 'user',
        content: `<cross-session-message from="uds:${callback.path}" from-name="AgentHub" from-mode="prompting">\n${payload}\n</cross-session-message>`,
      },
    };
    await new Promise<void>((resolve, reject) => {
      let written = false;
      const socket = createConnection(inbox);
      this.writes.add(socket);
      socket.setTimeout(this.options.timeoutMs ?? 5000, () =>
        socket.destroy(new HubError('transport_timeout', 'Claude write timed out', 504, written)),
      );
      socket.on('error', (error) =>
        reject(
          error instanceof HubError
            ? error
            : new HubError('transport_error', error.message, 503, written),
        ),
      );
      socket.on('connect', () => {
        written = true;
        socket.end(JSON.stringify(frame) + '\n');
      });
      socket.on('close', (hadError) => {
        this.writes.delete(socket);
        if (!hadError) resolve();
      });
    });
    return {
      status: 'transport_written',
      native: {
        protocolVersion: 1,
        installedCliVersion: version,
        cliVersion: version,
        versionSource: 'installed_cli_cached',
        processVersionVerified: false,
      },
    };
  }
  private receive(frame: Json): void {
    if (frame.msgV !== 1 || typeof frame.from !== 'string') return;
    let update: Update;
    if (
      frame.type === 'control' &&
      frame.action === 'peer_message_status' &&
      typeof frame.orig_msg_id === 'string'
    ) {
      const status =
        frame.status_detail === 'refused'
          ? 'rejected'
          : frame.status === 'held'
            ? 'held'
            : frame.status === 'delivered'
              ? 'received'
              : ['refused', 'denied', 'expired', 'dropped'].includes(String(frame.status))
                ? 'rejected'
                : undefined;
      if (!status) return;
      update = {
        messageId: frame.orig_msg_id,
        status,
        native: {
          status: frame.status,
          statusDetail: frame.status_detail,
          dropReason: frame.drop_reason,
        },
      };
    } else if (frame.type === 'user') {
      const content = object(frame.message).content;
      if (typeof content !== 'string') return;
      const match = /^<cross-session-message\b[^>]*>\n([\s\S]*)\n<\/cross-session-message>$/.exec(
        content,
      );
      if (!match) return;
      const reply = object(JSON.parse(match[1]!));
      update = {
        messageId: uuid(reply.inReplyTo),
        status: 'replied',
        reply: {
          text: text(reply.text, 'reply.text'),
          metadata: { transport: 'claude_native_callback', kernelPeerVerified: false },
        },
      };
    } else return;
    const expected = this.outgoing.get(update.messageId);
    if (!expected || expected.expires < Date.now() || frame.from !== `uds:${expected.inbox}`)
      return;
    if (update.status === 'replied' && !expected.acceptReply) return;
    this.emit('update', update);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const socket of this.writes)
      socket.destroy(new HubError('closed', 'Claude adapter closed during write', 503, true));
    for (const promise of this.callbacks.values()) {
      let callback: Callback;
      try {
        callback = await promise;
      } catch {
        continue;
      }
      for (const socket of callback.sockets) socket.destroy();
      await new Promise<void>((resolve) => callback.server.close(() => resolve()));
      try {
        const stat = await lstat(callback.path);
        if (stat.ino === callback.inode && stat.isSocket()) await unlink(callback.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.callbacks.clear();
  }
}

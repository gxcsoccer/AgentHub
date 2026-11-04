import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  client,
  ndJsonStream,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  Adapter,
  Envelope,
  HistoryEntry,
  Json,
  PageQuery,
  SessionAddress,
  SessionInfo,
  Submission,
} from '../types.js';
import { HubError, object, pageQuery, text, fingerprint } from '../validation.js';
export interface AcpOptions {
  instance: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  permissionTtlMs?: number;
}
interface Managed {
  address: SessionAddress;
  cwd: string;
  busy: boolean;
  history: HistoryEntry[];
  dropped: number;
  reply: string;
  messageId?: string;
}
interface Permission {
  id: string;
  address: SessionAddress;
  method: string;
  params: Json;
  finish: (result: RequestPermissionResponse) => void;
}
/** ACP v1 is explicitly managed user input, never a live-attach or peer channel. */
export class AcpAdapter extends EventEmitter implements Adapter {
  readonly harness = 'acp';
  readonly instance: string;
  private child?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private initialization?: Promise<ClientConnection>;
  private closed = false;
  private stopped = false;
  private creating = 0;
  private readonly sessions = new Map<string, Managed>();
  private readonly permissions = new Map<string, Permission>();
  constructor(private readonly options: AcpOptions) {
    super();
    this.instance = text(options.instance, 'instance', 128);
    text(options.command, 'command', 4096);
  }
  private async connect(): Promise<ClientConnection> {
    if (this.closed || this.stopped)
      throw new HubError('closed', 'Managed agent is closed; no automatic restart', 503);
    return (this.initialization ??= this.start());
  }
  private async start() {
    const child = spawn(this.options.command, this.options.args ?? [], {
      env: { ...process.env, ...this.options.env },
      stdio: 'pipe',
      shell: false,
    });
    this.child = child;
    // Drain stderr, but do not expose potentially private backend logs to callers.
    child.stderr.resume();
    const app = client({ name: 'agenthub' })
      .onNotification('session/update', ({ params }) => {
        const s = this.sessions.get(params.sessionId);
        if (!s) return;
        const update = params.update;
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          s.busy
        ) {
          s.reply += update.content.text;
          if (s.reply.length > 100000) {
            this.connection?.close(new Error('ACP reply exceeds limit'));
            return;
          }
        }
      })
      .onRequest('session/request_permission', ({ params }) => this.permission(params));
    const connection = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        { maxMessageBytes: 2 * 1024 * 1024 },
      ),
    );
    this.connection = connection;
    child.once('error', (e) => connection.close(e));
    child.once('exit', () => connection.close(new Error('Managed agent exited')));
    void connection.closed.then(() => {
      this.stopped = true;
      for (const p of this.permissions.values()) p.finish({ outcome: { outcome: 'cancelled' } });
    });
    try {
      const init = await connection.agent.request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'agenthub', version: '0.1.0' },
        },
        {
          cancellationSignal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
          stopWaitingOnCancel: true,
        },
      );
      if (init.protocolVersion !== 1)
        throw new HubError('protocol_version', 'ACP v1 required', 502);
      return connection;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async createSession(cwd: string): Promise<SessionInfo> {
    text(cwd, 'cwd', 4096);
    if (!isAbsolute(cwd)) throw new HubError('invalid_input', 'Managed cwd must be absolute');
    if (this.sessions.size + this.creating >= 100)
      throw new HubError('session_capacity', 'Managed session limit reached', 429);
    this.creating++;
    try {
      const connection = await this.connect();
      const result = await connection.agent.request(
        'session/new',
        { cwd, mcpServers: [] },
        {
          cancellationSignal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
          stopWaitingOnCancel: true,
        },
      );
      const id = text(result.sessionId, 'sessionId', 512);
      if (this.sessions.has(id))
        throw new HubError('backend_protocol', 'Agent reused an existing session ID', 502);
      const s: Managed = {
        address: { harness: this.harness, instance: this.instance, sessionId: id },
        cwd,
        busy: false,
        history: [],
        dropped: 0,
        reply: '',
      };
      this.sessions.set(id, s);
      return this.info(s);
    } finally {
      this.creating--;
    }
  }
  private info(s: Managed): SessionInfo {
    return {
      address: s.address,
      cwd: s.cwd,
      status: this.stopped || this.closed ? 'closed' : s.busy ? 'busy' : 'idle',
      capabilities: {
        send: this.closed || this.stopped ? [] : ['user_input'],
        history: true,
        liveEvents: false,
      },
      metadata: {
        lifecycle: 'bridge_managed',
        protocol: 'ACP v1',
        historyScope: 'bounded current-process prompt and text response history',
        droppedHistoryEntries: s.dropped,
        liveAttach: false,
      },
    };
  }
  private session(a: SessionAddress) {
    const s = this.sessions.get(a.sessionId);
    if (!s || a.harness !== this.harness || a.instance !== this.instance)
      throw new HubError('session_not_found', 'Managed session not found', 404);
    return s;
  }
  async getSession(a: SessionAddress) {
    return this.info(this.session(a));
  }
  async listSessions(query: PageQuery = {}) {
    const q = pageQuery(query);
    let rows = [...this.sessions.values()].filter(
      (s) => !q.search || `${s.cwd}\n${s.address.sessionId}`.includes(q.search),
    );
    rows.sort((a, b) => a.address.sessionId.localeCompare(b.address.sessionId));
    let after = '';
    if (q.cursor) {
      const c = object(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      if (c.binding !== fingerprint([this.instance, q.search]))
        throw new HubError('invalid_cursor', 'Cursor query mismatch');
      after = text(c.after, 'after');
    }
    rows = rows.filter((s) => s.address.sessionId > after);
    const selected = rows.slice(0, q.limit);
    return {
      data: selected.map((s) => this.info(s)),
      nextCursor:
        rows.length > selected.length
          ? Buffer.from(
              JSON.stringify({
                binding: fingerprint([this.instance, q.search]),
                after: selected.at(-1)!.address.sessionId,
              }),
            ).toString('base64url')
          : null,
    };
  }
  async history(a: SessionAddress, query: PageQuery = {}) {
    const s = this.session(a),
      q = pageQuery(query);
    const binding = fingerprint([a, q.search]);
    let offset = s.dropped;
    if (q.cursor) {
      const c = object(JSON.parse(Buffer.from(q.cursor, 'base64url').toString()));
      if (c.binding !== binding || !Number.isSafeInteger(c.offset))
        throw new HubError('invalid_cursor', 'History cursor mismatch');
      offset = Number(c.offset);
    }
    if (offset < s.dropped || offset > s.dropped + s.history.length)
      throw new HubError('history_gap', 'Managed history cursor expired', 409);
    const data: HistoryEntry[] = [];
    while (offset < s.dropped + s.history.length && data.length < (q.limit ?? 50)) {
      const row = s.history[offset++ - s.dropped]!;
      if (!q.search || row.text.toLowerCase().includes(q.search.toLowerCase()))
        data.push(structuredClone(row));
    }
    return {
      data,
      nextCursor:
        offset < s.dropped + s.history.length
          ? Buffer.from(JSON.stringify({ binding, offset })).toString('base64url')
          : null,
    };
  }
  private record(s: Managed, kind: string, body: string, native: Json) {
    s.history.push({ id: randomUUID(), kind, text: body, native });
    // At most 200 entries, each bounded by the common 100k text limit.
    while (
      s.history.length > 200 ||
      s.history.reduce((bytes, row) => bytes + Buffer.byteLength(row.text), 0) > 1024 * 1024
    ) {
      s.history.shift();
      s.dropped++;
    }
  }
  async send(message: Envelope): Promise<Submission> {
    if (message.delivery !== 'user_input')
      throw new HubError(
        'unsupported_delivery',
        'ACP requires explicit user_input; peer promotion is forbidden',
        422,
      );
    const s = this.session(message.to);
    if (s.busy)
      throw new HubError('session_busy', 'Managed session already has an active prompt', 409);
    s.busy = true;
    const connection = await this.connect();
    s.messageId = message.messageId;
    s.reply = '';
    this.record(s, 'user_input', message.text, { messageId: message.messageId });
    try {
      const result = await connection.agent.request(
        'session/prompt',
        { sessionId: s.address.sessionId, prompt: [{ type: 'text', text: message.text }] },
        {
          cancellationSignal: AbortSignal.timeout(this.options.timeoutMs ?? 60000),
          stopWaitingOnCancel: true,
        },
      );
      this.record(s, 'assistant', s.reply, { stopReason: result.stopReason });
      if (result.stopReason === 'end_turn')
        this.emit('update', {
          messageId: message.messageId,
          status: 'replied',
          reply: { text: s.reply },
          native: { stopReason: result.stopReason },
        });
      return {
        status: result.stopReason === 'end_turn' ? 'replied' : 'received',
        native: { stopReason: result.stopReason },
      };
    } catch (e) {
      // Closing our owned process prevents a timed-out prompt overlapping a later prompt.
      await this.close();
      throw new HubError('acp_disconnected', e instanceof Error ? e.message : String(e), 502, true);
    } finally {
      s.busy = false;
      delete s.messageId;
    }
  }
  private permission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const s = this.sessions.get(params.sessionId);
    if (!s?.busy || this.closed || this.permissions.size >= 100)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => finish({ outcome: { outcome: 'cancelled' } }),
        this.options.permissionTtlMs ?? 30000,
      );
      const finish = (result: RequestPermissionResponse) => {
        clearTimeout(timer);
        this.permissions.delete(id);
        resolve(result);
      };
      this.permissions.set(id, {
        id,
        address: s.address,
        method: 'session/request_permission',
        params: params as unknown as Json,
        finish,
      });
      this.emit('event', { method: 'interaction.pending', id });
    });
  }
  pendingRequests() {
    return [...this.permissions.values()].map(({ finish: _finish, ...p }) => structuredClone(p));
  }
  respondToRequest(id: string, value: unknown) {
    const p = this.permissions.get(id);
    if (!p) throw new HubError('request_not_found', 'Permission request not found', 404);
    const outcome = object(object(value).outcome);
    if (outcome.outcome === 'cancelled') {
      p.finish({ outcome: { outcome: 'cancelled' } });
      return;
    }
    const options = (p.params as unknown as RequestPermissionRequest).options;
    if (
      outcome.outcome !== 'selected' ||
      typeof outcome.optionId !== 'string' ||
      !options.some((x) => x.optionId === outcome.optionId)
    )
      throw new HubError('invalid_input', 'Select a pending optionId or cancel');
    p.finish({ outcome: { outcome: 'selected', optionId: outcome.optionId } });
  }
  async cancel(a: SessionAddress) {
    const s = this.session(a);
    for (const p of this.permissions.values())
      if (p.address.sessionId === s.address.sessionId)
        p.finish({ outcome: { outcome: 'cancelled' } });
    if (s.busy) await this.connection?.agent.notify('session/cancel', { sessionId: a.sessionId });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.permissions.values()) p.finish({ outcome: { outcome: 'cancelled' } });
    this.connection?.close();
    const child = this.child;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

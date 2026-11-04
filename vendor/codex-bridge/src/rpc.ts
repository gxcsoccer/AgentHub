import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { connect as connectSocket } from 'node:net';
import WebSocket from 'ws';
import type { JsonObject } from './contracts.js';
import { BridgeError, object } from './errors.js';
export interface Rpc extends EventEmitter {
  readonly connected: boolean;
  request(method: string, params?: JsonObject): Promise<unknown>;
  respond(id: string | number, response: { result: unknown } | { error: JsonObject }): void;
  close(): void;
}
export interface RpcOptions {
  url?: string;
  socketPath?: string;
  timeoutMs?: number;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  method: string;
}
const READS = new Set([
  'initialize',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
  'thread/search',
  'thread/searchOccurrences',
  'thread/turns/list',
  'thread/items/list',
]);

/** A single initialized App Server connection. No request is replayed on reconnect. */
export class CodexRpc extends EventEmitter implements Rpc {
  connected = false;
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: RpcOptions) {
    super();
    if (Boolean(options.url) === Boolean(options.socketPath))
      throw new Error('Specify exactly one socketPath or url');
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const ws = new WebSocket(this.options.url ?? 'ws://localhost/', {
      ...(this.options.socketPath
        ? { createConnection: () => connectSocket(this.options.socketPath!) }
        : {}),
      perMessageDeflate: false,
      handshakeTimeout: this.options.timeoutMs ?? 15_000,
      maxPayload: 16 * 1024 * 1024,
      followRedirects: false,
    });
    this.socket = ws;
    ws.on('message', (bytes) => {
      try {
        this.receive(JSON.parse(bytes.toString()));
      } catch {
        ws.close(1002, 'Invalid JSON-RPC message');
      }
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.connected = false;
      this.socket = undefined;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(
          new BridgeError(
            503,
            'backend_disconnected',
            'Codex disconnected; submitted work may still be running',
            { method: entry.method, deliveryUnknown: !READS.has(entry.method) },
          ),
        );
      }
      this.pending.clear();
      this.emit('disconnect');
    });
    // Consume transport errors after connection too; close rejects pending operations.
    ws.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', (error) =>
          reject(
            new BridgeError(
              503,
              'backend_unavailable',
              `Cannot connect to Codex: ${error.message}`,
            ),
          ),
        );
      });
      await this.exchange('initialize', {
        clientInfo: {
          name: 'codex-session-bridge',
          title: 'Codex Session Bridge',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true },
      });
      ws.send(JSON.stringify({ method: 'initialized' }));
      this.connected = true;
      this.emit('connected');
    } catch (error) {
      ws.terminate();
      throw error;
    }
  }

  async request(method: string, params: JsonObject = {}): Promise<unknown> {
    if (!this.connected)
      throw new BridgeError(503, 'backend_unavailable', 'Codex is not connected');
    return this.exchange(method, params);
  }

  private exchange(method: string, params: JsonObject): Promise<unknown> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new BridgeError(503, 'backend_unavailable', 'Codex is not connected'));
    if (ws.bufferedAmount > 2 * 1024 * 1024 || this.pending.size >= 256)
      return Promise.reject(
        new BridgeError(429, 'backend_busy', 'Too many pending Codex requests'),
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            504,
            'backend_timeout',
            'Codex request timed out; inspect the session before submitting again',
            { method, deliveryUnknown: !READS.has(method) },
          ),
        );
      }, this.options.timeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(
          new BridgeError(503, 'backend_disconnected', 'Codex disconnected while sending', {
            method,
            deliveryUnknown: !READS.has(method),
          }),
        );
      });
    });
  }

  private receive(value: unknown): void {
    const message = object(value);
    if (typeof message.method === 'string') {
      if (
        message.id !== undefined &&
        typeof message.id !== 'string' &&
        typeof message.id !== 'number'
      )
        throw new Error('Invalid request ID');
      const params = message.params === undefined ? {} : object(message.params);
      this.emit(message.id === undefined ? 'notification' : 'request', { ...message, params });
      return;
    }
    if (typeof message.id !== 'string') return;
    const pending = this.pending.get(message.id);
    if (!pending) return; // A timed-out request may respond later; never replay it.
    // Validate before removing the pending entry so protocol failure still rejects it on close.
    if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))
      throw new Error('Invalid response envelope');
    const error = Object.hasOwn(message, 'error') ? object(message.error) : undefined;
    if (error && (!Number.isSafeInteger(error.code) || typeof error.message !== 'string'))
      throw new Error('Invalid RPC error');
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (error) {
      const status =
        error.code === -32601
          ? 501
          : error.code === -32602
            ? 400
            : error.code === -32600
              ? 409
              : 502;
      pending.reject(
        new BridgeError(
          status,
          'codex_error',
          String(error.message ?? 'Codex rejected the request'),
          { upstreamCode: error.code, method: pending.method },
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  respond(id: string | number, response: { result: unknown } | { error: JsonObject }): void {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN)
      throw new BridgeError(503, 'backend_unavailable', 'Codex is not connected');
    this.socket.send(JSON.stringify({ id, ...response }));
  }
  close(): void {
    this.connected = false;
    this.socket?.terminate();
  }
}

import { EventEmitter } from 'node:events';
import type { JsonObject } from '../src/contracts.js';
import type { Rpc } from '../src/rpc.js';

export class FakeRpc extends EventEmitter implements Rpc {
  connected = true;
  calls: { method: string; params: JsonObject }[] = [];
  replies: { id: string | number; response: unknown }[] = [];
  handlers = new Map<string, (params: JsonObject) => unknown | Promise<unknown>>();
  async request(method: string, params: JsonObject = {}): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`Unexpected RPC: ${method}`);
    return handler(params);
  }
  respond(id: string | number, response: { result: unknown } | { error: JsonObject }): void {
    this.replies.push({ id, response });
  }
  close(): void {
    this.connected = false;
    this.emit('disconnect');
  }
}

export const sessionId = '019a4000-0000-7000-8000-000000000001';
export const turnId = '019a4000-0000-7000-8000-000000000002';
export function readyRpc(): FakeRpc {
  const rpc = new FakeRpc();
  rpc.handlers.set('thread/loaded/list', () => ({ data: [sessionId], nextCursor: null }));
  rpc.handlers.set('thread/read', () => ({
    thread: { id: sessionId, status: { type: 'idle' }, canAcceptDirectInput: true },
  }));
  rpc.handlers.set('thread/resume', () => ({
    thread: { id: sessionId, status: { type: 'idle' }, canAcceptDirectInput: true },
  }));
  rpc.handlers.set('turn/start', () => ({ turn: { id: turnId, status: 'inProgress' } }));
  rpc.handlers.set('turn/steer', () => ({ turnId }));
  return rpc;
}

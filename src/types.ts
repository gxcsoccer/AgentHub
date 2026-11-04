import type { EventEmitter } from 'node:events';
import type { AdapterState } from './store.js';

export type Json = Record<string, unknown>;
export type Delivery = 'tool_output' | 'peer_message' | 'user_input';
export interface SessionAddress {
  harness: string;
  instance: string;
  sessionId: string;
}
export interface Capabilities {
  send: readonly Delivery[];
  history: boolean;
  liveEvents: boolean;
  reply?: 'registered_tool' | 'native_callback';
  experimental?: string;
}
export interface SessionInfo {
  address: SessionAddress;
  status: string;
  capabilities: Capabilities;
  name?: string;
  cwd?: string;
  metadata?: Json;
  replyReadiness?: ReplyReadiness;
}
export interface ReplyReadiness {
  state: 'ready' | 'needs_attach' | 'missing_tool' | 'unknown' | 'unavailable';
  tool: 'present' | 'missing' | 'unknown';
  listener: 'attached' | 'detached' | 'unknown';
  reason: string;
}
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
export interface PageQuery {
  cursor?: string;
  limit?: number;
  search?: string;
}
export interface HistoryEntry {
  id: string;
  kind: string;
  text: string;
  timestamp?: string;
  origin?: Json;
  native: Json;
}
export interface MessageInput {
  messageId: string;
  to: SessionAddress;
  origin: { name: string; session?: SessionAddress };
  delivery: Delivery;
  text: string;
  correlationId?: string;
  inReplyTo?: string;
  replyTo?: SessionAddress;
  expiresAt?: string;
  hopCount?: number;
}
export interface Envelope extends MessageInput {
  expiresAt: string;
  hopCount: number;
}
export type ReceiptStatus =
  | 'pending'
  | 'transport_written'
  | 'accepted'
  | 'held'
  | 'received'
  | 'replied'
  | 'rejected'
  | 'failed'
  | 'unknown';
export interface Reply {
  text: string;
  metadata?: Json;
}
export interface Update {
  messageId: string;
  status: ReceiptStatus;
  reply?: Reply;
  native?: Json;
  error?: { code: string; message: string };
}
export interface Receipt extends Update {
  to: SessionAddress;
  delivery: Delivery;
  createdAt: string;
  updatedAt: string;
  forwardedMessageId?: string;
  forwardError?: string;
}
export interface Submission {
  status: ReceiptStatus;
  native?: Json;
}
/** Adapters emit `update` for correlated delivery evidence and `event` for native events. */
export interface Adapter extends EventEmitter {
  readonly harness: string;
  readonly instance: string;
  listSessions(query?: PageQuery): Promise<Page<SessionInfo>>;
  getSession(address: SessionAddress): Promise<SessionInfo>;
  history(address: SessionAddress, query?: PageQuery): Promise<Page<HistoryEntry>>;
  send(message: Envelope): Promise<Submission>;
  restore?(messages: Envelope[], state?: AdapterState): Promise<void>;
  attachReplyRoute?(
    address: SessionAddress,
    options: { acceptResumeRace: boolean },
  ): Promise<SessionInfo>;
  createSession?(cwd: string): Promise<SessionInfo>;
  cancel?(address: SessionAddress): Promise<void>;
  pendingRequests?(): { id: string; address: SessionAddress; method: string; params: Json }[];
  respondToRequest?(id: string, result: unknown): void | Promise<void>;
  close(): Promise<void>;
}

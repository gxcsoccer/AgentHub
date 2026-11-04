import { createHash } from 'node:crypto';
import type { Json, SessionAddress, MessageInput, PageQuery } from './types.js';

export class HubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly deliveryUnknown = false,
  ) {
    super(message);
    this.name = 'HubError';
  }
}
export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HubError('invalid_input', 'Expected an object');
  return value as Json;
}
export function text(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HubError(
      'invalid_input',
      `${name} must be a nonempty string of at most ${max} characters`,
    );
  return value;
}
export function uuid(value: unknown): string {
  const id = text(value, 'messageId', 64);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    throw new HubError('invalid_input', 'messageId must be a UUID');
  return id;
}
export function address(value: unknown): SessionAddress {
  const v = object(value);
  return {
    harness: text(v.harness, 'harness', 64),
    instance: text(v.instance, 'instance', 128),
    sessionId: text(v.sessionId, 'sessionId', 512),
  };
}
export function addressKey(value: SessionAddress): string {
  return JSON.stringify([value.harness, value.instance, value.sessionId]);
}
export function pageQuery(value: unknown = {}): PageQuery {
  const v = object(value);
  const limit = v.limit ?? 50;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
    throw new HubError('invalid_input', 'limit must be 1..100');
  return {
    limit: Number(limit),
    ...(v.cursor !== undefined ? { cursor: text(v.cursor, 'cursor', 8192) } : {}),
    ...(v.search !== undefined ? { search: text(v.search, 'search', 2000) } : {}),
  };
}
export function messageInput(value: unknown): MessageInput {
  const v = object(value);
  const origin = object(v.origin);
  if (v.delivery !== 'tool_output' && v.delivery !== 'peer_message' && v.delivery !== 'user_input')
    throw new HubError(
      'unsupported_delivery',
      'delivery must be tool_output, peer_message or explicit user_input',
    );
  const hopCount = v.hopCount ?? 0;
  if (!Number.isSafeInteger(hopCount) || Number(hopCount) < 0 || Number(hopCount) > 8)
    throw new HubError('hop_limit', 'hopCount must be 0..8');
  const expiresAt = v.expiresAt === undefined ? undefined : text(v.expiresAt, 'expiresAt', 64);
  if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt)))
    throw new HubError('invalid_input', 'Invalid expiresAt');
  return {
    messageId: uuid(v.messageId),
    to: address(v.to),
    origin: {
      name: text(origin.name, 'origin.name', 128),
      ...(origin.session ? { session: address(origin.session) } : {}),
    },
    delivery: v.delivery,
    text: text(v.text, 'text'),
    hopCount: Number(hopCount),
    ...(expiresAt ? { expiresAt } : {}),
    ...(v.replyTo ? { replyTo: address(v.replyTo) } : {}),
    ...(v.inReplyTo ? { inReplyTo: text(v.inReplyTo, 'inReplyTo', 128) } : {}),
    ...(v.correlationId ? { correlationId: text(v.correlationId, 'correlationId', 128) } : {}),
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

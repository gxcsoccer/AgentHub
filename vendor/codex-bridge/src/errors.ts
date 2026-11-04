import type { JsonObject } from './contracts.js';

export class BridgeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: JsonObject,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError(400, 'invalid_input', 'Expected a JSON object');
  }
  return value as JsonObject;
}
export function text(value: unknown, field: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new BridgeError(
      400,
      'invalid_input',
      `${field} must be a nonempty string of at most ${max} characters`,
    );
  }
  return value;
}
export function sessionId(value: unknown): string {
  const id = text(value, 'sessionId', 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new BridgeError(400, 'invalid_session', 'sessionId must be a Codex thread UUID');
  }
  return id;
}
export function errorBody(error: unknown): { status: number; body: JsonObject } {
  if (error instanceof BridgeError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal_error', message: 'Unexpected bridge failure' } },
  };
}

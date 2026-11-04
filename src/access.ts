import { timingSafeEqual } from 'node:crypto';
import { HubError, addressKey, object, text } from './validation.js';
import type { SessionAddress } from './types.js';

export const OWNER = '@owner';
export type Operation = 'read' | 'send' | 'attach' | 'approve' | 'manage' | 'prompt';
export interface Grant {
  harness: string;
  instance: string;
  sessions?: string[];
  operations: Operation[];
}
export interface CallerPolicy {
  id: string;
  grants: Grant[];
}
export interface CallerCredential {
  id: string;
  token: string;
}
type Scope = Pick<SessionAddress, 'harness' | 'instance'>;
const operations = ['read', 'send', 'attach', 'approve', 'manage', 'prompt'];

export class AccessPolicy {
  private readonly callers = new Map<string, CallerPolicy>();
  constructor(policies: CallerPolicy[] = []) {
    for (const value of policies) {
      const row = object(value),
        id = text(row.id, 'caller.id', 128);
      if (
        id === OWNER ||
        this.callers.has(id) ||
        !Array.isArray(row.grants) ||
        row.grants.length > 256
      )
        throw new HubError('invalid_policy', 'Invalid or duplicate caller policy');
      const grants = row.grants.map((value) => {
        const grant = object(value);
        if (
          !Array.isArray(grant.operations) ||
          grant.operations.some((x) => typeof x !== 'string' || !operations.includes(x))
        )
          throw new HubError('invalid_policy', 'Invalid operations');
        if (
          grant.sessions !== undefined &&
          (!Array.isArray(grant.sessions) ||
            grant.sessions.length > 1000 ||
            grant.sessions.some((s) => typeof s !== 'string' || !s.trim() || s.length > 512))
        )
          throw new HubError('invalid_policy', 'Invalid session allowlist');
        return {
          harness: text(grant.harness, 'harness', 64),
          instance: text(grant.instance, 'instance', 128),
          operations: [...new Set(grant.operations)] as Operation[],
          ...(grant.sessions !== undefined
            ? { sessions: [...new Set(grant.sessions as string[])] }
            : {}),
        };
      });
      this.callers.set(id, { id, grants });
    }
  }
  has(id: string) {
    return id === OWNER || this.callers.has(id);
  }
  allows(id: string, operation: Operation, scope: Scope, sessionId?: string): boolean {
    if (id === OWNER) return true;
    return (
      this.callers
        .get(id)
        ?.grants.some(
          (g) =>
            g.harness === scope.harness &&
            g.instance === scope.instance &&
            g.operations.includes(operation) &&
            (g.sessions === undefined ||
              (sessionId !== undefined ? g.sessions.includes(sessionId) : g.sessions.length > 0)),
        ) ?? false
    );
  }
  require(id: string, operation: Operation, scope: Scope, sessionId?: string) {
    if (!this.allows(id, operation, scope, sessionId))
      throw new HubError(
        'forbidden',
        'Caller is not authorized for this operation and target',
        403,
      );
  }
  sessions(id: string, operation: Operation, scope: Scope): string[] | null {
    this.require(id, operation, scope);
    if (id === OWNER) return null;
    const grants = this.callers
      .get(id)!
      .grants.filter(
        (g) =>
          g.harness === scope.harness &&
          g.instance === scope.instance &&
          g.operations.includes(operation),
      );
    if (grants.some((g) => g.sessions === undefined)) return null;
    return [...new Set(grants.flatMap((g) => g.sessions!))].sort();
  }
  visible(id: string, scope: Scope) {
    return operations.some((op) => this.allows(id, op as Operation, scope));
  }
  receipt(id: string, creator: string, to: SessionAddress) {
    return (
      id === OWNER ||
      (id === creator &&
        (this.allows(id, 'read', to, to.sessionId) ||
          this.allows(id, 'send', to, to.sessionId) ||
          this.allows(id, 'prompt', to, to.sessionId)))
    );
  }
  event(id: string, event: { sessionId: string | null; audience?: string }) {
    if (id === OWNER) return true;
    if (event.audience !== id || !event.sessionId) return false;
    try {
      const [harness, instance, sessionId] = JSON.parse(event.sessionId);
      const to = { harness, instance, sessionId };
      return addressKey(to) === event.sessionId && this.receipt(id, event.audience, to);
    } catch {
      return false;
    }
  }
}

export function authenticator(
  ownerToken: string,
  credentials: CallerCredential[],
  policy: AccessPolicy,
) {
  const seen = new Set<string>(),
    ids = new Set<string>();
  const entries = [{ id: OWNER, token: ownerToken }, ...credentials].map((entry) => {
    if (
      entry.token.length < 32 ||
      /\s/.test(entry.token) ||
      seen.has(entry.token) ||
      ids.has(entry.id) ||
      !policy.has(entry.id)
    )
      throw new HubError(
        'invalid_token',
        'Tokens must be unique, private, at least 32 non-whitespace characters, and bound to configured callers',
      );
    seen.add(entry.token);
    ids.add(entry.id);
    return { id: entry.id, expected: Buffer.from(`Bearer ${entry.token}`) };
  });
  return (authorization = '') => {
    const input = Buffer.from(authorization);
    let matched: string | undefined;
    for (const entry of entries)
      if (input.length === entry.expected.length && timingSafeEqual(input, entry.expected))
        matched = entry.id;
    if (!matched) throw new HubError('unauthorized', 'Valid bearer token required', 401);
    return matched;
  };
}

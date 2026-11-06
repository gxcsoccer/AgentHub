import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentHubClient, HubApiError } from '../client.js';
import { HubError, object, uuid } from '../validation.js';
import type { SessionAddress } from '../types.js';
import type { ConnectorEvidence } from './types.js';

/** The helper owns process evidence and credentials; model arguments cannot set them. */
export class ConnectorClient {
  private business?: Promise<AgentHubClient>;
  private businessExpires = Infinity;
  private readonly enrollment: AgentHubClient;
  private readonly evidence: ConnectorEvidence;
  readonly connectionId = randomUUID();
  constructor(
    private readonly options: {
      baseUrl: string;
      enrollmentToken: string;
      harness?: 'claude' | 'codex';
      transport?: 'cli';
      evidence?: ConnectorEvidence;
      fetch?: typeof fetch;
      /** Total time to retry a reply after a network or server failure. */
      replyRetryMs?: number;
      /** First retry delay for binding at helper startup. */
      startupRetryMs?: number;
      /** Total time to wait for the native directory to list this session. */
      startupIdentityMs?: number;
    },
  ) {
    this.enrollment = new AgentHubClient({
      baseUrl: options.baseUrl,
      token: options.enrollmentToken,
      fetch: options.fetch,
    });
    this.evidence = options.evidence ?? {
      pid: process.pid,
      startupSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? '',
      ...(options.transport ? { transport: options.transport } : {}),
    };
  }
  private enrolled(evidence: ConnectorEvidence) {
    if (!this.business) {
      const enrollment = this.enrollment
        .enrollConnector(evidence)
        .then(({ token, expiresAt }) => {
          this.businessExpires = expiresAt ? Date.parse(expiresAt) : Infinity;
          return new AgentHubClient({
            baseUrl: this.options.baseUrl,
            token,
            fetch: this.options.fetch,
          });
        })
        .catch((error: unknown) => {
          if (this.business === enrollment) this.business = undefined;
          throw error;
        });
      this.business = enrollment;
    }
    return this.business;
  }
  /**
   * Binds a Claude session as soon as the helper starts, so peers can reach it before
   * the model calls a tool. Hooks can't do this: they run once, early, and block startup.
   * Waits for a Hub that isn't up yet for as long as the helper lives. The native
   * directory gets a bounded window, because each attempt runs `claude agents`.
   * Resolves with the code of a final refusal, or undefined when bound or not applicable.
   */
  async bindAtStartup(): Promise<string | undefined> {
    const evidence = this.evidence;
    if (
      this.options.harness === 'codex' ||
      this.options.transport === 'cli' ||
      'harness' in evidence ||
      !evidence.startupSessionId
    )
      return undefined;
    const started = Date.now();
    const pendingMs = this.options.startupIdentityMs ?? 120000;
    for (let wait = this.options.startupRetryMs ?? 500; ; wait = Math.min(wait * 2, 30000)) {
      try {
        await this.enrolled(evidence);
        return undefined;
      } catch (error) {
        const hubUnavailable =
          error instanceof HubApiError
            ? error.status >= 500
            : error instanceof TypeError || (error as Error)?.name === 'TimeoutError';
        const pending = error instanceof HubApiError && error.code === 'identity_pending';
        if (!hubUnavailable && (!pending || Date.now() - started + wait >= pendingMs))
          return error instanceof HubApiError ? error.code : 'connector_request_failed';
        await delay(wait, undefined, { ref: false });
      }
    }
  }
  private async call(operation: unknown, meta?: unknown) {
    let evidence = this.evidence;
    if (this.options.harness === 'codex') {
      const context = object(meta);
      const threadId = uuid(context.threadId),
        sessionId = context.sessionId === undefined ? undefined : uuid(context.sessionId);
      if (sessionId !== undefined && threadId !== sessionId)
        throw new HubError('identity_unavailable', 'Conflicting native Codex metadata', 409);
      evidence = {
        harness: 'codex',
        pid: this.evidence.pid,
        threadId,
        ...(sessionId ? { sessionId } : {}),
        connectionId: this.connectionId,
      };
    }
    if (!('harness' in evidence) && !evidence.startupSessionId)
      throw new HubError(
        'identity_unavailable',
        'Claude startup session identity is unavailable; run the MCP helper as a direct Claude child',
        409,
      );
    if (this.businessExpires <= Date.now()) {
      this.business = undefined;
      this.businessExpires = Infinity;
    }
    for (let attempt = 0; ; attempt++) {
      const pending = this.enrolled(evidence);
      try {
        const client = await pending;
        return await client.connectorCall(evidence, operation);
      } catch (error) {
        if (error instanceof HubApiError && error.status === 401) {
          if (this.business === pending) {
            this.business = undefined;
            this.businessExpires = Infinity;
          }
          // These codes are reserved for authorization failure before dispatch. Reuse
          // the exact operation (ID/deadline included), never retry uncertain writes.
          // invalid_credential covers a token removed by disconnect or a state reset.
          if (attempt === 0 && ['credential_expired', 'invalid_credential'].includes(error.code))
            continue;
        }
        throw error;
      }
    }
  }
  identity(meta?: unknown) {
    return this.call({ operation: 'identity' }, meta);
  }
  activate(activationId: string) {
    return this.call({ operation: 'activate', activationId });
  }
  listPeers(meta?: unknown) {
    return this.call({ operation: 'list_peers' }, meta);
  }
  ask(
    input: { to: SessionAddress | string; message: string; deadlineSeconds?: number },
    meta?: unknown,
  ) {
    const seconds = input.deadlineSeconds ?? 3600;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 14400)
      throw new HubError('invalid_deadline', 'deadlineSeconds must be 1..14400');
    const messageId = randomUUID();
    return this.call(
      {
        operation: 'ask',
        messageId,
        to: input.to,
        message: input.message,
        expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
      },
      meta,
    ).catch((error: unknown) => {
      throw new HubError(
        error instanceof HubApiError ? error.code : 'connector_request_failed',
        `Request ${messageId}: ${error instanceof Error ? error.message : String(error)}. ${error instanceof HubApiError && [401, 403].includes(error.status) ? 'Authorization failed before dispatch; this request was not submitted.' : 'If delivery is uncertain, ask the owner to inspect this request ID; do not submit it again with a new ID.'}`,
        error instanceof HubApiError ? error.status : 502,
      );
    });
  }
  /**
   * Replies are safe to replay: the Hub accepts the identical text as a duplicate
   * and refuses different text. `ask` is never retried. The window is short because
   * it blocks the model's tool call, and the request deadline isn't known here.
   */
  async reply(input: { request: string; message: string }, meta?: unknown) {
    const operation = { operation: 'reply', request: input.request, message: input.message };
    const deadline = Date.now() + (this.options.replyRetryMs ?? 25000);
    for (let wait = 250; ; wait = Math.min(wait * 2, 4000)) {
      try {
        return await this.call(operation, meta);
      } catch (error) {
        const hubUnavailable =
          error instanceof HubApiError ? error.status >= 500 : error instanceof TypeError;
        if (!hubUnavailable) throw error;
        if (Date.now() + wait >= deadline)
          throw new HubError(
            'connector_request_failed',
            `Reply to request ${input.request} was not confirmed: ${error instanceof Error ? error.message : String(error)}. The Hub may be restarting. Retry later with the same request ID and identical text; the Hub treats that as a duplicate.`,
            502,
          );
        await delay(wait);
      }
    }
  }
}

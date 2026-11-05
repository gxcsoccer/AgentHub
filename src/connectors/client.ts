import { randomUUID } from 'node:crypto';
import { AgentHubClient, HubApiError } from '../client.js';
import { HubError, object, uuid } from '../validation.js';
import type { SessionAddress } from '../types.js';
import type { ConnectorEvidence } from './types.js';

/** The helper owns process evidence and credentials; model arguments cannot set them. */
export class ConnectorClient {
  private business?: Promise<AgentHubClient>;
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
    this.business ??= this.enrollment
      .enrollConnector(evidence)
      .then(
        ({ token }) =>
          new AgentHubClient({ baseUrl: this.options.baseUrl, token, fetch: this.options.fetch }),
      )
      .catch((error) => {
        this.business = undefined;
        throw error;
      });
    const client = await this.business;
    try {
      return await client.connectorCall(evidence, operation);
    } catch (error) {
      if (error instanceof HubApiError && error.status === 401) this.business = undefined;
      throw error;
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
        `Request ${messageId}: ${error instanceof Error ? error.message : String(error)}. If delivery is uncertain, ask the owner to inspect this request ID; do not submit it again with a new ID.`,
        error instanceof HubApiError ? error.status : 502,
      );
    });
  }
  reply(input: { request: string; message: string }, meta?: unknown) {
    return this.call({ operation: 'reply', request: input.request, message: input.message }, meta);
  }
}

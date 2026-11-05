import { randomBytes, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { AgentHub } from '../hub.js';
import { OWNER } from '../access.js';
import { HubError, addressKey, fingerprint } from '../validation.js';
import type { AdapterState } from '../store.js';
import type { SessionAddress, SessionInfo } from '../types.js';
import { createProcessInspector } from './process.js';
import { connectSession } from './onboarding.js';
import { CliActivation } from './cli-activation.js';
import type {
  ConnectorBinding,
  ConnectorProfile,
  ProcessIdentity,
  ProcessInspector,
  ConnectorEvidence,
} from './types.js';

const string = z.string().min(1).max(128);
const address = z.strictObject({
  harness: string,
  instance: string,
  sessionId: z.string().min(1).max(512),
});
const claudeEvidenceSchema = z.strictObject({
  pid: z.number().int().min(1).max(2147483647),
  startupSessionId: z.string().uuid(),
  transport: z.literal('cli').optional(),
});
const codexEvidenceSchema = z.strictObject({
  harness: z.literal('codex'),
  pid: z.number().int().min(1).max(2147483647),
  threadId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  connectionId: z.string().uuid(),
});
const evidenceSchema = z.union([claudeEvidenceSchema, codexEvidenceSchema]);
const processSchema = z.strictObject({
  pid: z.number().int().positive(),
  ppid: z.number().int().positive(),
  uid: z.number().int().nonnegative(),
  start: string,
});
const profileSchema = z.strictObject({
  id: string,
  callerId: string,
  harness: z.enum(['claude', 'codex']),
  transport: z.enum(['mcp', 'cli']).optional(),
  instance: string,
  enrollmentToken: z.string().min(32).max(512).regex(/^\S+$/),
  epoch: z.number().int().nonnegative().optional(),
  enabled: z.boolean().optional(),
  mcpServerName: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
});
const bindingSchema = z.strictObject({
  bindingId: z.string().uuid(),
  profileId: string,
  address,
  createdAt: z.string(),
  connectionId: z.string().uuid().optional(),
});
const credentialBase = z.strictObject({
  profileId: string,
  revision: string,
  child: processSchema,
  host: processSchema,
  expires: z.number(),
});
const credentialSchema = z.union([
  credentialBase.extend({
    startupSessionId: z.string().uuid(),
    transport: z.literal('cli').optional(),
    ancestors: z.array(processSchema).max(8).optional(),
  }),
  credentialBase.extend({ harness: z.literal('codex'), connectionId: z.string().uuid() }),
]);
const hookSchema = z.strictObject({
  profileId: string,
  revision: string,
  host: processSchema,
  sessionId: z.string().uuid(),
  ended: z.boolean(),
});
const stateSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  bindings: z.record(z.string(), bindingSchema),
  credentials: z.record(z.string(), credentialSchema),
  hooks: z.record(z.string(), hookSchema),
});
const operationSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('identity') }),
  z.strictObject({ operation: z.literal('activate'), activationId: z.string().uuid() }),
  z.strictObject({ operation: z.literal('list_peers') }),
  z.strictObject({
    operation: z.literal('ask'),
    messageId: z.string().uuid(),
    to: z.union([address, z.string().min(1).max(1024)]),
    message: z.string().min(1).max(100000),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    operation: z.literal('reply'),
    request: z.string().uuid(),
    message: z.string().min(1).max(100000),
  }),
]);
type State = z.infer<typeof stateSchema>;
type Credential = z.infer<typeof credentialSchema>;
type Pair = { child: ProcessIdentity; host: ProcessIdentity; ancestors?: ProcessIdentity[] };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new HubError('invalid_input', `Invalid connector input: ${r.error.message}`);
  return r.data;
}
const same = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b);
const revision = (p: ConnectorProfile) => fingerprint(p);
const hostKey = (p: ConnectorProfile, host: ProcessIdentity) =>
  fingerprint([p.id, revision(p), host]);

/** Local same-OS-user enrollment. Process evidence is not remote or hostile-user attestation. */
export class ConnectorService {
  private readonly profiles: ConnectorProfile[];
  private readonly inspect: ProcessInspector;
  private readonly state: AdapterState;
  private readonly activation: CliActivation;
  constructor(
    private readonly hub: AgentHub,
    profiles: ConnectorProfile[],
    options: { inspect?: ProcessInspector } = {},
  ) {
    if (profiles.length > 100) throw new HubError('invalid_profile', 'Too many connector profiles');
    this.profiles = profiles.map((p) => parse(profileSchema, p));
    if (this.profiles.some((p) => p.transport === 'cli' && p.harness !== 'claude'))
      throw new HubError('invalid_profile', 'CLI transport is only supported for Claude');
    const ids = new Set<string>(),
      tokens = new Set<string>();
    for (const p of this.profiles) {
      if (
        ids.has(p.id) ||
        tokens.has(p.enrollmentToken) ||
        p.callerId === OWNER ||
        !hub.access.has(p.callerId)
      )
        throw new HubError(
          'invalid_profile',
          'Connector profiles require unique credentials and a restricted caller',
        );
      ids.add(p.id);
      tokens.add(p.enrollmentToken);
    }
    this.inspect = options.inspect ?? createProcessInspector();
    this.state = hub.featureState('connectors');
    this.activation = new CliActivation(hub, this.inspect);
    this.read();
  }
  private read(): State {
    const raw = this.state.get('registry');
    if (!raw) return { version: 1, bindings: {}, credentials: {}, hooks: {} };
    const r = stateSchema.safeParse(raw);
    if (!r.success)
      throw new HubError('corrupt_store', 'Invalid connector registry; refusing recovery', 500);
    return r.data;
  }
  assertCredentialSeparation(apiTokens: string[]) {
    const hashes = new Set(apiTokens.map((token) => fingerprint(token)));
    if (this.profiles.some((profile) => hashes.has(fingerprint(profile.enrollmentToken))))
      throw new HubError(
        'invalid_profile',
        'Enrollment credentials must differ from all owner and caller API tokens',
      );
  }
  private save(s: State) {
    for (const [key, c] of Object.entries(s.credentials))
      if (c.expires < Date.now()) delete s.credentials[key];
    for (const rows of [s.bindings, s.credentials, s.hooks])
      if (Object.keys(rows).length > 4096)
        throw new HubError('connector_capacity', 'Connector registry capacity reached', 429);
    s.version = 3;
    this.state.set('registry', s);
  }
  private profile(id: string) {
    const p = this.profiles.find((p) => p.id === id);
    if (!p) throw new HubError('credential_revoked', 'Connector credential revoked', 401);
    if (p.enabled === false)
      throw new HubError('connector_disabled', 'Connector profile disabled', 403);
    return p;
  }
  private enrollment(token: string) {
    const hash = fingerprint(token);
    const p = this.profiles.find((p) => fingerprint(p.enrollmentToken) === hash);
    if (!p) throw new HubError('invalid_credential', 'Invalid enrollment credential', 401);
    return this.profile(p.id);
  }
  private async pair(pid: number) {
    const child = await this.inspect(pid),
      host = await this.inspect(child.ppid);
    const uid = process.getuid?.();
    if (uid === undefined || child.uid !== uid || host.uid !== uid || child.ppid !== host.pid)
      throw new HubError('identity_unavailable', 'Connector process owner does not match Hub', 409);
    return { child, host };
  }
  private async evidencePair(p: ConnectorProfile, e: ConnectorEvidence): Promise<Pair> {
    const cli = !('harness' in e) && e.transport === 'cli';
    if (cli !== (p.transport === 'cli'))
      throw new HubError(
        'identity_unavailable',
        'Connector transport does not match owner profile',
        409,
      );
    if (!cli) return this.pair(e.pid);
    const rows = await this.sessions(p, p),
      ancestors: ProcessIdentity[] = [];
    let pid = e.pid;
    for (let i = 0; i < 8 && pid > 1; i++) {
      if (ancestors.some((a) => a.pid === pid)) break;
      const item = await this.inspect(pid);
      if (item.uid !== process.getuid?.())
        throw new HubError('identity_unavailable', 'CLI ancestor owner differs from Hub', 409);
      ancestors.push(item);
      const matches = rows.filter((s) => s.metadata?.pid === item.pid);
      if (i > 0 && matches.length === 1) return { child: ancestors[0]!, host: item, ancestors };
      if (matches.length > 1) break;
      pid = item.ppid;
    }
    throw new HubError(
      'identity_unavailable',
      'No unique native Claude ancestor within eight processes',
      409,
    );
  }
  private async unchanged(pair: Pair) {
    if (pair.ancestors) {
      for (const item of pair.ancestors)
        if (!same(await this.inspect(item.pid), item))
          throw new HubError('identity_changed', 'CLI ancestor changed during verification', 409);
      return;
    }
    if (!same(await this.pair(pair.child.pid), pair))
      throw new HubError(
        'identity_changed',
        'Connector process changed during identity verification',
        409,
      );
  }
  private async sessions(p: ConnectorProfile, scope: { harness: string; instance: string }) {
    const rows: SessionInfo[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const seen = new Set<string>();
    do {
      const page = await this.hub.listSessions(
        scope,
        { limit: 100, ...(cursor ? { cursor } : {}) },
        p.callerId,
      );
      rows.push(...page.data);
      cursor = page.nextCursor ?? undefined;
      if (cursor && (++pages >= 10 || rows.length >= 1000 || seen.has(cursor)))
        throw new HubError(
          'discovery_limit',
          'Session discovery incomplete; use a canonical address',
          409,
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    return rows;
  }
  private async native(p: ConnectorProfile, host: ProcessIdentity) {
    const rows = (await this.sessions(p, p)).filter((s) => s.metadata?.pid === host.pid);
    if (rows.length !== 1)
      throw new HubError(
        'identity_pending',
        'Native session identity is unavailable or ambiguous',
        409,
      );
    this.hub.access.require(p.callerId, 'send', rows[0]!.address, rows[0]!.address.sessionId);
    return rows[0]!;
  }
  private binding(p: ConnectorProfile, a: SessionAddress, connectionId?: string): ConnectorBinding {
    const s = this.read(),
      key = fingerprint([p.id, revision(p), a]);
    let binding = s.bindings[key];
    if (!binding) {
      binding = {
        bindingId: randomUUID(),
        profileId: p.id,
        address: a,
        createdAt: new Date().toISOString(),
      };
      s.bindings[key] = binding;
    }
    if (connectionId) binding.connectionId = connectionId;
    this.save(s);
    return structuredClone(binding);
  }
  private async verify(p: ConnectorProfile, pair: Pair, evidence: ConnectorEvidence) {
    if ('harness' in evidence) {
      if (
        p.harness !== 'codex' ||
        (evidence.sessionId !== undefined && evidence.threadId !== evidence.sessionId)
      )
        throw new HubError(
          'identity_unavailable',
          'Invalid Codex session metadata or profile',
          409,
        );
      const address = { harness: p.harness, instance: p.instance, sessionId: evidence.threadId };
      this.hub.access.require(p.callerId, 'read', address, address.sessionId);
      this.hub.access.require(p.callerId, 'send', address, address.sessionId);
      const adapter = this.hub.adapter(address);
      if (!adapter.connectorSession)
        throw new HubError('identity_unavailable', 'Adapter cannot verify a native connector', 409);
      const session = await adapter.connectorSession(
        address,
        p.mcpServerName ?? 'agenthub',
        evidence.connectionId,
      );
      await this.unchanged(pair);
      return { binding: this.binding(p, address, evidence.connectionId), session };
    }
    if (p.harness !== 'claude')
      throw new HubError('identity_unavailable', 'Codex requires per-call metadata', 409);
    const { startupSessionId } = evidence;
    const native = await this.native(p, pair.host);
    const hook =
      evidence.transport === 'cli' ? undefined : this.read().hooks[hostKey(p, pair.host)];
    if (hook?.ended) throw new HubError('session_ended', 'Session lifecycle ended', 409);
    if ((hook?.sessionId ?? startupSessionId) !== native.address.sessionId)
      throw new HubError(
        'identity_pending',
        'Session changed; fresh lifecycle evidence is required',
        409,
      );
    await this.unchanged(pair);
    return { binding: this.binding(p, native.address), session: native };
  }
  async enroll(token: string, value: unknown) {
    await this.hub.ready();
    const p = this.enrollment(token),
      e = parse(evidenceSchema, value),
      pair = await this.evidencePair(p, e);
    const verified = await this.verify(p, pair, e);
    const business = randomBytes(32).toString('base64url'),
      s = this.read();
    s.credentials[fingerprint(business)] = {
      profileId: p.id,
      revision: revision(p),
      ...pair,
      ...('harness' in e
        ? { harness: 'codex' as const, connectionId: e.connectionId }
        : {
            startupSessionId: e.startupSessionId,
            ...(e.transport ? { transport: e.transport } : {}),
          }),
      expires: Date.now() + (!('harness' in e) && e.transport === 'cli' ? 60000 : 86400000),
    };
    this.save(s);
    return { token: business, binding: verified.binding };
  }
  async hook(token: string, value: unknown) {
    await this.hub.ready();
    const p = this.enrollment(token),
      e = parse(
        z.strictObject({
          pid: z.number().int().positive(),
          event: z.enum(['SessionStart', 'SessionEnd']),
          sessionId: z.string().uuid(),
        }),
        value,
      ),
      pair = await this.pair(e.pid);
    if (p.harness !== 'claude')
      throw new HubError('unsupported', 'Lifecycle hooks apply only to Claude', 422);
    const key = hostKey(p, pair.host);
    if (e.event === 'SessionStart') {
      const native = await this.native(p, pair.host);
      if (native.address.sessionId !== e.sessionId)
        throw new HubError('identity_pending', 'Hook session does not match native identity', 409);
    } else {
      const previous = this.read().hooks[key];
      if (previous && previous.sessionId !== e.sessionId) return { accepted: true, stale: true };
      const native = await this.native(p, pair.host);
      if (native.address.sessionId !== e.sessionId) return { accepted: true, stale: true };
    }
    await this.unchanged(pair);
    const s = this.read();
    s.hooks[key] = {
      profileId: p.id,
      revision: revision(p),
      host: pair.host,
      sessionId: e.sessionId,
      ended: e.event === 'SessionEnd',
    };
    this.save(s);
    return { accepted: true, stale: false };
  }
  private async authorized(token: string, value: unknown) {
    const e = parse(evidenceSchema, value),
      c: Credential | undefined = this.read().credentials[fingerprint(token)];
    if (!c || c.expires < Date.now())
      throw new HubError('invalid_credential', 'Invalid or expired connector credential', 401);
    const p = this.profile(c.profileId);
    if (c.revision !== revision(p))
      throw new HubError('credential_revoked', 'Connector credential revoked by owner', 401);
    const pair = await this.evidencePair(p, e);
    if (
      !same(pair, {
        child: c.child,
        host: c.host,
        ...(!('harness' in c) && c.ancestors ? { ancestors: c.ancestors } : {}),
      }) ||
      ('harness' in c
        ? !('harness' in e) || c.connectionId !== e.connectionId
        : 'harness' in e ||
          c.startupSessionId !== e.startupSessionId ||
          c.transport !== e.transport)
    )
      throw new HubError(
        'identity_changed',
        'Credential belongs to another connector process',
        409,
      );
    return { p, pair, ...(await this.verify(p, pair, e)) };
  }
  async call(token: string, evidence: unknown, value: unknown): Promise<unknown> {
    await this.hub.ready();
    const op = parse(operationSchema, value),
      { p, binding, session } = await this.authorized(token, evidence);
    if (op.operation === 'identity') return { binding };
    if (op.operation === 'activate') {
      const peers = await this.peers(p, session);
      const current = await this.authorized(token, evidence);
      const activation = this.activation.confirm(
        p,
        current.binding.address,
        current.pair.host,
        op.activationId,
      );
      return { ...activation, binding: current.binding, peers };
    }
    if (op.operation === 'list_peers') return { peers: await this.peers(p, session) };
    if (op.operation === 'reply')
      return this.hub.replyToMessage(op.request, binding.address, op.message, p.callerId);
    const deadline = Date.parse(op.expiresAt);
    if (deadline <= Date.now() || deadline > Date.now() + 4 * 3600000)
      throw new HubError('invalid_deadline', 'Request deadline must be in the next four hours');
    let to: SessionAddress;
    if (typeof op.to === 'string') {
      const match = /^@([^/]+)\/(.+)$/.exec(op.to);
      if (!match) throw new HubError('invalid_target', 'Use @harness/name or a canonical address');
      const found = (await this.peers(p)).filter(
        (s) =>
          s.address.harness === match[1] &&
          (s.name === match[2] || s.address.sessionId === match[2]),
      );
      if (found.length !== 1)
        throw new HubError(
          'ambiguous_target',
          'Peer name is missing or ambiguous; use a canonical address',
          409,
        );
      to = found[0]!.address;
    } else to = op.to;
    this.hub.access.require(p.callerId, 'send', to, to.sessionId);
    const target = await this.target(to, p.callerId),
      delivery = target.capabilities.send.find((d) => d !== 'user_input');
    if (!delivery || !session.capabilities.send.some((d) => d !== 'user_input'))
      throw new HubError(
        'unsupported_delivery',
        'Both sessions must accept external messages',
        422,
      );
    if (
      !target.capabilities.reply ||
      (target.replyReadiness && target.replyReadiness.state !== 'ready')
    )
      throw new HubError('reply_unavailable', 'Target reply route is not ready', 409);
    const current = await this.authorized(token, evidence);
    if (addressKey(current.binding.address) !== addressKey(binding.address))
      throw new HubError('identity_changed', 'Source session changed before submission', 409);
    const receipt = await this.hub.send(
      {
        messageId: op.messageId,
        messageKind: 'request',
        to,
        delivery,
        text: op.message,
        origin: { name: 'AgentHub connector', session: binding.address },
        replyTo: binding.address,
        expiresAt: op.expiresAt,
      },
      p.callerId,
    );
    return {
      request: receipt.messageId,
      status: receipt.status,
      to,
      expiresAt: op.expiresAt,
      ...(receipt.error ? { error: receipt.error } : {}),
      guidance: ['failed', 'rejected'].includes(receipt.status)
        ? 'This request failed or was rejected. Inspect the reported status and error; do not assume a reply is coming.'
        : receipt.status === 'unknown'
          ? 'Delivery is uncertain. Ask the owner to inspect this request ID; do not submit again with a new ID.'
          : 'This is asynchronous. Continue independent work, or end this turn; any result arrives as a new external message. Keep any intervening user request separate and correlate the result by request ID.',
    };
  }
  private async target(address: SessionAddress, callerId: string) {
    const session = await this.hub.getSession(address, callerId);
    if (session.replyReadiness?.state === 'ready' || address.harness !== 'codex') return session;
    const profile = this.profiles.find(
      (p) =>
        p.enabled !== false && p.harness === address.harness && p.instance === address.instance,
    );
    const adapter = this.hub.adapter(address);
    if (profile && adapter.connectorSession)
      return adapter.connectorSession(address, profile.mcpServerName ?? 'agenthub');
    return session;
  }
  private async peers(p: ConnectorProfile, current?: SessionInfo) {
    const peers: SessionInfo[] = [];
    for (const scope of this.hub.instances(p.callerId)) {
      if (!this.hub.access.allows(p.callerId, 'read', scope)) continue;
      for (const s of await this.sessions(p, scope)) {
        if (this.hub.access.allows(p.callerId, 'send', s.address, s.address.sessionId)) {
          // Native discovery describes the legacy reply route. Only the current
          // session has just been verified against this connector connection.
          // Other peers are checked on ask, keeping discovery bounded and read-only.
          const connectorConfigured = this.profiles.some(
            (profile) =>
              profile.enabled !== false &&
              profile.harness === 'codex' &&
              s.address.harness === profile.harness &&
              s.address.instance === profile.instance,
          );
          const readiness =
            current && addressKey(current.address) === addressKey(s.address)
              ? current.replyReadiness
              : connectorConfigured && s.replyReadiness?.state !== 'ready'
                ? {
                    state: 'unknown' as const,
                    tool: 'unknown' as const,
                    listener: 'unknown' as const,
                    reason:
                      'Connector reply readiness is verified when asking this peer; legacy dynamic-tool readiness is separate',
                  }
                : s.replyReadiness;
          peers.push({
            address: s.address,
            name: s.name,
            status: s.status,
            capabilities: s.capabilities,
            ...(readiness ? { replyReadiness: readiness } : {}),
          });
        }
      }
    }
    return peers;
  }
  async connect(value: unknown, port: number) {
    await this.hub.ready();
    return connectSession(
      this.hub,
      this.profiles,
      (profile, address, connectionId) => {
        const state = this.read();
        return (
          Object.values(state.bindings).some(
            (b) =>
              b.profileId === profile.id &&
              addressKey(b.address) === addressKey(address) &&
              b.connectionId === connectionId,
          ) &&
          Object.values(state.credentials).some(
            (c) =>
              'harness' in c &&
              c.profileId === profile.id &&
              c.revision === revision(profile) &&
              c.connectionId === connectionId &&
              c.expires > Date.now(),
          )
        );
      },
      value,
      port,
      (profile, address, path, waitMs, retry) =>
        this.activation.connect(profile, address, path, waitMs, retry),
    );
  }
  async connections() {
    await this.hub.ready();
    return {
      bindings: Object.values(this.read().bindings),
      profiles: this.profiles.map(({ id, harness, instance, enabled }) => ({
        id,
        harness,
        instance,
        enabled: enabled !== false,
      })),
      liveness:
        'Bindings are historical identity records, not proof that a session or connector is alive.',
    };
  }
}

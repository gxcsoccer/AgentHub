import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod/v4';
import { HubError, fingerprint } from '../validation.js';
import type { AgentHub } from '../hub.js';
import type { SessionAddress } from '../types.js';
import type { ConnectorProfile, ConnectorConnectionResult } from './types.js';
import { loadConnectorClientProfile } from './config.js';

/** Explicit owner action. Codex reloads MCP; opted-in Claude CLI profiles use a peer handshake. */
export async function connectSession(
  hub: AgentHub,
  profiles: ConnectorProfile[],
  bindingReady: (
    profile: ConnectorProfile,
    address: SessionAddress,
    connectionId: string,
  ) => boolean,
  value: unknown,
  port: number,
  activateClaude?: (
    profile: ConnectorProfile,
    address: SessionAddress,
    path: string,
    waitMs: number,
    retry: boolean,
  ) => Promise<ConnectorConnectionResult>,
  prepare?: (profile: ConnectorProfile, address: SessionAddress) => void,
): Promise<ConnectorConnectionResult> {
  const parsed = z
    .strictObject({
      address: z.strictObject({
        harness: z.enum(['claude', 'codex']),
        instance: z.string().min(1),
        sessionId: z.string().uuid(),
      }),
      clientProfilePath: z.string().min(1).optional(),
      waitMs: z.number().int().min(0).max(60000).default(0),
      retryActivation: z.boolean().default(false),
    })
    .safeParse(value);
  if (!parsed.success) throw new HubError('invalid_input', 'Invalid connect parameters');
  const input = parsed.data,
    adapter = hub.adapter(input.address);
  await hub.getSession(input.address);
  if (
    input.address.harness === 'claude' &&
    !profiles.some(
      (p) =>
        p.harness === 'claude' &&
        p.instance === input.address.instance &&
        p.transport === 'cli' &&
        p.enabled !== false,
    )
  )
    throw new HubError(
      'automatic_activation_unavailable',
      'External automatic activation of an arbitrary existing Claude session is not verified; configuration was not changed',
      409,
    );
  if (!input.clientProfilePath || !isAbsolute(input.clientProfilePath))
    throw new HubError('invalid_input', 'An absolute --connector-profile path is required');
  const clientProfile = await loadConnectorClientProfile(input.clientProfilePath),
    url = new URL(clientProfile.baseUrl);
  if (
    (clientProfile.harness ?? 'claude') !== input.address.harness ||
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    Number(url.port || 80) !== port ||
    url.username ||
    url.password
  )
    throw new HubError('invalid_profile', 'Client profile must target this local Hub and harness');
  const matching = profiles.filter(
    (p) =>
      p.harness === input.address.harness &&
      p.instance === input.address.instance &&
      fingerprint(p.enrollmentToken) === fingerprint(clientProfile.enrollmentToken),
  );
  if (matching.length !== 1 || matching[0]!.enabled === false)
    throw new HubError('invalid_profile', 'No enabled enrollment profile matches this instance');
  const profile = matching[0]!;
  hub.access.require(profile.callerId, 'read', input.address, input.address.sessionId);
  hub.access.require(profile.callerId, 'send', input.address, input.address.sessionId);
  prepare?.(profile, input.address);
  if (input.address.harness === 'claude') {
    if (!activateClaude) throw new HubError('unsupported', 'CLI activation is not configured', 501);
    return activateClaude(
      profile,
      input.address,
      resolve(input.clientProfilePath),
      input.waitMs,
      input.retryActivation,
    );
  }
  if (input.retryActivation)
    throw new HubError('invalid_input', 'retryActivation applies only to Claude CLI activation');
  if (!adapter.installConnector || !adapter.connectorSession)
    throw new HubError('unsupported', 'Adapter cannot install and verify a native connector', 501);
  const serverName = profile.mcpServerName ?? 'agenthub';
  const installation = await adapter.installConnector(input.address, serverName, {
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../cli.js', import.meta.url)),
      'mcp',
      '--connector-profile',
      resolve(input.clientProfilePath),
    ],
  });
  const deadline = Date.now() + input.waitMs;
  let ready = false,
    reason = 'Native connector has not connected',
    bound = false,
    probed = false;
  do {
    let connectionId: string | undefined;
    try {
      const current = await adapter.connectorSession(input.address, serverName);
      connectionId = String(current.metadata?.connectorConnectionId ?? '');
      ready = true;
      reason = 'Native connector and tools verified';
    } catch (error) {
      if (
        !(error instanceof HubError) ||
        !['connector_unavailable', 'session_not_loaded'].includes(error.code)
      )
        throw error;
      ready = false;
      reason = error.message;
    }
    bound = ready && Boolean(connectionId) && bindingReady(profile, input.address, connectionId!);
    if (ready && !bound && !probed && adapter.probeConnector) {
      probed = true;
      try {
        await adapter.probeConnector(input.address, serverName);
        bound = bindingReady(profile, input.address, connectionId!);
      } catch (error) {
        if (!(error instanceof HubError) || error.code !== 'identity_pending') throw error;
        reason = error.message;
      }
    }
    if ((ready && bound) || Date.now() >= deadline) break;
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  } while (true);
  return {
    address: input.address,
    ...installation,
    phase: bound ? 'ready' : ready ? 'awaiting_identity' : 'awaiting_connection',
    exitCode: bound ? 0 : 2,
    checkedAt: new Date().toISOString(),
    verificationMethod: probed ? 'native_mcp_readonly_call' : 'native_connection_and_prior_binding',
    capabilities: { toolsConnected: ready, identityBound: bound },
    reason,
    nextAction: bound
      ? null
      : ready
        ? 'Identity was not verified; inspect the profile, credentials and native MCP connection. No model turn was started.'
        : 'Wait and inspect the native MCP connection; installation alone is not readiness',
  };
}

import type { AgentHubClient } from './client.js';
import type { Json, SessionAddress, SessionInfo } from './types.js';

type Scope = Pick<SessionAddress, 'harness' | 'instance'>;
export interface DoctorOptions {
  scope?: Scope;
  sessionId?: string;
}
export interface DiagnosticCheck {
  id: 'service' | 'configuration' | 'discovery' | 'target' | 'send' | 'reply';
  status: 'ok' | 'warning' | 'error';
  code: string;
  message: string;
  scope?: Scope | SessionAddress;
  details?: Json;
}
export interface DoctorReport {
  schemaVersion: 1;
  checkedAt: string;
  readOnly: true;
  deliveryTested: false;
  status: DiagnosticCheck['status'];
  checks: DiagnosticCheck[];
}
type Reader = Pick<AgentHubClient, 'instances' | 'listSessions' | 'getSession'>;
const hints: Record<string, string> = {
  unauthorized: 'Use the existing daemon owner token; credentials were not created or changed.',
  storage_unavailable:
    'The daemon cannot use its state store. Inspect its logs and private state directory.',
  store_in_use: 'Another process owns the state store. Check the owner before starting a daemon.',
  session_not_loaded: 'The target is not running. The owner must choose an available session.',
  adapter_not_found: 'The requested instance is not configured in this daemon.',
  timeout:
    'The read exceeded its timeout. Check daemon/backend availability or increase --timeout-ms.',
  connection_failed: 'The local daemon is unreachable. Check its URL and whether it is running.',
  invalid_response: 'The service did not return valid JSON. Check the URL and daemon version.',
};
function invalidResponse(): never {
  throw Object.assign(new Error('Invalid diagnostic read response'), { code: 'invalid_response' });
}
function failure(
  id: DiagnosticCheck['id'],
  error: unknown,
  scope?: Scope | SessionAddress,
): DiagnosticCheck {
  const value = error as { name?: string; code?: unknown; status?: unknown } | null;
  const code =
    value?.name === 'TimeoutError' || value?.name === 'AbortError'
      ? 'timeout'
      : value?.name === 'SyntaxError'
        ? 'invalid_response'
        : value?.name === 'TypeError'
          ? 'connection_failed'
          : typeof value?.code === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value.code)
            ? value.code
            : 'request_failed';
  // Native error messages can contain paths, command output or credentials.
  // Stable codes and fixed guidance are sufficient for the shareable report.
  return {
    id,
    status: 'error',
    code,
    message:
      hints[code] ?? 'The read failed. Inspect the configured backend and private daemon logs.',
    ...(scope ? { scope } : {}),
    ...(Number.isInteger(value?.status) ? { details: { httpStatus: value!.status } } : {}),
  };
}
function targetChecks(info: SessionInfo, scope: SessionAddress): DiagnosticCheck[] {
  if (
    !info ||
    !Array.isArray(info.capabilities?.send) ||
    info.capabilities.send.some((x) => x !== 'tool_output' && x !== 'peer_message')
  )
    invalidResponse();
  const metadata = info.metadata ?? {},
    details: Json = { delivery: info.capabilities.send };
  const installedCliVersion = metadata.installedCliVersion ?? metadata.cliVersion;
  if (typeof installedCliVersion === 'string') details.installedCliVersion = installedCliVersion;
  for (const key of ['validatedCliVersion', 'processVersionVerified', 'versionSource'])
    if (typeof metadata[key] === 'string' || typeof metadata[key] === 'boolean')
      details[key] = metadata[key];
  let send: DiagnosticCheck = {
    id: 'send',
    status: 'ok',
    code: 'send_supported',
    message:
      'The adapter advertises a supported delivery method. No message was sent; inbound policy and model receipt are untested.',
    scope,
    details,
  };
  if (info.status === 'notLoaded' || info.replyReadiness?.state === 'unavailable')
    send = {
      ...send,
      status: 'error',
      code: 'session_unavailable',
      message: 'The target is not an available root session. Choose an available session.',
    };
  else if (!info.capabilities.send.length) {
    send = {
      ...send,
      status: 'warning',
      code: 'send_unavailable',
      message: 'This target does not advertise a supported delivery method.',
    };
    if (scope.harness === 'claude') {
      if (metadata.nativeMessagingEnabled === false)
        send = {
          ...send,
          code: 'native_messaging_disabled',
          message:
            'Claude native messaging is disabled. The owner can explicitly enable it in the daemon configuration.',
        };
      else if (
        typeof metadata.validatedCliVersion === 'string' &&
        !(Array.isArray(metadata.validatedCliVersions)
          ? metadata.validatedCliVersions.includes(installedCliVersion)
          : installedCliVersion === metadata.validatedCliVersion)
      )
        send = {
          ...send,
          status: 'error',
          code: 'unsupported_version',
          message:
            'The installed Claude CLI does not match the adapter validated version. Validate an adapter update before enabling sends.',
        };
      else if (metadata.socketAvailable === false)
        send = {
          ...send,
          status: 'error',
          code: 'socket_unavailable',
          message:
            'The native inbox is absent or not owned by this user. Check the target process and instance configuration.',
        };
    }
  }
  const reply: DiagnosticCheck = {
    id: 'reply',
    status: 'warning',
    code: 'reply_unverified',
    message: 'No reply readiness evidence is available. A correlated reply has not been tested.',
    scope,
  };
  const state = info.replyReadiness?.state;
  const explanations = {
    ready:
      'The adapter verified tool registration and its listener. Model invocation remains untested.',
    needs_attach:
      'The owner must explicitly attach this reply route and acknowledge the upstream resume race. Doctor does not attach.',
    missing_tool:
      'A compatible reply tool was not registered. The owner must use a session created with that tool; arbitrary live tool installation is unsupported.',
    unknown:
      'Tool registration could not be verified from local session metadata. Check an initialized session and metadata availability.',
    unavailable: 'The target is not available for reply attachment.',
  };
  if (state && Object.hasOwn(explanations, state)) {
    reply.code = `reply_${state}`;
    reply.message = explanations[state];
    reply.status = state === 'ready' ? 'ok' : state === 'unavailable' ? 'error' : 'warning';
    reply.details = { tool: info.replyReadiness!.tool, listener: info.replyReadiness!.listener };
  } else if (info.capabilities.reply === 'native_callback') {
    reply.status = 'ok';
    reply.code = 'callback_supported';
    reply.message =
      'Native callback replies are supported. No callback was opened and delivery, inbound policy and model reply remain untested.';
  }
  return [send, reply];
}

/** Read-only prerequisite checks. The bounded discovery sample is not a
 * session inventory, backend subscription, delivery probe or model test. */
export async function diagnose(client: Reader, options: DoctorOptions = {}): Promise<DoctorReport> {
  if (options.sessionId !== undefined && !options.scope)
    throw new Error('sessionId requires scope');
  if (options.scope && (!options.scope.harness?.trim() || !options.scope.instance?.trim()))
    throw new Error('scope requires harness and instance');
  if (options.sessionId !== undefined && !options.sessionId.trim())
    throw new Error('sessionId must be nonempty');
  const report: DoctorReport = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    readOnly: true,
    deliveryTested: false,
    status: 'ok',
    checks: [],
  };
  const finish = () => {
    report.status = report.checks.some((x) => x.status === 'error')
      ? 'error'
      : report.checks.some((x) => x.status === 'warning')
        ? 'warning'
        : 'ok';
    return report;
  };
  let instances: Scope[];
  try {
    const data = (await client.instances()).data;
    if (
      !Array.isArray(data) ||
      data.some(
        (x) =>
          !x ||
          typeof x.harness !== 'string' ||
          !x.harness.trim() ||
          typeof x.instance !== 'string' ||
          !x.instance.trim(),
      )
    )
      invalidResponse();
    instances = data.map(({ harness, instance }) => ({ harness, instance }));
    report.checks.push({
      id: 'service',
      status: 'ok',
      code: 'service_reachable',
      message:
        'The authenticated daemon read API is available. No disk write or backend delivery was tested.',
    });
  } catch (error) {
    report.checks.push(failure('service', error));
    return finish();
  }
  const scope = options.scope
    ? { harness: options.scope.harness, instance: options.scope.instance }
    : undefined;
  if (scope) {
    instances = instances.filter(
      (x) => x.harness === scope.harness && x.instance === scope.instance,
    );
    if (!instances.length) {
      report.checks.push({
        id: 'configuration',
        status: 'error',
        code: 'adapter_not_found',
        message: hints.adapter_not_found!,
        scope,
      });
      return finish();
    }
  }
  if (scope && options.sessionId !== undefined) {
    const address = { ...scope, sessionId: options.sessionId };
    try {
      report.checks.push(...targetChecks(await client.getSession(address), address));
    } catch (error) {
      report.checks.push(failure('target', error, address));
    }
    return finish();
  }
  if (!instances.length)
    report.checks.push({
      id: 'configuration',
      status: 'warning',
      code: 'no_instances',
      message:
        'No harness instances are configured. Add the intended instances to the daemon configuration.',
    });
  if (instances.length > 32)
    report.checks.push({
      id: 'configuration',
      status: 'warning',
      code: 'instance_limit',
      message:
        'Only the first 32 instances are inspected. Select an instance with --harness and --instance.',
      details: { configured: instances.length, inspected: 32 },
    });
  instances = instances.slice(0, 32);
  for (let start = 0; start < instances.length; start += 4) {
    const checks = await Promise.all(
      instances.slice(start, start + 4).map(async (scope): Promise<DiagnosticCheck> => {
        try {
          const page = await client.listSessions(scope, { limit: 10 });
          if (
            !Array.isArray(page?.data) ||
            (page.nextCursor !== null && typeof page.nextCursor !== 'string')
          )
            invalidResponse();
          return {
            id: 'discovery',
            status: page.data.length ? 'ok' : 'warning',
            code: page.data.length ? 'discovery_available' : 'no_sessions',
            message: page.data.length
              ? 'Discovery returned a bounded sample. Select a session to check send/reply prerequisites.'
              : 'Discovery succeeded but returned no sessions. No target delivery readiness was checked.',
            scope,
            details: { sampledSessions: page.data.length, hasMore: page.nextCursor !== null },
          };
        } catch (error) {
          return failure('discovery', error, scope);
        }
      }),
    );
    report.checks.push(...checks);
  }
  return finish();
}

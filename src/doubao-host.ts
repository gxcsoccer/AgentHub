import WebSocket from 'ws';
import { HubError } from './validation.js';

export interface DoubaoConnector {
  connector_id: string;
  name: string;
  enabled?: boolean;
  mcp_config?: {
    transport_type: number;
    stdio_config?: { command: string; params?: string[]; env?: Record<string, string> };
  };
}
export interface DoubaoHostApi {
  list(): Promise<DoubaoConnector[]>;
  detail(id: string): Promise<DoubaoConnector>;
  create(name: string, command: string): Promise<DoubaoConnector>;
  connect(id: string): Promise<void>;
  enabled(id: string, enabled: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  close(): void;
}
const prefix = 'https://www.doubao.com/alice/office/skills/manage/connector/';
// Desktop device context scopes local connectors. Cookies remain inside Doubao's renderer.
// Never copy Cookie, msToken, a_bogus, or other authentication values into CLI state/output.
const contextKeys = [
  'version_code',
  'language',
  'device_platform',
  'doubao_device_platform',
  'aid',
  'real_aid',
  'pkg_type',
  'device_id',
  'pc_version',
  'doubao_pc_version',
  'web_id',
  'tea_uuid',
  'region',
  'sys_region',
  'samantha_web',
  'web_platform',
  'use-olympus-account',
  'runtime',
  'runtime_version',
  'client_platform',
  'chromium_version',
  'channel',
];
export function doubaoRequestExpression(path: string, body: object) {
  return `(async()=>{
    const context=performance.getEntriesByType('resource').map(e=>{try{return new URL(e.name)}catch{return null}})
      .find(u=>u?.origin==='https://www.doubao.com'&&u.pathname.startsWith('/alice/')&&u.searchParams.has('device_id')&&u.searchParams.get('pc_version')==='2.35.15');
    if(!context)return {error:'unsupported_host_context'};
    const url=new URL(${JSON.stringify(prefix + path)});
    for(const key of ${JSON.stringify(contextKeys)}){const value=context.searchParams.get(key);if(value!==null)url.searchParams.set(key,value)}
    try {
      const response=await fetch(url,{method:'POST',credentials:'include',redirect:'error',
        signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','Agw-Js-Conv':'str'},
        body:${JSON.stringify(JSON.stringify(body))}});
      const data=await response.json();
      if(!response.ok||data.code!==0)return {error:'host_api_rejected'};
      return {data:data.data};
    }catch{return {error:'host_api_unknown'}}
  })()`;
}
export async function openDoubaoHost(port: number): Promise<DoubaoHostApi> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid Doubao CDP port');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  }).catch(() => {
    throw new HubError(
      'doubao_debug_unavailable',
      'Doubao must already expose the explicitly selected CDP port; AgentHub does not restart it',
    );
  });
  if (!response.ok)
    throw new HubError('doubao_debug_unavailable', 'Could not discover Doubao CDP targets');
  const targets: unknown = await response.json();
  if (!Array.isArray(targets)) throw new HubError('invalid_doubao_target', 'Invalid CDP targets');
  const matches = targets.filter(
    (t) =>
      t?.type === 'page' &&
      typeof t.url === 'string' &&
      t.url.startsWith('doubaowork://doubaowork-chat/'),
  );
  if (matches.length !== 1)
    throw new HubError(
      'ambiguous_doubao_target',
      'Expected exactly one native Doubao chat renderer',
    );
  const endpoint = new URL(matches[0].webSocketDebuggerUrl);
  if (
    endpoint.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    endpoint.port !== String(port) ||
    endpoint.username ||
    endpoint.password ||
    !endpoint.pathname.startsWith('/devtools/page/')
  )
    throw new HubError('invalid_doubao_target', 'CDP target must use the selected loopback port');
  const ws = new WebSocket(endpoint, { handshakeTimeout: 3000, maxPayload: 4 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', () =>
      reject(new HubError('doubao_debug_unavailable', 'Could not connect to Doubao CDP')),
    );
  });
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const fail = () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        new HubError(
          'doubao_operation_unknown',
          'CDP disconnected; verify the recorded operation before retrying',
        ),
      );
    }
    pending.clear();
  };
  ws.on('close', fail);
  ws.on('error', fail);
  ws.on('message', (bytes) => {
    let data;
    try {
      data = JSON.parse(bytes.toString());
    } catch {
      return;
    }
    const p = pending.get(data.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(data.id);
    if (data.error || data.result?.exceptionDetails)
      p.reject(
        new HubError(
          'doubao_operation_unknown',
          'Host evaluation failed; operation outcome may be unknown',
        ),
      );
    else p.resolve(data.result?.result?.value);
  });
  const request = async <T>(path: string, body: object): Promise<T> => {
    const id = ++nextId;
    const value = (await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new HubError(
            'doubao_operation_unknown',
            'Host operation timed out; it is not automatically retried',
          ),
        );
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: {
            expression: doubaoRequestExpression(path, body),
            returnByValue: true,
            awaitPromise: true,
          },
        }),
        (error) => {
          if (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(new HubError('doubao_operation_unknown', 'CDP write failed'));
          }
        },
      );
    })) as { error?: string; data?: T } | undefined;
    if (!value || value.error || !value.data)
      throw new HubError(
        value?.error ?? 'invalid_doubao_response',
        'Doubao operation could not be verified; supported host version is 2.35.15',
      );
    return value.data;
  };
  return {
    async list() {
      const data = await request<{ items: DoubaoConnector[]; has_more: boolean }>('list_by_user', {
        keyword: '',
        page_size: 48,
        page_token: '',
        skill_type_filters: [1],
      });
      if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean')
        throw new HubError('invalid_doubao_response', 'Invalid connector list');
      // Pagination has not been observed on this host. Never treat a partial list as absence.
      if (data.has_more)
        throw new HubError(
          'incomplete_doubao_list',
          'More than one local connector page; automatic registration requires a complete verified list',
        );
      return data.items;
    },
    async detail(id) {
      return (
        await request<{ connector: DoubaoConnector }>('get_detail', {
          connector_id: id,
          skill_type: 1,
        })
      ).connector;
    },
    async create(name, command) {
      return (
        await request<{ connector: DoubaoConnector }>('create_personal', {
          name,
          description: 'AgentHub local connector',
          icon_url: '',
          mcp_config: { transport_type: 3, stdio_config: { command, params: [], env: {} } },
        })
      ).connector;
    },
    async connect(id) {
      const r = await request<{ connected: boolean }>('connect', {
        connector_id: id,
        skill_type: 1,
        auth_fields: [],
      });
      if (r.connected !== true)
        throw new HubError('doubao_not_connected', 'Host did not accept connection');
    },
    async enabled(id, enabled) {
      const r = await request<{ enabled: boolean }>('set_enabled', {
        connector_id: id,
        skill_type: 1,
        enabled,
      });
      if (r.enabled !== enabled)
        throw new HubError('doubao_not_updated', 'Host did not confirm enabled state');
    },
    async remove(id) {
      const r = await request<{ disconnected: boolean }>('disconnect', {
        connector_id: id,
        skill_type: 1,
      });
      if (r.disconnected !== true)
        throw new HubError('doubao_not_removed', 'Host did not confirm removal');
    },
    close() {
      fail();
      ws.close();
    },
  };
}

// Type-only browser consumer check: Node ambient types must not be required by the SDK.
import { CodexBridgeClient } from '../src/sdk.js';

export async function readSession(token: string, id: string): Promise<string> {
  const client = new CodexBridgeClient({ token });
  const { thread } = await client.detail(id);
  const page = await client.items(id, { limit: 1 });
  const snippet = page.data[0]?.item.type ?? '';
  return `${thread.id}:${snippet}`;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openApi } from '../src/openapi.js';
test('published unified OpenAPI matches runtime and preserves explicit delivery and opaque addressing', async () => {
  assert.deepEqual(
    JSON.parse(await readFile(new URL('../../openapi.json', import.meta.url), 'utf8')),
    openApi,
  );
  const spec = JSON.parse(JSON.stringify(openApi));
  const metadata = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(spec.info.version, metadata.version);
  assert.deepEqual(spec.components.schemas.MessageInput.properties.delivery.enum, [
    'tool_output',
    'peer_message',
  ]);
  assert.equal(spec.components.schemas.SessionAddress.properties.sessionId.format, undefined);
  assert.equal(
    spec.paths['/v1/messages'].post.responses[202].content['application/json'].schema.$ref,
    '#/components/schemas/Receipt',
  );
  assert.equal(Object.keys(spec.paths).length, 20);
  const connector =
    spec.paths['/v1/connector/call'].post.requestBody.content['application/json'].schema;
  assert.equal(connector.additionalProperties, false);
  assert.deepEqual(
    connector.properties.operation.oneOf.map(
      (operation: { properties: { operation: { const: string } } }) =>
        operation.properties.operation.const,
    ),
    ['identity', 'activate', 'list_peers', 'ask', 'reply'],
  );
  assert.equal(spec.paths['/v1/session/attach-reply'].post.operationId, 'attachReplyRoute');
});

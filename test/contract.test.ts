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
  assert.deepEqual(spec.components.schemas.MessageInput.properties.delivery.enum, [
    'tool_output',
    'peer_message',
  ]);
  assert.equal(spec.components.schemas.SessionAddress.properties.sessionId.format, undefined);
  assert.equal(
    spec.paths['/v1/messages'].post.responses[202].content['application/json'].schema.$ref,
    '#/components/schemas/Receipt',
  );
  assert.equal(Object.keys(spec.paths).length, 13);
  assert.equal(spec.paths['/v1/session/attach-reply'].post.operationId, 'attachReplyRoute');
});

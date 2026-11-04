import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openApi } from '../src/routes.js';

test('published contract includes typed receipts, history and conditional message requirements', () => {
  const schema = JSON.parse(JSON.stringify(openApi()));
  assert.ok(schema.components.schemas.MessageReceipt.required.includes('turnId'));
  assert.ok(schema.components.schemas.SessionPage.properties.data.items.$ref);
  assert.ok(schema.components.schemas.ItemEntry.properties.item);
  const operation = schema.paths['/v1/sessions/{sessionId}/messages'].post;
  assert.equal(
    operation.responses['202'].content['application/json'].schema.$ref,
    '#/components/schemas/MessageReceipt',
  );
  assert.ok(operation.requestBody.content['application/json'].schema.allOf);
});

test('checked-in OpenAPI matches the runtime API exactly', async () => {
  const checkedIn = JSON.parse(
    await readFile(new URL('../../openapi.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(checkedIn, openApi());
});

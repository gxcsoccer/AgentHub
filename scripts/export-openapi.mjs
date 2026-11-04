import { writeFile } from 'node:fs/promises';
import { openApi } from '../dist/src/openapi.js';
await writeFile(
  new URL('../openapi.json', import.meta.url),
  JSON.stringify(openApi, null, 2) + '\n',
);

import { writeFile } from 'node:fs/promises';
import { openApi } from './routes.js';
await writeFile('openapi.json', `${JSON.stringify(openApi(), null, 2)}\n`);

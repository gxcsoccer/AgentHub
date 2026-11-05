import { readFileSync } from 'node:fs';

// Runtime modules are compiled to dist/src; the published manifest is the source of truth.
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

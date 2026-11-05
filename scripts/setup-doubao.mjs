import { setupDoubao } from '../dist/src/setup.js';
export { setupDoubao };
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        directory: { type: 'string' },
        targets: { type: 'string' },
        port: { type: 'string' },
        cli: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help)
      console.log(
        'node scripts/setup-doubao.mjs --targets FILE [--directory NEW_PRIVATE_DIRECTORY] [--port 3214] [--cli ABSOLUTE_CLI_JS]',
      );
    else {
      if (!values.targets) throw Error('--targets FILE is required');
      const result = await setupDoubao({
        directory: values.directory ?? join(homedir(), '.agenthub', 'doubao'),
        targets: JSON.parse(await readFile(resolve(values.targets), 'utf8')),
        ...(values.port !== undefined ? { port: Number(values.port) } : {}),
        ...(values.cli !== undefined ? { cliPath: values.cli } : {}),
      });
      console.log(JSON.stringify(result));
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}

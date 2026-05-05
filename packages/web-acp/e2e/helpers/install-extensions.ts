import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AGENT_EXAMPLES_DIR = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'web-acp-agent',
  'examples',
  'extensions'
);

/**
 * Reads the example extension `index.js` from
 * `packages/web-acp-agent/examples/extensions/<name>/index.js` and
 * returns the inline files map suitable for `installVolumes`. The
 * caller decides which volume the extension lands on.
 */
export async function readExampleExtension(name: string): Promise<Record<string, string>> {
  const path = join(AGENT_EXAMPLES_DIR, name, 'index.js');
  const source = await readFile(path, 'utf8');
  return {
    [`/.pi/extensions/${name}/index.js`]: source,
  };
}

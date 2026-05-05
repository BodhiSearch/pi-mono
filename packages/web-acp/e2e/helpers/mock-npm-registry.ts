import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext } from '@playwright/test';
import { createTarGzip } from 'nanotar';

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

export interface MockNpmPackage {
  /** npm package name (e.g. `pi-greet-fixture`). Must match `package.json.name`. */
  name: string;
  /** Folder under `packages/web-acp-agent/examples/extensions/<dirName>/`. */
  exampleDir: string;
  /** Override registry origin. Defaults to `https://registry.example.test`. */
  registryOrigin?: string;
}

/**
 * Install Playwright `context.route` handlers that respond to npm
 * registry traffic with a tarball built on the fly from the example
 * extension folder. Returns a function to install it; tests call it
 * before navigating so the worker's first install fetch is captured.
 *
 * `context.route` (vs `page.route`) is required because the install
 * fetch originates from the agent web worker, not the page itself —
 * worker fetches are observed at the browser context level.
 */
export async function mockNpmPackage(
  context: BrowserContext,
  spec: MockNpmPackage
): Promise<{ tarballUrl: string; metadataUrl: string; version: string }> {
  const origin = (spec.registryOrigin ?? 'https://registry.example.test').replace(/\/+$/, '');
  const root = join(AGENT_EXAMPLES_DIR, spec.exampleDir);
  const files: Record<string, string> = {};
  await walk(root, root, files);
  const manifestRaw = files['/package.json'];
  if (!manifestRaw) {
    throw new Error(`mockNpmPackage: ${spec.exampleDir}/package.json missing`);
  }
  const manifest = JSON.parse(manifestRaw) as { name?: string; version?: string };
  if (manifest.name !== spec.name) {
    throw new Error(
      `mockNpmPackage: package.json.name '${manifest.name}' does not match expected '${spec.name}'`
    );
  }
  const version = manifest.version ?? '0.0.0';

  const entries = Object.entries(files).map(([key, contents]) => {
    const rel = key.replace(/^\/+/, '');
    return { name: `package/${rel}`, data: contents };
  });
  const tarball = await createTarGzip(entries);
  const tarballBody = tarball.buffer.slice(
    tarball.byteOffset,
    tarball.byteOffset + tarball.byteLength
  ) as ArrayBuffer;

  const metadataUrl = `${origin}/${encodeRegistryName(spec.name)}`;
  const tarballUrl = `${origin}/${encodeRegistryName(spec.name)}/-/${last(spec.name)}-${version}.tgz`;

  await context.route(metadataUrl, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        'dist-tags': { latest: version },
        versions: { [version]: { version, dist: { tarball: tarballUrl } } },
      }),
    });
  });
  await context.route(tarballUrl, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: Buffer.from(tarballBody),
    });
  });
  return { tarballUrl, metadataUrl, version };
}

async function walk(root: string, dir: string, out: Record<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'README.md') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out);
    } else if (entry.isFile()) {
      const info = await stat(abs);
      if (!info.isFile()) continue;
      const rel = '/' + relative(root, abs).split(/[\\/]/).join('/');
      out[rel] = await readFile(abs, 'utf8');
    }
  }
}

function encodeRegistryName(name: string): string {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const slashIdx = name.indexOf('/');
  if (slashIdx === -1) return encodeURIComponent(name);
  return `${encodeURIComponent(name.slice(0, slashIdx))}%2f${encodeURIComponent(
    name.slice(slashIdx + 1)
  )}`;
}

function last(name: string): string {
  if (!name.startsWith('@')) return name;
  const slashIdx = name.indexOf('/');
  return slashIdx === -1 ? name.slice(1) : name.slice(slashIdx + 1);
}

/**
 * `_bodhi/extensions/add` machinery.
 *
 * Resolves a package spec (`<name>` or `<name>@<version>`) against the npm
 * registry, fetches the matching tarball, parses it via `nanotar`, and
 * lays the contents down at `<agent-wd>/.pi/extensions/<extensionName>/`.
 * The loader picks it up on the next `_bodhi/extensions/reload`.
 *
 * Constraints baked in for M6:
 *
 * - Source registry is `https://registry.npmjs.org` by default; injectable
 *   for tests / future enterprise mirrors.
 * - Entry resolution prefers `package.json.pi.extensions[0]`, then
 *   `module`, then `main`. The loader always reads `index.js` at the
 *   install root, so the entry's contents are written there.
 * - Extensions must be self-contained — relative imports inside the entry
 *   are not currently supported (the loader uses base64 data URLs which
 *   have no module resolution base).
 * - Scoped packages (`@scope/name`) are stored as
 *   `<scope>__<name>@<version>` so a single flat directory level is
 *   sufficient.
 */

import { parseTarGzip } from 'nanotar';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

export interface NpmPackageSpec {
  name: string;
  version?: string;
}

/** Parse a spec like `<name>` or `<name>@<version>`; supports `@scope/<name>[@<version>]`. */
export function parseNpmPackageSpec(input: string): NpmPackageSpec {
  const trimmed = input.trim().replace(/^npm:/i, '');
  if (trimmed.length === 0) {
    throw new Error('package spec is empty');
  }
  const scoped = trimmed.startsWith('@');
  if (scoped) {
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx <= 1) {
      throw new Error(`invalid scoped package spec '${input}'`);
    }
    const scope = trimmed.slice(0, slashIdx);
    const rest = trimmed.slice(slashIdx + 1);
    const atIdx = rest.indexOf('@');
    if (atIdx === -1) return { name: `${scope}/${rest}` };
    return {
      name: `${scope}/${rest.slice(0, atIdx)}`,
      version: rest.slice(atIdx + 1) || undefined,
    };
  }
  const atIdx = trimmed.indexOf('@');
  if (atIdx === -1) return { name: trimmed };
  return { name: trimmed.slice(0, atIdx), version: trimmed.slice(atIdx + 1) || undefined };
}

/** Translate `<scope>/<name>` → `<scope>__<name>` so install paths stay flat. */
export function localExtensionDirName(name: string, version: string): string {
  const safe = name.startsWith('@') ? name.replace('/', '__').slice(1) : name;
  return `${safe}@${version}`;
}

interface NpmDistTagResponse {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, NpmVersionResponse>;
}

interface NpmVersionResponse {
  version?: string;
  dist?: { tarball?: string };
}

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  pi?: { extensions?: unknown };
}

export interface InstalledExtension {
  /** The npm package's `name`, taken from its `package.json`. */
  name: string;
  /** The npm package's `version`, taken from its `package.json`. */
  version: string;
  /** Local on-disk directory name (`<safe>@<version>`). */
  extensionName: string;
  /** Absolute mount path the install was written to. */
  installPath: string;
}

export interface InstallExtensionInput {
  spec: string;
  /** Mount root that owns the extensions tree (must be tagged `agent-wd`). */
  agentWdMount: string;
  /** Writable fs against the `agent-wd` mount; the install writes inside `/mnt/<mount>/.pi/extensions/`. */
  writeFs: import('./extensions-fs').ExtensionsWriteFs;
  /** Override for tests / mirrors. Defaults to `https://registry.npmjs.org`. */
  registryUrl?: string;
  /** Optional fetch override. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export async function installExtensionFromNpm(
  input: InstallExtensionInput
): Promise<InstalledExtension> {
  const { name, version: requestedVersion } = parseNpmPackageSpec(input.spec);
  const registry = (input.registryUrl ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, '');
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('no fetch implementation available; pass `fetchImpl`');
  }

  const tarballUrl = await resolveTarballUrl({ registry, name, requestedVersion, fetchImpl });
  const tarball = await fetchTarball(tarballUrl, fetchImpl);
  const files = await parseTarGzip(tarball);

  const pkgJsonEntry = files.find(f => f.name === 'package/package.json');
  if (!pkgJsonEntry || !pkgJsonEntry.text) {
    throw new Error(`tarball for '${name}' is missing package/package.json`);
  }
  const manifest = JSON.parse(pkgJsonEntry.text) as PackageJson;
  const resolvedName = typeof manifest.name === 'string' ? manifest.name : name;
  const resolvedVersion =
    typeof manifest.version === 'string' ? manifest.version : (requestedVersion ?? 'unknown');

  const entryRel = pickEntryRelpath(manifest);
  if (!entryRel) {
    throw new Error(
      `package '${resolvedName}@${resolvedVersion}' declares no entry: ` +
        `expected pi.extensions[0], module, or main in package.json`
    );
  }
  const entryEntry = files.find(f => f.name === `package/${normalizeRel(entryRel)}`);
  if (!entryEntry || entryEntry.text === undefined) {
    throw new Error(
      `package '${resolvedName}@${resolvedVersion}' entry '${entryRel}' was not present in the tarball`
    );
  }

  if (/[/\\]|\.\./.test(resolvedVersion)) {
    throw new Error(
      `[extensions] install aborted: unsafe version string in registry metadata: ${JSON.stringify(resolvedVersion)}`
    );
  }
  const extensionName = localExtensionDirName(resolvedName, resolvedVersion);
  if (extensionName.includes('..') || extensionName.includes('/')) {
    throw new Error(
      `[extensions] install aborted: unsafe extension dir name derived from registry metadata: ${JSON.stringify(extensionName)}`
    );
  }
  const installRoot = `/mnt/${input.agentWdMount}/.pi/extensions/${extensionName}`;
  await input.writeFs.rm(installRoot);
  await input.writeFs.mkdir(installRoot);
  await input.writeFs.writeFile(`${installRoot}/index.js`, entryEntry.text);
  await input.writeFs.writeFile(`${installRoot}/package.json`, pkgJsonEntry.text);

  return {
    name: resolvedName,
    version: resolvedVersion,
    extensionName,
    installPath: installRoot,
  };
}

async function resolveTarballUrl(args: {
  registry: string;
  name: string;
  requestedVersion: string | undefined;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const { registry, name, requestedVersion, fetchImpl } = args;
  const metaUrl = `${registry}/${encodeRegistryName(name)}`;
  const response = await fetchImpl(metaUrl, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`registry metadata fetch failed: ${response.status} ${response.statusText}`);
  }
  const meta = (await response.json()) as NpmDistTagResponse;
  const targetVersion = requestedVersion ?? meta['dist-tags']?.latest;
  if (!targetVersion) {
    throw new Error(`registry metadata for '${name}' missing dist-tags.latest`);
  }
  const versionEntry = meta.versions?.[targetVersion];
  const tarball = versionEntry?.dist?.tarball;
  if (!tarball) {
    throw new Error(`registry metadata for '${name}@${targetVersion}' missing dist.tarball`);
  }
  return tarball;
}

async function fetchTarball(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  if (!url.startsWith('https://')) {
    throw new Error(
      `[extensions] install aborted: tarball URL from registry must use https://, got: ${JSON.stringify(url)}`
    );
  }
  const response = await fetchImpl(url, {
    headers: { accept: 'application/octet-stream' },
  });
  if (!response.ok) {
    throw new Error(`tarball fetch failed: ${response.status} ${response.statusText}`);
  }
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

// Scoped names use `/` after the scope; npm registry expects it
// percent-encoded (`%2f`) on metadata GETs.
function encodeRegistryName(name: string): string {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const slashIdx = name.indexOf('/');
  if (slashIdx === -1) return encodeURIComponent(name);
  return `${encodeURIComponent(name.slice(0, slashIdx))}%2f${encodeURIComponent(
    name.slice(slashIdx + 1)
  )}`;
}

function pickEntryRelpath(manifest: PackageJson): string | undefined {
  const piExt = manifest.pi?.extensions;
  if (Array.isArray(piExt) && typeof piExt[0] === 'string') return piExt[0];
  if (typeof manifest.module === 'string') return manifest.module;
  if (typeof manifest.main === 'string') return manifest.main;
  const exportsField = manifest.exports;
  if (exportsField && typeof exportsField === 'object') {
    const dot = (exportsField as Record<string, unknown>)['.'];
    if (typeof dot === 'string') return dot;
    if (dot && typeof dot === 'object') {
      const candidate =
        (dot as Record<string, unknown>).import ??
        (dot as Record<string, unknown>).default ??
        (dot as Record<string, unknown>).module;
      if (typeof candidate === 'string') return candidate;
    }
  }
  return undefined;
}

function normalizeRel(rel: string): string {
  return rel.replace(/^\.\//, '').replace(/^\/+/, '');
}

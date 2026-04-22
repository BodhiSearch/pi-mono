/**
 * Worker-side extension loader. Replaces coding-agent's jiti-based
 * loader with browser-native Blob-URL dynamic `import()`.
 *
 * See `ai-docs/specs/worker-agent/extensions.md` for the discovery
 * rules, manifest shape, and error-capture contract.
 */

import type { LsOperations, ReadOperations } from '../../fs/zenfs-operations';
import { Type } from '@sinclair/typebox';
import type {
  Extension,
  ExtensionAPI,
  ExtensionDescriptor,
  ExtensionEventHandler,
  ExtensionFactory,
  ExtensionManifest,
  ExtensionUIContext,
  RegisteredCommand,
  RegisteredTool,
  ToolDefinition,
} from './types';
import { defineTool } from './types';

/**
 * Factory used to build the `pi.ui` channel for a specific extension.
 *
 * The controller (main host) owns request lifecycle; the loader just
 * forwards the already-closed-over channel object to the factory so
 * `pi.ui.*` calls work at both factory-time and handler-time. Returning
 * a no-op channel is acceptable for headless / test contexts that
 * don't wire a main-thread renderer.
 */
export type ExtensionUIContextBuilder = (extensionPath: string) => ExtensionUIContext;

const NOOP_UI: ExtensionUIContext = {
  notify: () => {},
  setStatus: () => {},
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
};

/** Default UI builder — returns a no-op channel. Tests can supply their own. */
export const defaultUIContextBuilder: ExtensionUIContextBuilder = () => NOOP_UI;

const DECODER = new TextDecoder();

/** Sub-path (relative to the vault mount) that holds extension folders. */
export const EXTENSIONS_DIR_SEGMENT = '.pi/extensions';

/**
 * Narrow fs surface the loader needs. Mirrors the seam used by the
 * skills loader so tests can wire an in-memory fake without the full
 * `VaultOperations` stack.
 */
export interface ExtensionLoaderOps {
  ls: Pick<LsOperations, 'stat' | 'readdir'>;
  read: Pick<ReadOperations, 'readFile'>;
}

/**
 * Result of a scan. `extensions` carries successfully loaded records;
 * `descriptors` is the ordered, plain-data listing (includes broken
 * extensions with `loaded: false` + `error`) that the worker surfaces
 * over RPC.
 */
export interface LoadExtensionsResult {
  extensions: Extension[];
  descriptors: ExtensionDescriptor[];
}

/** Input controlling which extensions actually get their factories invoked. */
export interface LoadExtensionsOptions {
  /**
   * Map of extension name → enabled flag. Extensions absent from the map
   * are treated as enabled by default — the main thread reconciles the
   * map against discovered extensions after the first scan.
   */
  enabledState?: Record<string, boolean>;
  /**
   * Override the dynamic-import path. Production always uses the default
   * Blob-URL importer; tests substitute a transform that evaluates the
   * source in the current realm so Node's limited handling of blob: URLs
   * doesn't force the test runner into a browser environment.
   */
  importModule?: ModuleImporter;
  /**
   * Supply the per-extension `pi.ui` channel. Defaults to a no-op
   * implementation (appropriate for jsdom tests); the worker-host
   * injects the real `ExtensionUIController`-backed builder.
   */
  buildUIContext?: ExtensionUIContextBuilder;
}

/**
 * Function responsible for turning extension source code into a module
 * namespace record. The default `importFromVault` wraps the code in a
 * `Blob`, calls `URL.createObjectURL`, and dynamically imports that URL.
 * Tests inject their own to avoid Node's blob-URL import limitation.
 */
export type ModuleImporter = (code: string) => Promise<Record<string, unknown>>;

function joinPath(dir: string, child: string): string {
  return dir.endsWith('/') ? `${dir}${child}` : `${dir}/${child}`;
}

function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Resolve the single entry path for an extension directory.
 *
 * Preference order:
 * 1. `package.json` with a `pi.extensions` array → first path, resolved
 *    relative to the extension directory.
 * 2. `index.js` directly under the directory.
 * 3. `index.mjs` fallback (rarer, matches node ESM convention).
 *
 * Returns `null` when none of the candidates exist or the manifest is
 * malformed — callers surface the miss as a descriptor error.
 */
async function resolveEntryPath(
  extDir: string,
  ops: ExtensionLoaderOps
): Promise<{ entryPath: string; manifest?: ExtensionManifest } | { error: string }> {
  let entries: string[] = [];
  try {
    entries = await ops.ls.readdir(extDir);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'unable to read extension directory' };
  }

  if (entries.includes('package.json')) {
    const pkgPath = joinPath(extDir, 'package.json');
    try {
      const bytes = await ops.read.readFile(pkgPath);
      const raw = DECODER.decode(bytes);
      const pkg = JSON.parse(raw) as {
        name?: unknown;
        version?: unknown;
        description?: unknown;
        pi?: { extensions?: unknown };
      };
      const extList = pkg.pi?.extensions;
      if (Array.isArray(extList) && extList.length > 0 && typeof extList[0] === 'string') {
        const rel = extList[0] as string;
        const normalised = rel.startsWith('./') ? rel.slice(2) : rel;
        const manifest: ExtensionManifest = {
          name: typeof pkg.name === 'string' ? pkg.name : basename(extDir),
          version: typeof pkg.version === 'string' ? pkg.version : undefined,
          description: typeof pkg.description === 'string' ? pkg.description : undefined,
        };
        return { entryPath: joinPath(extDir, normalised), manifest };
      }
    } catch (err) {
      return {
        error: err instanceof Error ? `package.json: ${err.message}` : 'package.json parse failed',
      };
    }
  }

  if (entries.includes('index.js')) {
    return { entryPath: joinPath(extDir, 'index.js') };
  }
  if (entries.includes('index.mjs')) {
    return { entryPath: joinPath(extDir, 'index.mjs') };
  }

  return { error: 'no index.js or package.json entry found' };
}

/**
 * Load a single JavaScript module from the vault via Blob URL.
 *
 * Vite's `import()` parser would attempt to statically resolve a
 * non-literal specifier, so the `/* @vite-ignore *\/` marker is
 * required. The Blob URL is revoked in the `finally` so there is no
 * dangling retain on the module record.
 */
async function importFromVault(code: string): Promise<Record<string, unknown>> {
  const blob = new Blob([code], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    // `@vite-ignore` keeps Vite from failing the build trying to statically
    // analyse the Blob URL. The runtime `import()` works unchanged in both
    // dev and production.
    const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    return mod;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Build the `ExtensionAPI` object handed to a factory. Registration
 * calls mutate the `Extension` record returned by the caller so the
 * loader doesn't need a separate post-processing pass.
 */
function buildExtensionAPI(record: Extension, ui: ExtensionUIContext): ExtensionAPI {
  return {
    on(event, handler) {
      const bucket = record.handlers.get(event) ?? [];
      bucket.push(handler as unknown as ExtensionEventHandler<unknown, unknown>);
      record.handlers.set(event, bucket);
    },
    registerTool(tool) {
      const registered: RegisteredTool = {
        definition: tool as unknown as ToolDefinition,
        extensionPath: record.path,
      };
      record.tools.set(tool.name, registered);
    },
    registerCommand(name, options) {
      const registered: RegisteredCommand = {
        name,
        description: options.description,
        argumentHint: options.argumentHint,
        handler: options.handler,
        extensionPath: record.path,
      };
      record.commands.set(name, registered);
    },
    ui,
    Type,
    defineTool,
  };
}

/**
 * Attempt to load a single extension directory into a populated
 * `Extension` record. Returns `null` + an error string when any stage
 * (entry resolution, import, factory invocation) fails.
 */
async function loadOneExtension(
  extDir: string,
  ops: ExtensionLoaderOps,
  defaultName: string,
  importer: ModuleImporter,
  buildUI: ExtensionUIContextBuilder
): Promise<{ extension: Extension } | { error: string; manifest?: ExtensionManifest }> {
  const resolved = await resolveEntryPath(extDir, ops);
  if ('error' in resolved) {
    return { error: resolved.error };
  }

  let code: string;
  try {
    const bytes = await ops.read.readFile(resolved.entryPath);
    code = DECODER.decode(bytes);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'unable to read extension entry file',
      manifest: resolved.manifest,
    };
  }

  const manifest = resolved.manifest ?? { name: defaultName };
  const record: Extension = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    path: extDir,
    entryPath: resolved.entryPath,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };

  let mod: Record<string, unknown>;
  try {
    mod = await importer(code);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'dynamic import failed',
      manifest,
    };
  }

  const factory = mod.default;
  if (typeof factory !== 'function') {
    return {
      error: 'extension module does not export a default function',
      manifest,
    };
  }

  const api = buildExtensionAPI(record, buildUI(record.path));
  try {
    await (factory as ExtensionFactory)(api);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'factory threw during initialisation',
      manifest,
    };
  }

  return { extension: record };
}

/**
 * Scan `<vaultMount>/.pi/extensions/*` and return the loaded extensions
 * plus plain-data descriptors for every discovered subdirectory.
 *
 * Extensions with `enabledState[name] === false` are included in the
 * descriptor list but **not** loaded — their factories never run and no
 * handlers / tools / commands get registered. This keeps the disable
 * path cheap on re-load.
 */
export async function loadExtensionsFromVault(
  ops: ExtensionLoaderOps,
  vaultMount: string,
  options: LoadExtensionsOptions = {}
): Promise<LoadExtensionsResult> {
  const enabledState = options.enabledState ?? {};
  const importer = options.importModule ?? importFromVault;
  const buildUI = options.buildUIContext ?? defaultUIContextBuilder;
  const trimmed = vaultMount.endsWith('/') ? vaultMount.slice(0, -1) : vaultMount;
  const root = `${trimmed}/${EXTENSIONS_DIR_SEGMENT}`;

  try {
    const s = await ops.ls.stat(root);
    if (!s.isDirectory()) return { extensions: [], descriptors: [] };
  } catch {
    return { extensions: [], descriptors: [] };
  }

  let entries: string[] = [];
  try {
    entries = await ops.ls.readdir(root);
  } catch {
    return { extensions: [], descriptors: [] };
  }

  const extensions: Extension[] = [];
  const descriptors: ExtensionDescriptor[] = [];
  const sortedEntries = [...entries].sort();

  for (const entry of sortedEntries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const extDir = joinPath(root, entry);
    let isDir = false;
    try {
      const s = await ops.ls.stat(extDir);
      isDir = s.isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const enabled = enabledState[entry] !== false;
    if (!enabled) {
      // Surface the extension in the descriptor list so the UI knows it
      // exists, but skip import + factory invocation.
      descriptors.push({
        name: entry,
        path: extDir,
        enabled: false,
        loaded: false,
      });
      continue;
    }

    const result = await loadOneExtension(extDir, ops, entry, importer, buildUI);
    if ('error' in result) {
      descriptors.push({
        name: result.manifest?.name ?? entry,
        description: result.manifest?.description,
        version: result.manifest?.version,
        path: extDir,
        enabled: true,
        loaded: false,
        error: result.error,
      });
      continue;
    }
    extensions.push(result.extension);
    descriptors.push({
      name: result.extension.name,
      description: result.extension.description,
      version: result.extension.version,
      path: extDir,
      enabled: true,
      loaded: true,
    });
  }

  return { extensions, descriptors };
}

/**
 * Convenience helper for unit tests / Phase 2 authoring-DX experiments:
 * load an extension directly from a source string without going through
 * the vault. Same factory contract as `loadExtensionsFromVault`.
 */
export async function loadExtensionFromSource(
  code: string,
  name: string,
  options: {
    path?: string;
    manifest?: ExtensionManifest;
    importModule?: ModuleImporter;
    buildUIContext?: ExtensionUIContextBuilder;
  } = {}
): Promise<{ extension: Extension } | { error: string }> {
  const manifest = options.manifest ?? { name };
  const record: Extension = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    path: options.path ?? `/virtual/${name}`,
    entryPath: options.path ? `${options.path}/index.js` : `/virtual/${name}/index.js`,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
  };

  const importer = options.importModule ?? importFromVault;
  let mod: Record<string, unknown>;
  try {
    mod = await importer(code);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'dynamic import failed' };
  }

  const factory = mod.default;
  if (typeof factory !== 'function') {
    return { error: 'extension module does not export a default function' };
  }

  const buildUI = options.buildUIContext ?? defaultUIContextBuilder;
  const api = buildExtensionAPI(record, buildUI(record.path));
  try {
    await (factory as ExtensionFactory)(api);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'factory threw during initialisation' };
  }

  return { extension: record };
}

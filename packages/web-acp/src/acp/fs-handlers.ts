/**
 * ACP `fs/*` client handlers backed by the main-thread ZenFS context.
 *
 * Advertised in M2.3 as the **IDE-integration seam**: the built-in
 * `bash` tool (worker-side) never calls `fs/*`; these handlers exist
 * so external ACP agents — or a future editor-buffer bridge — can
 * read / write the same mounted volumes without round-tripping
 * through the worker.
 *
 * Path safety (mirrors the checks an operating system would apply):
 *
 * 1. **Absolute under `/mnt/`.** Anything else is rejected to keep
 *    the surface aligned with volume mounts.
 * 2. **Mount membership.** The first segment after `/mnt/` must match
 *    a registered mount; unknown mounts reject.
 * 3. **POSIX normalisation.** `..` is resolved against the mount root;
 *    if the result leaves the mount (e.g. `/mnt/wiki/../../etc/passwd`),
 *    reject.
 * 4. **Symlink canonicalisation.** `fs.promises.realpath` collapses
 *    symlinks; if the canonical path leaves the mount we reject. This
 *    covers attacks like `/mnt/wiki/evil -> /etc/passwd`.
 */
import { fs as mainFs } from '@zenfs/core';
import type {
  Client,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

export interface VolumeRegistryView {
  list(): Array<{ mountName: string }>;
}

export interface FsHandlerDeps {
  view: VolumeRegistryView;
  /**
   * Injected so tests can run against an isolated ZenFS instance.
   * Defaults to the shared `@zenfs/core` module singleton used by
   * `main-zenfs.ts`.
   */
  fsImpl?: FsLike;
}

export interface FsLike {
  promises: {
    readFile(path: string, options: { encoding: 'utf8' } | string): Promise<string>;
    writeFile(path: string, content: string, options: { encoding: 'utf8' } | string): Promise<void>;
    mkdir(path: string, options: { recursive: boolean }): Promise<void>;
    realpath(path: string): Promise<string | Buffer>;
  };
}

export function buildFsHandlers(
  deps: FsHandlerDeps
): Required<Pick<Client, 'readTextFile' | 'writeTextFile'>> {
  const fs = deps.fsImpl ?? (mainFs as unknown as FsLike);
  const { view } = deps;

  return {
    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const canonical = await resolveSafePath(params.path, view, fs);
      let content = await fs.promises.readFile(canonical, { encoding: 'utf8' });
      content = applyLineWindow(content, params.line ?? null, params.limit ?? null);
      return { content };
    },
    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      const canonical = await resolveSafePathForWrite(params.path, view, fs);
      const slash = canonical.lastIndexOf('/');
      if (slash > 0) {
        const parent = canonical.slice(0, slash);
        try {
          await fs.promises.mkdir(parent, { recursive: true });
        } catch (err) {
          if (!isExistsError(err)) throw err;
        }
      }
      await fs.promises.writeFile(canonical, params.content, { encoding: 'utf8' });
      return {};
    },
  };
}

async function resolveSafePath(
  rawPath: string,
  view: VolumeRegistryView,
  fs: FsLike
): Promise<string> {
  const mount = validateAndCanonicalise(rawPath, view);
  const realpath = await fs.promises.realpath(mount.canonical);
  const realpathStr = typeof realpath === 'string' ? realpath : realpath.toString();
  assertInsideMount(realpathStr, mount.mountRoot, rawPath);
  return realpathStr;
}

async function resolveSafePathForWrite(
  rawPath: string,
  view: VolumeRegistryView,
  fs: FsLike
): Promise<string> {
  const mount = validateAndCanonicalise(rawPath, view);
  // For writes the file may not yet exist, so realpath on it would
  // throw ENOENT. Canonicalise the parent instead (which must exist
  // or be creatable inside the mount) and assert it stays inside.
  const slash = mount.canonical.lastIndexOf('/');
  const parent = slash > 0 ? mount.canonical.slice(0, slash) : mount.canonical;
  try {
    const realParent = await fs.promises.realpath(parent);
    const realParentStr = typeof realParent === 'string' ? realParent : realParent.toString();
    assertInsideMount(realParentStr, mount.mountRoot, rawPath);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    // Parent doesn't exist yet; fall back to the normalised path
    // which was already validated to live inside the mount.
    assertInsideMount(parent, mount.mountRoot, rawPath);
  }
  return mount.canonical;
}

interface CanonicalisedMountPath {
  canonical: string;
  mountRoot: string;
  mountName: string;
}

function validateAndCanonicalise(
  rawPath: string,
  view: VolumeRegistryView
): CanonicalisedMountPath {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/mnt/')) {
    throw buildRejection(rawPath, 'path must be absolute under /mnt/');
  }
  const trimmed = rawPath.slice('/mnt/'.length);
  const firstSlash = trimmed.indexOf('/');
  const mountName = firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash);
  if (!mountName) throw buildRejection(rawPath, 'missing mount name');
  if (!view.list().some(v => v.mountName === mountName)) {
    throw buildRejection(rawPath, `unknown mount '${mountName}'`);
  }
  const mountRoot = `/mnt/${mountName}`;
  const canonical = posixResolve(rawPath);
  if (!(canonical === mountRoot || canonical.startsWith(`${mountRoot}/`))) {
    throw buildRejection(rawPath, `path escapes mount '${mountName}'`);
  }
  return { canonical, mountRoot, mountName };
}

function assertInsideMount(realpath: string, mountRoot: string, rawPath: string): void {
  if (!(realpath === mountRoot || realpath.startsWith(`${mountRoot}/`))) {
    throw buildRejection(rawPath, 'symlink leaves mount');
  }
}

function buildRejection(path: string, reason: string): Error {
  return new Error(`fs/* rejected path '${path}': ${reason}`);
}

function isExistsError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'EEXIST'
  );
}

function isNotFound(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * POSIX-style `path.resolve` for absolute inputs. Collapses `.` and
 * `..` segments without escaping the root.
 */
export function posixResolve(input: string): string {
  if (!input.startsWith('/')) input = `/${input}`;
  const parts: string[] = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function applyLineWindow(content: string, line: number | null, limit: number | null): string {
  if (line === null && limit === null) return content;
  const lines = content.split('\n');
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === null ? lines.length : Math.min(lines.length, start + limit);
  return lines.slice(start, end).join('\n');
}

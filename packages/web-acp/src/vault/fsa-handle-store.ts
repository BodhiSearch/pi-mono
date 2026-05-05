/**
 * Main-thread persistence for FileSystem Access API directory handles.
 *
 * The worker owns the ZenFS mounts (`WebAccess` backend for real handles,
 * `InMemory` backend for dev/test seeds), but FSA handles themselves live
 * on the main thread because `showDirectoryPicker()` is a window-only API.
 * We persist them in IndexedDB via `idb-keyval` so that they survive page
 * reloads; the browser still requires us to re-request user permission on
 * every page load because Chrome doesn't persist the permission grant.
 *
 * Keyed at `web-acp:volumes` rather than the old `dirHandle` slot used by
 * `web-agent` so the two packages can coexist on the same origin during
 * development.
 */
import { del, get, set } from 'idb-keyval';

export const VOLUMES_IDB_KEY = 'web-acp:volumes';

export interface VolumeHandleRecord {
  handle: FileSystemDirectoryHandle;
  mountName: string;
  description?: string;
  /** Absent on legacy records; the IDB read tolerates missing field. */
  tags?: readonly string[];
}

export async function loadHandles(): Promise<VolumeHandleRecord[]> {
  try {
    const stored = await get<VolumeHandleRecord[]>(VOLUMES_IDB_KEY);
    if (!Array.isArray(stored)) return [];
    return stored.filter(r => r && typeof r.mountName === 'string' && r.handle);
  } catch {
    return [];
  }
}

export async function saveHandles(records: VolumeHandleRecord[]): Promise<void> {
  if (records.length === 0) {
    try {
      await del(VOLUMES_IDB_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    await set(VOLUMES_IDB_KEY, records);
  } catch (err) {
    // In Playwright the handle objects are not structured-cloneable when
    // injected as POJOs via `__zenfsSeed`; tests drive persistence via the
    // init script directly, so swallowing the error here keeps the app
    // alive.
    console.warn('[fsa-handle-store] saveHandles failed:', err);
  }
}

export async function clearHandles(): Promise<void> {
  try {
    await del(VOLUMES_IDB_KEY);
  } catch {
    /* ignore */
  }
}

export interface PermissionPartition {
  ready: VolumeHandleRecord[];
  prompt: VolumeHandleRecord[];
}

/**
 * Re-request `readwrite` permission on every stored handle. Returns two
 * buckets — `ready` (permission granted without a prompt) and `prompt`
 * (we need a user gesture to re-grant). The caller decides what to do
 * with each bucket: `ready` handles go straight into the worker's
 * initial volumes; `prompt` handles surface in the UI as "needs
 * access".
 */
export async function requestPermissions(
  records: VolumeHandleRecord[]
): Promise<PermissionPartition> {
  const ready: VolumeHandleRecord[] = [];
  const prompt: VolumeHandleRecord[] = [];
  for (const record of records) {
    try {
      const handle = record.handle as FileSystemDirectoryHandle & {
        queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
        requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
      };
      const state = handle.queryPermission
        ? await handle.queryPermission({ mode: 'readwrite' })
        : 'prompt';
      if (state === 'granted') {
        ready.push(record);
      } else {
        prompt.push(record);
      }
    } catch {
      prompt.push(record);
    }
  }
  return { ready, prompt };
}

/**
 * Given a base mount name (e.g. the directory's `name` property) plus
 * the list of currently-live mount names, produce a non-colliding name
 * by appending `-1`, `-2`, … until the slot is free. The base name is
 * returned unchanged when it's free.
 *
 * Collision re-use policy: once a volume is removed the name is free
 * again, so re-adding the same directory right after removing it keeps
 * the original name. Matches the prompt's open-question #2 decision.
 */
export function deriveUniqueMountName(baseName: string, existing: string[]): string {
  const sanitized = sanitizeMountName(baseName);
  if (!existing.includes(sanitized)) return sanitized;
  let suffix = 1;
  while (existing.includes(`${sanitized}-${suffix}`)) suffix++;
  return `${sanitized}-${suffix}`;
}

function sanitizeMountName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'volume';
  // Path-safe: strip characters that would collide with `/mnt/<name>/…`
  // and leading `.`/`-` runs that could otherwise produce `..-evil`
  // style names from `../evil` input.
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return sanitized || 'volume';
}

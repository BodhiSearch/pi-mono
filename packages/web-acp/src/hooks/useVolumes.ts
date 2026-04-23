/**
 * Main-thread volume registry hook.
 *
 * Wraps `fsa-handle-store` (IndexedDB persistence) and the volume
 * control channel (dynamic mount/unmount on the worker). Boot flow:
 *   1. Load persisted handles + dev/test seeds injected via
 *      `window.__zenfsSeed`.
 *   2. Re-request `readwrite` permission on every persisted handle.
 *   3. Send mount requests to the worker via `volumeControl`.
 * The hook is intentionally oblivious to ACP — volume mount/unmount is
 * a bootstrap/control concern and sits outside the agent ↔ session
 * wire (documented in `specs/web-acp/vault.md`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deriveUniqueMountName,
  loadHandles,
  requestPermissions,
  saveHandles,
  type VolumeHandleRecord,
} from '@/vault/fsa-handle-store';
import type { VolumeControl } from '@/transport/volume-control';
import type { VolumeInit, VolumeSeed } from '@/agent/volume-mount';

export type VolumeState = 'idle' | 'mounting' | 'mounted' | 'prompt' | 'error';

export interface VolumeEntry {
  mountName: string;
  description?: string;
  state: VolumeState;
  errorMessage?: string;
  needsPermission: boolean;
}

export interface UseVolumesResult {
  entries: VolumeEntry[];
  ready: boolean;
  addVolume: (description?: string) => Promise<void>;
  removeVolume: (mountName: string) => Promise<void>;
  setDescription: (mountName: string, description: string) => Promise<void>;
  restoreAccess: (mountName: string) => Promise<void>;
}

interface DevSeedGlobal {
  __zenfsSeed?: VolumeSeed | VolumeSeed[];
}

export interface UseVolumesArgs {
  volumeControl: VolumeControl | null;
  onInitialVolumes?: (initial: VolumeInit[]) => void;
}

/**
 * Return the list of dev/test seeds injected into `window.__zenfsSeed`
 * by Playwright `addInitScript` (or manual DevTools tinkering). Always
 * returns an array — the helper shape on the window accepts either a
 * single seed or a list for multi-volume tests.
 */
export function readDevSeeds(): VolumeSeed[] {
  if (typeof window === 'undefined') return [];
  const raw = (window as unknown as DevSeedGlobal).__zenfsSeed;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function useVolumes({ volumeControl, onInitialVolumes }: UseVolumesArgs): UseVolumesResult {
  const [entries, setEntries] = useState<VolumeEntry[]>([]);
  const [ready, setReady] = useState(false);
  const recordsRef = useRef<VolumeHandleRecord[]>([]);
  const seedsRef = useRef<VolumeSeed[]>([]);
  const initialisedRef = useRef(false);

  const patch = useCallback((mountName: string, update: Partial<VolumeEntry>) => {
    setEntries(prev => prev.map(e => (e.mountName === mountName ? { ...e, ...update } : e)));
  }, []);

  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;
    (async () => {
      const records = await loadHandles();
      const seeds = readDevSeeds();
      seedsRef.current = seeds;
      const { ready: grantedRecords, prompt: needsPrompt } = await requestPermissions(records);
      recordsRef.current = [...grantedRecords, ...needsPrompt];
      const initialEntries: VolumeEntry[] = [];
      const initialMounts: VolumeInit[] = [];
      for (const r of grantedRecords) {
        initialEntries.push({
          mountName: r.mountName,
          description: r.description,
          state: 'mounting',
          needsPermission: false,
        });
        initialMounts.push({
          handle: r.handle,
          mountName: r.mountName,
          ...(r.description ? { description: r.description } : {}),
        });
      }
      for (const r of needsPrompt) {
        initialEntries.push({
          mountName: r.mountName,
          description: r.description,
          state: 'prompt',
          needsPermission: true,
        });
      }
      for (const seed of seeds) {
        const safeName = seed.name;
        initialEntries.push({
          mountName: safeName,
          description: seed.description,
          state: 'mounting',
          needsPermission: false,
        });
        initialMounts.push({
          seed,
          mountName: safeName,
          ...(seed.description ? { description: seed.description } : {}),
        });
      }
      setEntries(initialEntries);
      onInitialVolumes?.(initialMounts);
      // Mark entries as mounted optimistically once the worker has
      // been told to mount them. Real state transitions come from the
      // volume-control replies via the code paths below.
      setEntries(prev =>
        prev.map(e =>
          e.state === 'mounting' ? { ...e, state: 'mounted', needsPermission: false } : e
        )
      );
      setReady(true);
    })().catch(err => {
      console.error('[useVolumes] initial load failed:', err);
      setReady(true);
    });
  }, [onInitialVolumes]);

  const addVolume = useCallback(
    async (description?: string) => {
      if (!volumeControl) throw new Error('Volume control unavailable');
      if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
        throw new Error('FileSystem Access API is not available in this browser');
      }
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const existingNames = entries.map(e => e.mountName);
      const mountName = deriveUniqueMountName(handle.name ?? 'volume', existingNames);
      const optimistic: VolumeEntry = {
        mountName,
        description,
        state: 'mounting',
        needsPermission: false,
      };
      setEntries(prev => [...prev, optimistic]);
      try {
        await volumeControl.mount({
          handle,
          mountName,
          ...(description ? { description } : {}),
        });
        recordsRef.current = [
          ...recordsRef.current,
          { handle, mountName, ...(description ? { description } : {}) },
        ];
        await saveHandles(recordsRef.current);
        patch(mountName, { state: 'mounted' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch(mountName, { state: 'error', errorMessage: message });
      }
    },
    [entries, patch, volumeControl]
  );

  const removeVolume = useCallback(
    async (mountName: string) => {
      if (!volumeControl) throw new Error('Volume control unavailable');
      try {
        await volumeControl.unmount(mountName);
      } catch (err) {
        console.warn('[useVolumes] removeVolume failed:', err);
      }
      recordsRef.current = recordsRef.current.filter(r => r.mountName !== mountName);
      seedsRef.current = seedsRef.current.filter(s => s.name !== mountName);
      await saveHandles(recordsRef.current);
      setEntries(prev => prev.filter(e => e.mountName !== mountName));
    },
    [volumeControl]
  );

  const setDescription = useCallback(
    async (mountName: string, description: string) => {
      recordsRef.current = recordsRef.current.map(r =>
        r.mountName === mountName ? { ...r, description } : r
      );
      await saveHandles(recordsRef.current);
      patch(mountName, { description });
    },
    [patch]
  );

  const restoreAccess = useCallback(
    async (mountName: string) => {
      if (!volumeControl) return;
      const record = recordsRef.current.find(r => r.mountName === mountName);
      if (!record) return;
      const handle = record.handle as FileSystemDirectoryHandle & {
        requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
      };
      const perm = handle.requestPermission
        ? await handle.requestPermission({ mode: 'readwrite' })
        : 'denied';
      if (perm !== 'granted') {
        patch(mountName, { state: 'prompt', needsPermission: true });
        return;
      }
      patch(mountName, { state: 'mounting', needsPermission: false });
      try {
        await volumeControl.mount({
          handle: record.handle,
          mountName,
          ...(record.description ? { description: record.description } : {}),
        });
        patch(mountName, { state: 'mounted' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        patch(mountName, { state: 'error', errorMessage: message });
      }
    },
    [patch, volumeControl]
  );

  return { entries, ready, addVolume, removeVolume, setDescription, restoreAccess };
}

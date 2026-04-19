/**
 * Directory-handle lifecycle for the vault mount.
 *
 * Pattern copied from bodhiapps/zenfs-browser. The handle persists across
 * reloads in IndexedDB via idb-keyval; on each mount we re-request
 * permission because Chrome does not persist the permission grant itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { del, get, set } from 'idb-keyval';

const IDB_KEY = 'dirHandle';

type HandleState =
  | { status: 'empty' }
  | { status: 'prompt'; handle: FileSystemDirectoryHandle }
  | { status: 'ready'; handle: FileSystemDirectoryHandle };

export interface UseDirectoryHandleResult {
  status: 'empty' | 'prompt' | 'ready';
  handle: FileSystemDirectoryHandle | null;
  restoring: boolean;
  openDirectory: () => Promise<void>;
  restoreAccess: () => Promise<void>;
  closeDirectory: () => Promise<void>;
}

export function useDirectoryHandle(): UseDirectoryHandleResult {
  const [state, setState] = useState<HandleState>({ status: 'empty' });
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await get<FileSystemDirectoryHandle>(IDB_KEY);
        if (!stored || cancelled) {
          setRestoring(false);
          return;
        }
        const perm = await stored.requestPermission({ mode: 'readwrite' });
        if (cancelled) return;
        if (perm === 'granted') {
          setState({ status: 'ready', handle: stored });
        } else {
          setState({ status: 'prompt', handle: stored });
        }
      } catch {
        await del(IDB_KEY);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openDirectory = useCallback(async () => {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    try {
      await set(IDB_KEY, handle);
    } catch {
      // Handle may not be structured-cloneable in test environments.
    }
    setState({ status: 'ready', handle });
  }, []);

  const restoreAccess = useCallback(async () => {
    if (state.status !== 'prompt') return;
    const perm = await state.handle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      setState({ status: 'ready', handle: state.handle });
    }
  }, [state]);

  const closeDirectory = useCallback(async () => {
    try {
      await del(IDB_KEY);
    } catch {
      // Ignore IndexedDB errors.
    }
    setState({ status: 'empty' });
  }, []);

  return {
    status: state.status,
    handle: state.status !== 'empty' ? state.handle : null,
    restoring,
    openDirectory,
    restoreAccess,
    closeDirectory,
  };
}

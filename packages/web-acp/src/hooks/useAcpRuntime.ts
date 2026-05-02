import { useCallback, useEffect, useMemo } from 'react';
import { ensureRuntime, type AcpRuntime } from '@/acp/runtime';
import type { HostVolumeInit } from '@/runtime/volumes-fsa';
import { useVolumes, type UseVolumesResult } from '@/hooks/useVolumes';

export interface UseAcpRuntimeResult {
  runtime: AcpRuntime;
  volumes: UseVolumesResult;
}

/**
 * Mount the per-tab ACP runtime singleton (worker + ACP client + main-
 * thread ZenFS mirror) and the volumes registry that feeds it. The
 * runtime is created lazily on first call and reused across all
 * `useAcp*` hooks; `useVolumes` resolves the worker's `init` payload.
 */
export function useAcpRuntime(): UseAcpRuntimeResult {
  // Worker + client stay alive across re-renders; initialize once.
  useEffect(() => {
    ensureRuntime();
  }, []);

  const runtime = useMemo(() => ensureRuntime(), []);
  const volumeControl = runtime.volumeControl;

  const handleInitialVolumes = useCallback(
    (initial: HostVolumeInit[]) => {
      runtime.resolveInit(initial);
    },
    [runtime]
  );

  const volumes = useVolumes({ volumeControl, onInitialVolumes: handleInitialVolumes });

  return { runtime, volumes };
}

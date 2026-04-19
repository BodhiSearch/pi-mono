/**
 * Build the six vault filesystem tools when the vault is mounted.
 *
 * Returns an empty array when the vault is not yet available so the agent
 * can still run without filesystem capabilities.
 */

import { useMemo } from 'react';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createVaultTools, createZenfsVaultOperations } from '@/web-agent';
import type { VaultMountStatus } from '@/hooks/useVaultMount';

const EMPTY: AgentTool[] = [];

export function useVaultTools(status: VaultMountStatus): AgentTool[] {
  return useMemo(() => {
    if (status !== 'mounted') return EMPTY;
    return createVaultTools(createZenfsVaultOperations());
  }, [status]);
}

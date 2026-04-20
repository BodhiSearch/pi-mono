import { createContext, useContext } from 'react';

export type VaultMountStatus =
  | 'initializing'
  | 'empty'
  | 'prompt'
  | 'mounting'
  | 'mounted'
  | 'error';

export interface VaultContextValue {
  status: VaultMountStatus;
  name: string | null;
  errorMessage: string | null;
  openDirectory: () => Promise<void>;
  restoreAccess: () => Promise<void>;
  closeDirectory: () => Promise<void>;
}

export const VaultContext = createContext<VaultContextValue | null>(null);

export function useVaultContext(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error('useVaultContext must be used within <VaultProvider>');
  }
  return ctx;
}

/**
 * Thin consumer hook over VaultProvider's context.
 *
 * The actual mount side-effect lives in `src/providers/VaultProvider.tsx`
 * so it runs exactly once per app, regardless of how many components read
 * the vault state. See that file for the reason — parallel mounts from
 * multiple consumers race on ZenFS `configure`/`mount` and one of the racers
 * surfaces a spurious error even when the mount eventually succeeds.
 */

import { useVaultContext } from '@/providers/vault-context';
import type { VaultContextValue, VaultMountStatus } from '@/providers/vault-context';

export type { VaultMountStatus };
export type UseVaultMountResult = VaultContextValue;

export function useVaultMount(): UseVaultMountResult {
  return useVaultContext();
}

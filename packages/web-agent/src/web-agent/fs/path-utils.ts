/**
 * Path helpers constrained to the vault mount.
 *
 * All filesystem tools accept user paths that may be relative or absolute.
 * We resolve them against a cwd rooted at /vault and reject anything that
 * escapes the mount — the agent must not reach outside the folder the user
 * explicitly granted.
 */

import { VAULT_MOUNT } from './zenfs-provider';

export interface ResolvedPath {
  /** Absolute ZenFS path starting at VAULT_MOUNT. */
  absolute: string;
  /** Path relative to VAULT_MOUNT, without leading slash (e.g. "src/a.ts"). */
  relative: string;
}

function normalizePosix(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const segment of parts) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) {
        throw new VaultPathError('Path escapes the vault');
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

/**
 * Resolve a user-supplied path to an absolute vault path.
 *
 * Rules:
 *   - Accepts relative paths like "./a" or "a/b.ts" — resolved against cwd.
 *   - Accepts absolute paths starting with "/vault/" or equal to "/vault".
 *   - Rejects absolute paths pointing elsewhere (e.g. "/etc", "/").
 *   - Rejects paths that traverse above the vault root via "..".
 *
 * @param userPath user-supplied path
 * @param cwd current working directory (defaults to VAULT_MOUNT)
 */
export function resolveVaultPath(userPath: string, cwd: string = VAULT_MOUNT): ResolvedPath {
  if (typeof userPath !== 'string') {
    throw new VaultPathError('Path must be a string');
  }

  let candidate: string;
  if (userPath.startsWith('/')) {
    candidate = userPath;
  } else {
    candidate = `${cwd.endsWith('/') ? cwd : `${cwd}/`}${userPath}`;
  }

  const normalized = `/${normalizePosix(candidate)}`;

  if (normalized !== VAULT_MOUNT && !normalized.startsWith(`${VAULT_MOUNT}/`)) {
    throw new VaultPathError(`Path escapes the vault: ${userPath}`);
  }

  const relative = normalized === VAULT_MOUNT ? '' : normalized.slice(VAULT_MOUNT.length + 1);

  return {
    absolute: normalized,
    relative,
  };
}

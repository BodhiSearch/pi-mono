import type { PreferenceStore } from '../../storage/preference-store';

/**
 * Disabled-extensions list lives outside the per-session feature
 * registry — it's a global preference shared across every session.
 * We key against a sentinel session id so the existing
 * `PreferenceStore` shape carries it without bespoke schema work.
 */
export const EXTENSIONS_DISABLED_KEY = 'extensions:disabled';
export const EXTENSIONS_DISABLED_SCOPE = '__global__';

export async function readDisabledExtensions(prefs: PreferenceStore): Promise<string[]> {
  try {
    const raw = await prefs.get(EXTENSIONS_DISABLED_SCOPE, EXTENSIONS_DISABLED_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string');
  } catch (err) {
    console.error('[extensions-prefs] read failed:', err);
    return [];
  }
}

export async function writeDisabledExtensions(
  prefs: PreferenceStore,
  names: readonly string[]
): Promise<void> {
  const dedup = Array.from(new Set(names));
  await prefs.set(EXTENSIONS_DISABLED_SCOPE, EXTENSIONS_DISABLED_KEY, dedup);
}

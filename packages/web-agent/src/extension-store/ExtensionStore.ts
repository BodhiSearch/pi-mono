/**
 * Main-thread persistence for per-extension enable/disable state.
 *
 * Uses `idb-keyval` (already a workspace dep) rather than a Dexie
 * schema migration because Phase 1's only persisted datum is a
 * `Record<string, boolean>` keyed by extension name. If Phase 2 grows
 * richer extension metadata (settings, install timestamps, version
 * pins) we can migrate to a dedicated Dexie table then.
 *
 * The store is a read-through over IndexedDB with an in-memory cache:
 * the UI reads synchronously via `snapshot()` after an initial `load()`
 * settles, and writes go through `setEnabled` / `setAllEnabled` which
 * fan out to IndexedDB and notify subscribers so multiple tabs /
 * component trees stay consistent.
 *
 * The worker doesn't read this store directly — the main thread
 * pushes the map down via the `set_extension_states` RPC command so
 * the worker remains the single source of truth for which extensions
 * are actually loaded.
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';

const STORAGE_KEY = 'web-agent.extensions.enabled';

export type ExtensionEnabledMap = Record<string, boolean>;

export interface ExtensionStoreOptions {
  /** Override the IndexedDB key (tests use this to isolate). */
  storageKey?: string;
}

type Listener = (state: ExtensionEnabledMap) => void;

export class ExtensionStore {
  private state: ExtensionEnabledMap = {};
  private loaded = false;
  private readonly listeners = new Set<Listener>();
  private readonly storageKey: string;
  /** Serialises writes so a quick toggle/untoggle can't land out of order. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(options: ExtensionStoreOptions = {}) {
    this.storageKey = options.storageKey ?? STORAGE_KEY;
  }

  /**
   * Hydrate the in-memory cache from IndexedDB. Safe to call multiple
   * times — subsequent calls short-circuit. Callers typically invoke
   * from `useExtensionState` once per mount.
   */
  async load(): Promise<ExtensionEnabledMap> {
    if (this.loaded) return this.state;
    try {
      const raw = (await idbGet(this.storageKey)) as ExtensionEnabledMap | undefined;
      if (raw && typeof raw === 'object') {
        this.state = { ...raw };
      }
    } catch (err) {
      console.error('[ExtensionStore] hydrate failed:', err);
    }
    this.loaded = true;
    return this.state;
  }

  /** Synchronous snapshot of the last-hydrated / last-written state. */
  snapshot(): ExtensionEnabledMap {
    return { ...this.state };
  }

  /** True once `load()` has settled. Useful for suppressing the UI's first render. */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Toggle / set the enabled flag for a single extension and persist.
   * Returns the persisted state so callers can push it down to the
   * worker in the same await chain.
   */
  async setEnabled(name: string, enabled: boolean): Promise<ExtensionEnabledMap> {
    this.state = { ...this.state, [name]: enabled };
    this.notify();
    this.writeChain = this.writeChain
      .then(() => idbSet(this.storageKey, this.state))
      .catch(err => console.error('[ExtensionStore] persist failed:', err));
    await this.writeChain;
    return this.state;
  }

  /**
   * Bulk-apply a partial map. Used by the "Disable all" affordance
   * (M8 trip-switch gate) and to reconcile newly-discovered extensions
   * that aren't yet in the map.
   */
  async setMany(entries: ExtensionEnabledMap): Promise<ExtensionEnabledMap> {
    this.state = { ...this.state, ...entries };
    this.notify();
    this.writeChain = this.writeChain
      .then(() => idbSet(this.storageKey, this.state))
      .catch(err => console.error('[ExtensionStore] persist failed:', err));
    await this.writeChain;
    return this.state;
  }

  /**
   * Disable every extension in `names` in one shot. Equivalent to
   * `setMany(names.reduce(..., false))` but reads more clearly at the
   * call site.
   */
  async disableAll(names: string[]): Promise<ExtensionEnabledMap> {
    const entries: ExtensionEnabledMap = {};
    for (const n of names) entries[n] = false;
    return this.setMany(entries);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch (err) {
        console.error('[ExtensionStore] listener threw:', err);
      }
    }
  }
}

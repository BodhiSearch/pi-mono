/**
 * Worker-side controller for extension-contributed LLM providers.
 *
 * Responsibilities:
 *  - Own the `Map<extensionPath, RegisteredProvider[]>` that backs the
 *    composite LLM provider the host consults.
 *  - Expose `composite()` — a single `LlmProvider` that dispatches
 *    `getApiKeyAndHeaders` / `getAvailableModels` / `setAuthToken` to
 *    the first contributing provider whose `providerId` matches,
 *    falling back to the host's built-in (Bodhi) provider.
 *  - Reconcile on extension enable/disable churn: whenever the set of
 *    loaded extensions changes the host calls `setFromExtensions` and
 *    we emit `extension_providers_changed` so the main thread's model
 *    picker refreshes.
 *
 * Kept small and stateful — no RPC plumbing lives here. The host
 * passes `emitEvent` which the controller uses once per churn.
 */

import type { Api, Model } from '@mariozechner/pi-ai';
import type { Extension, RegisteredProvider } from '../core/extensions/types';
import type { LlmAuthCredential, LlmProvider } from '../llm/types';
import type { ExtensionProviderDescriptor, RpcEventEnvelope } from '../rpc/rpc-types';

export type ProviderEventEmitter = (event: RpcEventEnvelope) => void;

export interface ExtensionProviderControllerOptions {
  /**
   * Built-in provider consulted when no extension contribution matches
   * the requested `model.provider`. Mirrors coding-agent's behaviour:
   * extensions override, the host falls through.
   */
  base: LlmProvider;
  /** Sink for `extension_providers_changed` events. */
  emitEvent: ProviderEventEmitter;
}

export class ExtensionProviderController {
  private readonly base: LlmProvider;
  private readonly emitEvent: ProviderEventEmitter;
  /**
   * Per-extension registrations. Keyed by extension path so unloading
   * an extension cleanly drops every provider it contributed.
   */
  private readonly byExtension = new Map<string, RegisteredProvider[]>();
  /**
   * Flat `providerId → provider` map rebuilt on every churn. Later
   * registrations under the same id win — mirrors the "first match wins"
   * precedence `buildComposite` enforces.
   */
  private lookup = new Map<string, RegisteredProvider>();

  constructor(options: ExtensionProviderControllerOptions) {
    this.base = options.base;
    this.emitEvent = options.emitEvent;
  }

  /**
   * Replace the entire registration set from a freshly-loaded extension
   * list. Emits `extension_providers_changed` iff the descriptor set
   * actually changed — callers can call `setFromExtensions` on every
   * reload without spamming the main thread.
   */
  setFromExtensions(extensions: Extension[]): void {
    const before = this.descriptorsSignature();
    this.byExtension.clear();
    this.lookup.clear();
    for (const ext of extensions) {
      const entries: RegisteredProvider[] = [];
      for (const [, prov] of ext.providers) {
        entries.push(prov);
        // Later extensions in load order override earlier ones for the
        // same providerId. Stable load order is the loader's contract.
        this.lookup.set(prov.providerId, prov);
      }
      if (entries.length > 0) this.byExtension.set(ext.path, entries);
    }
    const after = this.descriptorsSignature();
    if (before !== after) this.emitChanged();
  }

  /** Drop everything (e.g. vault unmount). Emits the cleared state. */
  clear(): void {
    if (this.byExtension.size === 0 && this.lookup.size === 0) return;
    this.byExtension.clear();
    this.lookup.clear();
    this.emitChanged();
  }

  /** Plain-data listing surfaced to the main thread. */
  list(): ExtensionProviderDescriptor[] {
    const out: ExtensionProviderDescriptor[] = [];
    for (const [path, entries] of this.byExtension) {
      for (const p of entries) {
        out.push({ providerId: p.providerId, extensionPath: path });
      }
    }
    return out;
  }

  /**
   * Composite provider: extension contributions win by `model.provider`
   * match, otherwise we fall through to the base provider. Catalogs
   * are merged (extension entries first so they show up at the top of
   * the model picker). `setAuthToken` fans out to everyone.
   */
  composite(): LlmProvider {
    const base = this.base;
    const get = (providerId: string): LlmProvider | null => {
      return this.lookup.get(providerId)?.provider ?? null;
    };
    return {
      getApiKeyAndHeaders: async model => {
        const match = get(model.provider);
        if (match) return match.getApiKeyAndHeaders(model);
        return base.getApiKeyAndHeaders(model);
      },
      getAvailableModels: async () => {
        const chunks: Model<Api>[][] = [];
        for (const [, reg] of this.lookup) {
          try {
            chunks.push(await reg.provider.getAvailableModels());
          } catch (err) {
            console.error(
              `[ExtensionProviderController] ${reg.providerId}.getAvailableModels failed:`,
              err
            );
          }
        }
        try {
          chunks.push(await base.getAvailableModels());
        } catch (err) {
          console.error('[ExtensionProviderController] base.getAvailableModels failed:', err);
        }
        // De-duplicate `(provider, id)` pairs, preferring the first
        // occurrence (extension entries are pushed before base).
        const seen = new Set<string>();
        const out: Model<Api>[] = [];
        for (const chunk of chunks) {
          for (const m of chunk) {
            const key = `${m.provider}::${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(m);
          }
        }
        return out;
      },
      setAuthToken: (credential: LlmAuthCredential | null) => {
        for (const [, reg] of this.lookup) {
          try {
            reg.provider.setAuthToken?.(credential);
          } catch (err) {
            console.error(
              `[ExtensionProviderController] ${reg.providerId}.setAuthToken failed:`,
              err
            );
          }
        }
        base.setAuthToken?.(credential);
      },
    };
  }

  /**
   * Stable signature used to detect whether the descriptor list
   * actually changed. Using a sorted string keeps the comparison
   * O(n log n) and allocation-light on the happy path.
   */
  private descriptorsSignature(): string {
    return this.list()
      .map(d => `${d.providerId}@${d.extensionPath}`)
      .sort()
      .join('|');
  }

  private emitChanged(): void {
    this.emitEvent({
      type: 'extension_providers_changed',
      providers: this.list(),
    });
  }
}

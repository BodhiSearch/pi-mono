/**
 * Worker-side controller for extension-contributed skills.
 *
 * Responsibilities:
 *  - Own the flat `RegisteredSkill[]` the `CommandRegistry` exposes as
 *    `source: 'extension-skill'` in the slash palette.
 *  - Reconcile on extension churn: every `loadFromVault` call passes
 *    the fresh `Extension[]` list, we rebuild the in-memory store, and
 *    push the result into the registry in a single `setExtensionSkills`
 *    call.
 *  - Expose a `resolveInlineScript` hook for future `bash-skill`
 *    integration: when a skill body references an inline script via
 *    the `<!-- pi:script NAME -->` directive, the resolver can return
 *    the stored body by `(extensionPath, name)`. Phase 2b doesn't
 *    evaluate the scripts; the hook simply gives us a landing spot so
 *    Phase 3 can wire it without another interface change.
 *
 * The controller is deliberately thin — extension skills are inert
 * prompt bodies in 2b, so the bulk of the work is just registry
 * plumbing + membership lookups.
 */

import type { CommandRegistry } from '../core/commands';
import type { Extension, RegisteredSkill } from '../core/extensions/types';

export interface ExtensionSkillControllerOptions {
  /** The shared command registry that backs the autocomplete palette. */
  registry: CommandRegistry;
}

export class ExtensionSkillController {
  private readonly registry: CommandRegistry;
  /** Keyed by extensionPath for fast drop-on-unload. */
  private readonly byExtension = new Map<string, RegisteredSkill[]>();
  /** Flat view kept in sync with `byExtension`; handed to the registry. */
  private flat: RegisteredSkill[] = [];

  constructor(options: ExtensionSkillControllerOptions) {
    this.registry = options.registry;
  }

  /**
   * Replace the entire registration set from a freshly-loaded
   * extension list. Always pushes to the registry (same semantics as
   * `setExtensionCommands`) — the cost is trivial and avoids a
   * membership-signature comparison here.
   */
  setFromExtensions(extensions: Extension[]): void {
    this.byExtension.clear();
    const flat: RegisteredSkill[] = [];
    const seen = new Set<string>();
    for (const ext of extensions) {
      const entries: RegisteredSkill[] = [];
      for (const [name, skill] of ext.skills) {
        entries.push(skill);
        // First-wins dedupe so the registry doesn't surface the same
        // `skill:<name>` twice. Extensions loaded earlier in the sort
        // order shadow later ones — mirrors the regular skills loader.
        if (seen.has(name)) continue;
        seen.add(name);
        flat.push(skill);
      }
      if (entries.length > 0) this.byExtension.set(ext.path, entries);
    }
    this.flat = flat;
    this.registry.setExtensionSkills(flat);
  }

  /** Drop everything (vault unmount). Pushes the cleared state. */
  clear(): void {
    this.byExtension.clear();
    this.flat = [];
    this.registry.clearExtensionSkills();
  }

  /**
   * Flat listing of every extension-contributed skill currently live.
   * Used by tests + the main-thread palette hydrate step.
   */
  list(): RegisteredSkill[] {
    return this.flat;
  }

  /**
   * Resolve an inline script body by name. Scoped to the specified
   * extension so two extensions can safely ship a script named
   * `summarize.sh` without collision. Returns `undefined` when the
   * script isn't found — callers should surface that as a user-facing
   * error (e.g. "bash-skill: unknown script NAME").
   *
   * Phase 2b carries the hook without any ScriptSourceResolver
   * integration inside `bash-skill` — that landing arrives in Phase 3
   * alongside a browser-side `bash-skill` runtime story. Keeping the
   * method here means the interface is in place now.
   */
  resolveInlineScript(extensionPath: string, name: string): string | undefined {
    const bucket = this.byExtension.get(extensionPath);
    if (!bucket) return undefined;
    const match = bucket.find(s => s.name === name);
    return match?.body;
  }
}

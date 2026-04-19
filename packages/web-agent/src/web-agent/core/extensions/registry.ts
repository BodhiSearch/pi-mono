import type { Extension } from './types';

/**
 * In-memory static extension registry.
 *
 * Phase 5 replaces this with a loader that downloads manifests + bundles
 * and stores them in a dedicated ZenFS mount. Phase 1 provides just the
 * type-safe surface so other modules can depend on it.
 */
export class ExtensionRegistry {
  private readonly byName = new Map<string, Extension>();

  register(extension: Extension): void {
    this.byName.set(extension.name, extension);
  }

  unregister(name: string): boolean {
    return this.byName.delete(name);
  }

  get(name: string): Extension | undefined {
    return this.byName.get(name);
  }

  list(): Extension[] {
    return [...this.byName.values()];
  }

  clear(): void {
    this.byName.clear();
  }
}

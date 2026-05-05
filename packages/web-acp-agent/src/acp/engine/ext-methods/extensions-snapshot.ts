import type { ExtensionRegistry } from '../../../agent/extensions/registry';
import type { BodhiExtensionDescriptor } from '../../../wire';

export interface ExtensionsSnapshot extends Record<string, unknown> {
  extensions: BodhiExtensionDescriptor[];
  disabled: string[];
  knownNames: string[];
}

export function buildExtensionsSnapshot(
  registry: ExtensionRegistry | undefined
): ExtensionsSnapshot {
  const list = registry?.list() ?? [];
  return {
    extensions: list.map(ext => ({
      name: ext.name,
      mountName: ext.mountName,
      sourcePath: ext.sourcePath,
      capabilities: {
        events: [...ext.capabilities.events],
        tools: [...ext.capabilities.tools],
        commands: [...ext.capabilities.commands],
        providers: [...ext.capabilities.providers],
      },
    })),
    disabled: registry?.getDisabled() ?? [],
    knownNames: registry?.getKnownNames() ?? [],
  };
}

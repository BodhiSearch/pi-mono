import { installExtensionFromNpm } from '../../../agent/extensions';
import { WELL_KNOWN_VOLUME_TAGS } from '../../../agent/well-known-volume-tags';
import type { BodhiExtensionsAddRequest, BodhiExtensionsAddResponse } from '../../../wire';
import type { ExtMethodHost } from '../types';
import { buildExtensionsSnapshot } from './extensions-snapshot';

/**
 * Resolve `spec` against the npm registry, fetch the matching
 * tarball, write its contents under
 * `<agent-wd>/.pi/extensions/<extensionName>/`, then reload the
 * registry so the new extension surfaces in
 * `_bodhi/extensions/list`. The agent broadcasts
 * `_bodhi/extensions/state` on success so hosts refresh without
 * polling.
 */
export async function extensionsAdd(
  params: unknown,
  host: ExtMethodHost
): Promise<BodhiExtensionsAddResponse> {
  if (!host.extensions) {
    throw new Error('extensions:registry-missing — agent was started without an ExtensionRegistry');
  }
  if (!host.registry) {
    throw new Error('extensions:volume-registry-missing — no VolumeRegistry was provided');
  }
  if (!host.extensionsWriteFs) {
    throw new Error('extensions:write-fs-missing — host did not provide an ExtensionsWriteFs');
  }
  const req = (params ?? {}) as BodhiExtensionsAddRequest;
  if (typeof req.spec !== 'string' || req.spec.trim() === '') {
    throw new Error('extensions:bad-request — `spec` must be a non-empty string');
  }
  const target = host.registry.findByTag(WELL_KNOWN_VOLUME_TAGS.AGENT_WD);
  if (!target) {
    throw new Error(
      `extensions:no-agent-wd-volume — no mounted volume is tagged '${WELL_KNOWN_VOLUME_TAGS.AGENT_WD}'`
    );
  }

  const installed = await installExtensionFromNpm({
    spec: req.spec,
    agentWdMount: target.mountName,
    writeFs: host.extensionsWriteFs,
    ...(typeof req.registryUrl === 'string' ? { registryUrl: req.registryUrl } : {}),
  });

  await host.extensions.reload();
  const snapshot = buildExtensionsSnapshot(host.extensions);
  await host.broadcastExtensionsState(snapshot);
  return {
    installed: {
      name: installed.name,
      version: installed.version,
      extensionName: installed.extensionName,
      installPath: installed.installPath,
    },
    extensions: snapshot.extensions,
    disabled: snapshot.disabled,
    knownNames: snapshot.knownNames,
  };
}

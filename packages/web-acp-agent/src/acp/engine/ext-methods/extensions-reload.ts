import {
  readDisabledExtensions,
  writeDisabledExtensions,
} from '../../../agent/internal/extensions-prefs';
import type { BodhiExtensionsReloadRequest, BodhiExtensionsReloadResponse } from '../../../wire';
import type { ExtMethodHost } from '../types';
import { buildExtensionsSnapshot } from './extensions-snapshot';

/**
 * Re-discover extensions and apply the disabled set. When the
 * caller passes `disabled`, that list is persisted via
 * `extensions:disabled` (global preference) before the reload so
 * the toggle survives a hard refresh.
 */
export async function extensionsReload(
  params: unknown,
  host: ExtMethodHost
): Promise<BodhiExtensionsReloadResponse> {
  if (!host.extensions) {
    return { extensions: [], disabled: [], knownNames: [] };
  }
  const req = (params ?? {}) as BodhiExtensionsReloadRequest;
  const incoming = Array.isArray(req.disabled)
    ? req.disabled.filter((v): v is string => typeof v === 'string')
    : null;

  let nextDisabled: string[];
  if (incoming) {
    if (host.preferences) {
      await writeDisabledExtensions(host.preferences, incoming);
    }
    nextDisabled = incoming;
  } else if (host.preferences) {
    nextDisabled = await readDisabledExtensions(host.preferences);
  } else {
    nextDisabled = host.extensions.getDisabled();
  }

  host.extensions.setDisabled(nextDisabled);
  await host.extensions.reload();

  const snapshot = buildExtensionsSnapshot(host.extensions);
  await host.broadcastExtensionsState(snapshot);
  return snapshot;
}

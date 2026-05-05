import type { BodhiExtensionsListResponse } from '../../../wire';
import type { ExtMethodHost } from '../types';
import { buildExtensionsSnapshot } from './extensions-snapshot';

export async function extensionsList(
  _params: unknown,
  host: ExtMethodHost
): Promise<BodhiExtensionsListResponse> {
  return buildExtensionsSnapshot(host.extensions);
}

import type { BodhiServerInfoResponse } from '../../../wire';
import type { ExtMethodHost } from '../types';

/**
 * `_bodhi/server/info` — proxy to BodhiApp's `/bodhi/v1/info` under the
 * authenticated bearer token. Returns the response body verbatim
 * (snake_case fields preserved).
 *
 * Use case: after `authenticate`, the host calls this to confirm the
 * agent can actually reach BodhiApp. Throws if the underlying HTTP
 * call fails — surfaces as a JSON-RPC error to the client.
 */
export async function serverInfo(
  _params: unknown,
  host: ExtMethodHost
): Promise<BodhiServerInfoResponse> {
  const body = await host.bodhi.fetchServerInfo();
  return body as BodhiServerInfoResponse;
}

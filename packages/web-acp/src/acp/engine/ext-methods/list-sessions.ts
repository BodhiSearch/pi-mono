import type { BodhiListSessionsResponse } from '../../index';
import type { ExtMethodHost } from '../types';

export async function listSessions(
  _params: unknown,
  host: ExtMethodHost
): Promise<BodhiListSessionsResponse> {
  const summaries = host.store ? await host.store.listSummaries() : [];
  return { sessions: summaries };
}

import {
  BODHI_SESSIONS_DELETE_METHOD,
  type BodhiSessionsDeleteRequest,
  type BodhiSessionsDeleteResponse,
} from '../../../wire';
import type { ExtMethodHost } from '../types';

export async function sessionsDelete(
  params: unknown,
  host: ExtMethodHost
): Promise<BodhiSessionsDeleteResponse> {
  if (!host.store) {
    throw new Error(`${BODHI_SESSIONS_DELETE_METHOD}: no session store configured`);
  }
  const req = params as BodhiSessionsDeleteRequest;
  if (!req || typeof req.sessionId !== 'string') {
    throw new Error(`${BODHI_SESSIONS_DELETE_METHOD}: params.sessionId is required`);
  }
  const row = await host.store.getSession(req.sessionId);
  if (!row) {
    return { deleted: false };
  }
  // Runtime enforces teardown order so late stream events cannot land
  // on a row about to disappear.
  await host.tearDownSession(req.sessionId, {
    persistRow: false,
    abortPromptIfActive: host.abortPromptIfActive,
  });
  return { deleted: true };
}

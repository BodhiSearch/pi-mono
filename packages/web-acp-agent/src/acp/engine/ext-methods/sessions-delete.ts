import {
	BODHI_SESSIONS_DELETE_METHOD,
	type BodhiSessionsDeleteRequest,
	type BodhiSessionsDeleteResponse,
} from "../../../wire";
import type { ExtMethodHost } from "../types";

export async function sessionsDelete(params: unknown, host: ExtMethodHost): Promise<BodhiSessionsDeleteResponse> {
	if (!host.store) {
		throw new Error(`${BODHI_SESSIONS_DELETE_METHOD}: no session store configured`);
	}
	const req = params as BodhiSessionsDeleteRequest;
	if (!req || typeof req.sessionId !== "string") {
		throw new Error(`${BODHI_SESSIONS_DELETE_METHOD}: params.sessionId is required`);
	}
	const row = await host.store.getSession(req.sessionId);
	if (!row) {
		return { deleted: false };
	}
	// Drop in-memory state before the row vanishes so a stray late
	// event for this session can't reattach to a phantom entry.
	await host.mcpPool.releaseAll(req.sessionId);
	host.sessions.delete(req.sessionId);
	if (host.getActiveInlineSessionId() === req.sessionId) {
		host.setActiveInlineSessionId(null);
		host.inline.clearMessages();
	}
	await host.store.deleteSession(req.sessionId);
	return { deleted: true };
}

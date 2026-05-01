import type { Client } from "@agentclientprotocol/sdk";

/**
 * Stub for ACP `session/request_permission`. The bridge is **deferred**
 * post-M2 — see `ai-docs/web-acp/milestones/deferred.md` for the
 * pre-execution classifier + allow-always persistence design that
 * re-enters at a future milestone kickoff.
 *
 * Until then the worker's `bash` tool runs commands as-is, so the
 * client never receives a `session/request_permission` request — but
 * we still implement the handler so an externally-connected ACP agent
 * speaking the same wire surface gets a structured error rather than
 * an undefined-method failure.
 */
export const requestPermissionStub: Client["requestPermission"] = async () => {
	throw new Error("requestPermission: not supported in web-acp M0");
};

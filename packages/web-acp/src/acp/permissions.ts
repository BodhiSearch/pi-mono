/**
 * Re-export of the agent-package stub. The bridge is **deferred**
 * post-M2 — see `ai-docs/web-acp/milestones/deferred.md` for the
 * pre-execution classifier + allow-always persistence design that
 * re-enters at a future milestone kickoff.
 *
 * Until then the worker's `bash` tool runs commands as-is, so the
 * client never receives a `session/request_permission` request — but
 * we still wire the stub so an externally-connected ACP agent
 * speaking the same wire surface gets a structured error rather
 * than an undefined-method failure. Re-exporting the agent-side
 * stub guarantees host and agent agree on the rejection shape.
 */
export { requestPermissionStub } from '@bodhiapp/web-acp-agent';

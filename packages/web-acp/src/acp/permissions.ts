/**
 * Re-export of the agent-package permission stub. The full bridge is
 * deferred — see `ai-docs/web-acp/milestones/deferred.md` for the
 * pre-execution classifier + allow-always persistence design.
 *
 * Until then the worker's `bash` tool runs commands as-is, so the
 * client never receives a `session/request_permission` request — but
 * we still wire the stub so an externally-connected ACP agent
 * speaking the same wire surface gets a structured error rather
 * than an undefined-method failure. Re-exporting the agent-side
 * stub guarantees host and agent agree on the rejection shape.
 */
export { requestPermissionStub } from '@bodhiapp/web-acp-agent';

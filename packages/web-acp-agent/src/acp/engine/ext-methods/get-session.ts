import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { BuiltinPayload, TurnPayload } from "../../../storage/session-store";
import { BODHI_GET_SESSION_METHOD, type BodhiGetSessionRequest, type BodhiGetSessionResponse } from "../../../wire";
import { makeBuiltinAssistantMessage, makeBuiltinUserMessage, toWireMcpToggles } from "../../wire-utils";
import type { ExtMethodHost } from "../types";

export async function getSession(params: unknown, host: ExtMethodHost): Promise<BodhiGetSessionResponse> {
	if (!host.store) {
		throw new Error(`${BODHI_GET_SESSION_METHOD}: no session store configured`);
	}
	const req = params as BodhiGetSessionRequest;
	if (!req || typeof req.sessionId !== "string") {
		throw new Error(`${BODHI_GET_SESSION_METHOD}: params.sessionId is required`);
	}
	const row = await host.store.getSession(req.sessionId);
	if (!row) {
		throw new Error(`${BODHI_GET_SESSION_METHOD}: unknown session '${req.sessionId}'`);
	}
	const entries = await host.store.readEntries(req.sessionId);
	// Walk entries in seq order to build the rendered transcript:
	// - 'turn' entries carry the cumulative LLM-visible history;
	//   we append the delta from the previous turn's snapshot.
	// - 'builtin' entries are inserted as a tagged user+assistant
	//   pair so reload reproduces them in the right chronological
	//   slot. They never feed `inline.restoreMessages()` because
	//   that path consumes only 'turn' kinds.
	let lastTurnMessages: AgentMessage[] = [];
	const messages: unknown[] = [];
	for (const entry of entries) {
		if (entry.kind === "turn") {
			const payload = entry.payload as TurnPayload;
			const next = Array.isArray(payload.finalMessages) ? payload.finalMessages : [];
			if (next.length > lastTurnMessages.length) {
				messages.push(...next.slice(lastTurnMessages.length));
			}
			lastTurnMessages = next;
		} else if (entry.kind === "builtin") {
			const payload = entry.payload as BuiltinPayload;
			const tag = {
				command: payload.command,
				...(payload.action ? { action: payload.action } : {}),
			};
			messages.push(makeBuiltinUserMessage(payload.userText, tag));
			messages.push(makeBuiltinAssistantMessage(payload.replyText, tag));
		}
	}
	const mcpToggles = await host.readMcpToggles(req.sessionId);
	return {
		sessionId: row.id,
		messages,
		lastModelId: row.lastModelId,
		title: row.title,
		mcpToggles: toWireMcpToggles(mcpToggles),
	};
}

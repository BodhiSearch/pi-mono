import type {
	AgentSideConnection,
	AvailableCommand,
	McpServerHttp,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import { type CommandDef, loadCommandsFromVolumes, loadPromptsFromVolumes } from "../../agent/commands";
import { builtinAvailableCommands } from "../../agent/commands/builtins";
import { createMcpAgentTool, type McpPoolEvent, type McpToolDetails } from "../../agent/mcp";
import { FEATURE_DEFAULTS, type FeatureSnapshot } from "../../storage/feature-store";
import { isToolEnabled, type McpToggleSnapshot } from "../../storage/mcp-toggle-store";
import { toAvailableCommand } from "../wire-utils";
import type { AcpAdapterServices } from "./services";
import type { SessionState } from "./types";

/**
 * Lifecycle orchestrator for ACP sessions. Owns:
 *
 * - the per-session in-memory map (`#sessions`),
 * - which session's history is currently loaded into the inline
 *   pi-agent-core runtime (`#activeInlineSessionId`),
 * - the cached vault command list shared across sessions,
 * - the LLM model catalog cache,
 * - MCP pool acquire / release / tool-listing / lifecycle broadcast,
 * - feature / toggle store reads (with safe-default fallbacks),
 * - the rehydrate-from-store path used when a `prompt` arrives for a
 *   session whose history isn't in the inline runtime.
 *
 * Mirrors coding-agent's `agent-session-runtime.ts` — different state
 * (ACP doesn't carry a state machine like steering / compaction yet),
 * same role: orchestrate session lifecycle and own per-session state
 * the wire shim doesn't.
 */
export class AcpSessionRuntime {
	readonly #conn: AgentSideConnection;
	readonly #services: AcpAdapterServices;
	readonly #mcpSubscription: () => void;
	readonly #sessions = new Map<string, SessionState>();
	#availableCommands: CommandDef[] = [];
	#models: Model<Api>[] = [];
	/**
	 * The `InlineAgent` holds a single `pi-agent-core` runtime that carries
	 * one message history at a time. We must remember which session's
	 * history is currently loaded into it so that `prompt` calls coming
	 * in for a different session don't accidentally splice contexts
	 * together (which would poison the next `recordTurn`'s
	 * `finalMessages`).
	 */
	#activeInlineSessionId: string | null = null;

	constructor(conn: AgentSideConnection, services: AcpAdapterServices) {
		this.#conn = conn;
		this.#services = services;
		this.#mcpSubscription = this.#services.mcpPool.subscribe((event) => {
			void this.broadcastMcpPoolEvent(event);
		});
	}

	// ----- session map accessors -----

	getSession(id: string): SessionState | undefined {
		return this.#sessions.get(id);
	}

	setSession(id: string, state: SessionState): void {
		this.#sessions.set(id, state);
	}

	deleteSessionEntry(id: string): void {
		this.#sessions.delete(id);
	}

	/** Read-only view of the whole session map. */
	get sessions(): Map<string, SessionState> {
		return this.#sessions;
	}

	// ----- inline-history-attach bookkeeping -----

	getActiveInlineSessionId(): string | null {
		return this.#activeInlineSessionId;
	}

	setActiveInlineSessionId(id: string | null): void {
		this.#activeInlineSessionId = id;
	}

	// ----- model catalog cache -----

	getModels(): Model<Api>[] {
		return this.#models;
	}

	setModels(models: Model<Api>[]): void {
		this.#models = models;
	}

	// ----- vault commands cache -----

	getAvailableCommands(): CommandDef[] {
		return this.#availableCommands;
	}

	// ----- store reads with safe-default fallbacks -----

	async readFeatures(sessionId: string): Promise<FeatureSnapshot> {
		if (!this.#services.features) {
			return { ...FEATURE_DEFAULTS };
		}
		try {
			return await this.#services.features.get(sessionId);
		} catch (err) {
			console.error("[acp-session-runtime] failed to load features:", err);
			return { ...FEATURE_DEFAULTS };
		}
	}

	async readMcpToggles(sessionId: string): Promise<McpToggleSnapshot> {
		if (!this.#services.mcpToggles) return { servers: {}, tools: {} };
		try {
			return await this.#services.mcpToggles.get(sessionId);
		} catch (err) {
			console.error("[acp-session-runtime] failed to load mcp toggles:", err);
			return { servers: {}, tools: {} };
		}
	}

	// ----- MCP lifecycle -----

	/**
	 * Acquire each MCP server for the given session. Errors from the
	 * pool are swallowed here — the pool already emits `error` events
	 * that travel through `broadcastMcpPoolEvent`, and the session
	 * itself should still be usable even if a single MCP server fails
	 * to connect (the tool simply won't be registered).
	 */
	async acquireMcpConnections(sessionId: string, servers: McpServerHttp[]): Promise<void> {
		await Promise.all(
			servers.map(async (cfg) => {
				try {
					await this.#services.mcpPool.acquire(sessionId, cfg);
				} catch (err) {
					console.error(`[acp-session-runtime] MCP acquire failed for ${cfg.name}:`, err);
				}
			}),
		);
	}

	async releaseMcpConnections(sessionId: string, servers: McpServerHttp[]): Promise<void> {
		await Promise.all(servers.map((cfg) => this.#services.mcpPool.release(sessionId, cfg)));
	}

	/**
	 * Build the per-turn MCP tool list for the session by reading the
	 * cached `tools/list` catalog from the pool and adapting every tool
	 * into an `AgentTool`. Tools from servers that failed to connect
	 * are silently omitted. Per-tool toggles filter further here
	 * (server-level toggles are already applied upstream in
	 * `composeMcpServers`, so the worker never sees those servers).
	 */
	mcpToolsForSession(session: SessionState, toggles: McpToggleSnapshot): AgentTool<TSchema, McpToolDetails>[] {
		const out: AgentTool<TSchema, McpToolDetails>[] = [];
		for (const cfg of session.mcpServers) {
			const client = this.#services.mcpPool.getClient(cfg);
			if (!client) continue;
			const tools = this.#services.mcpPool.getTools(cfg);
			for (const tool of tools) {
				if (!isToolEnabled(toggles, cfg.name, tool.name)) continue;
				out.push(createMcpAgentTool({ client, serverName: cfg.name, tool }));
			}
		}
		return out;
	}

	/**
	 * Forward MCP pool lifecycle events to every known session as a
	 * `session/update` notification carrying `_meta.bodhi.mcp`. ACP
	 * doesn't define a first-class transport-level verb, so we ride on
	 * an empty `agent_message_chunk` — the main thread's hook filters
	 * by `_meta.bodhi.mcp` before touching the message stream.
	 *
	 * These events are **transient**: they describe the live state of
	 * the worker's pool, which is rebuilt from scratch on every
	 * `session/load`. We send them to the client directly but do NOT
	 * persist them via `recordNotification`, because otherwise a
	 * subsequent `loadSession` would replay stale `connecting` /
	 * `connected` events after the pool has already emitted a fresh
	 * `disconnected` (e.g. following a per-server toggle flip).
	 */
	async broadcastMcpPoolEvent(event: McpPoolEvent): Promise<void> {
		const affected = new Set<string>();
		for (const [sessionId, state] of this.#sessions) {
			if (state.mcpServers.some((cfg) => cfg.name === event.server && cfg.url === event.url)) {
				affected.add(sessionId);
			}
		}
		if (affected.size === 0) return;
		const meta = {
			bodhi: {
				mcp: {
					server: event.server,
					state: event.type,
					...(event.error ? { error: event.error } : {}),
					...(event.tools ? { tools: event.tools } : {}),
				},
			},
		};
		await Promise.all(
			[...affected].map((sessionId) =>
				this.#conn.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "" },
					},
					_meta: meta,
				} as SessionNotification),
			),
		);
	}

	// ----- inline rehydrate -----

	async rehydrateInlineFromStore(sessionId: string): Promise<void> {
		const inline = this.#services.inline;
		if (!this.#services.store) {
			inline.clearMessages();
			this.#activeInlineSessionId = sessionId;
			return;
		}
		const entries = await this.#services.store.readEntries(sessionId);
		let lastTurnMessages: AgentMessage[] | undefined;
		for (const entry of entries) {
			if (entry.kind === "turn") {
				const payload = entry.payload as { finalMessages?: AgentMessage[] };
				if (Array.isArray(payload.finalMessages)) {
					lastTurnMessages = payload.finalMessages;
				}
			}
		}
		if (lastTurnMessages) {
			inline.restoreMessages(lastTurnMessages);
		} else {
			inline.clearMessages();
		}
		this.#activeInlineSessionId = sessionId;
	}

	// ----- vault command refresh -----

	/**
	 * Refresh the cached vault command list and emit the matching
	 * `available_commands_update` notification for the given session.
	 * Called once at the end of `newSession` and `loadSession`. The
	 * cached `CommandDef[]` is shared across sessions because the vault
	 * is per-worker, but each notification carries its own `sessionId`
	 * so the persisted-replay path stays accurate.
	 *
	 * M4 phase B: agent-handled built-ins (`/help`, `/version`, …) ride
	 * the same wire — merged into the advertised list so the picker
	 * stays a black-box consumer of `AvailableCommand[]`.
	 *
	 * M4.2: vault-sourced prompt templates from `<mount>/.pi/prompts/`
	 * register alongside commands. Both surface as `AvailableCommand`
	 * (no kind discriminator on the wire); commands win on canonical-
	 * name collisions and the prompt is dropped with a warning.
	 */
	async refreshAvailableCommands(sessionId: string): Promise<void> {
		const mounts = this.#services.registry?.list() ?? [];
		let cmdDefs: CommandDef[] = [];
		let promptDefs: CommandDef[] = [];
		if (mounts.length > 0) {
			try {
				cmdDefs = await loadCommandsFromVolumes({
					mounts,
					fs: this.#services.commandsFs,
				});
			} catch (err) {
				console.error("[acp-session-runtime] command load failed:", err);
				cmdDefs = [];
			}
			try {
				promptDefs = await loadPromptsFromVolumes({
					mounts,
					fs: this.#services.commandsFs,
				});
			} catch (err) {
				console.error("[acp-session-runtime] prompt load failed:", err);
				promptDefs = [];
			}
		}
		const merged: CommandDef[] = [...cmdDefs];
		const seenNames = new Set(cmdDefs.map((d) => d.name));
		for (const def of promptDefs) {
			if (seenNames.has(def.name)) {
				const existing = cmdDefs.find((d) => d.name === def.name);
				const existingPath = existing
					? `/mnt/${existing.source.mountName}/${existing.source.relPath}`
					: "(unknown command)";
				console.warn(
					`[prompts] '${def.name}' from /mnt/${def.source.mountName}/${def.source.relPath} ` +
						`ignored (command with the same name already registered from ${existingPath})`,
				);
				continue;
			}
			merged.push(def);
			seenNames.add(def.name);
		}
		this.#availableCommands = merged;
		const availableCommands: AvailableCommand[] = [...builtinAvailableCommands(), ...merged.map(toAvailableCommand)];
		await this.emit({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands,
			},
		});
	}

	// ----- builtin context helpers -----

	async sessionStatsFor(sessionId: string): Promise<{ turnCount: number; messageCount: number }> {
		const messageCount = this.#services.inline.getMessages().length;
		if (!this.#services.store) return { turnCount: 0, messageCount };
		try {
			const row = await this.#services.store.getSession(sessionId);
			return { turnCount: row?.turnCount ?? 0, messageCount };
		} catch {
			return { turnCount: 0, messageCount };
		}
	}

	mcpConnectedFor(sessionId: string): string[] {
		const session = this.#sessions.get(sessionId);
		if (!session) return [];
		const out: string[] = [];
		for (const cfg of session.mcpServers) {
			if (this.#services.mcpPool.getClient(cfg)) out.push(cfg.name);
		}
		return out;
	}

	// ----- wire helper -----

	/**
	 * Single exit point for every persisted `session/update`
	 * notification. Emits to the client AND persists the notification
	 * in the session store so `session/load` can re-emit the exact
	 * same bytes later.
	 *
	 * Use this for events that should survive reload. For transient
	 * events (MCP pool lifecycle), call `#conn.sessionUpdate` directly
	 * via `broadcastMcpPoolEvent`.
	 */
	async emit(notification: SessionNotification): Promise<void> {
		await this.#conn.sessionUpdate(notification);
		if (this.#services.store) {
			try {
				await this.#services.store.recordNotification(notification.sessionId, notification);
			} catch (err) {
				console.error("[acp-session-runtime] failed to persist notification:", err);
			}
		}
	}

	// ----- direct conn passthrough for non-persisted updates -----

	/**
	 * Send a `session/update` directly to the client without
	 * persisting. Used by built-in command replies (which persist as
	 * `'builtin'` entries instead) and `loadSession` replay (where the
	 * store already has the row).
	 */
	async sendRawNotification(notification: SessionNotification): Promise<void> {
		await this.#conn.sessionUpdate(notification);
	}

	// ----- teardown -----

	async dispose(): Promise<void> {
		this.#mcpSubscription();
		const sessionIds = [...this.#sessions.keys()];
		await Promise.all(sessionIds.map((id) => this.#services.mcpPool.releaseAll(id)));
		this.#sessions.clear();
	}
}

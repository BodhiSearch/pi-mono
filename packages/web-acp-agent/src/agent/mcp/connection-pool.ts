/**
 * Refcounted MCP connection pool.
 *
 * Multiple sessions can reuse the same underlying `Client` when they
 * target the same proxy URL and present the same auth fingerprint
 * (currently the `Authorization` header value). The pool:
 *
 * - Connects via `createMcpClient` on first `acquire()` for a URL.
 * - Calls `tools/list` immediately so consumers see the tool catalog
 *   synchronously after `acquire()` resolves.
 * - Evicts and recreates the connection if the auth fingerprint
 *   changes (e.g. after JWT rotation triggers a `session/load`).
 * - Closes the underlying client when the last session releases it.
 *
 * The pool never swallows transport errors: a failed `acquire()`
 * surfaces the thrown error up the adapter chain so the main-thread
 * status chip flips to `error`.
 */
import type { McpServerHttp } from "@agentclientprotocol/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createMcpClient } from "./client";

export interface McpToolDescriptor {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, object>;
		required?: string[];
		[key: string]: unknown;
	};
}

export interface McpAcquireResult {
	/** Connected MCP client. Callers must not close it directly. */
	client: Client;
	/** Tool catalog returned by `tools/list` at connect time. */
	tools: McpToolDescriptor[];
}

interface PoolEntry {
	config: McpServerHttp;
	authFingerprint: string;
	client: Client;
	close: () => Promise<void>;
	tools: McpToolDescriptor[];
	refs: Set<string>;
}

/**
 * Emitter for consumers that want to observe connection lifecycle
 * transitions (used by the adapter to forward `_meta.bodhi.mcp`
 * updates to the main thread).
 */
export type McpPoolEventType = "connecting" | "connected" | "error" | "disconnected";

export interface McpPoolEvent {
	type: McpPoolEventType;
	/** Server name from the `McpServerHttp.name` field. */
	server: string;
	/** MCP proxy URL. */
	url: string;
	/** Populated when `type === 'connected'`. */
	tools?: string[];
	/** Populated when `type === 'error'`. */
	error?: string;
}

export type McpPoolListener = (event: McpPoolEvent) => void;

export class McpConnectionPool {
	readonly #entries = new Map<string, PoolEntry>();
	readonly #listeners = new Set<McpPoolListener>();

	subscribe(listener: McpPoolListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Acquire (or reuse) a connection for `config`, registering
	 * `sessionId` as a holder. If the same URL is already connected but
	 * with a different auth fingerprint, the existing entry is evicted
	 * and replaced.
	 */
	async acquire(sessionId: string, config: McpServerHttp): Promise<McpAcquireResult> {
		const key = keyOf(config);
		const fingerprint = fingerprintOf(config);
		const existing = this.#entries.get(key);
		if (existing && existing.authFingerprint === fingerprint) {
			existing.refs.add(sessionId);
			return { client: existing.client, tools: existing.tools };
		}
		if (existing) {
			await this.#evict(key, existing);
		}
		this.#emit({ type: "connecting", server: config.name, url: config.url });
		let created;
		try {
			created = await createMcpClient(config);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.#emit({ type: "error", server: config.name, url: config.url, error: message });
			throw err;
		}
		let tools: McpToolDescriptor[];
		try {
			const response = await created.client.listTools();
			tools = (response.tools ?? []).map(normaliseTool);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.#emit({ type: "error", server: config.name, url: config.url, error: message });
			try {
				await created.close();
			} catch {
				/* best effort cleanup */
			}
			throw err;
		}
		const entry: PoolEntry = {
			config,
			authFingerprint: fingerprint,
			client: created.client,
			close: created.close,
			tools,
			refs: new Set([sessionId]),
		};
		this.#entries.set(key, entry);
		this.#emit({
			type: "connected",
			server: config.name,
			url: config.url,
			tools: tools.map((t) => t.name),
		});
		return { client: entry.client, tools: entry.tools };
	}

	/**
	 * Release one sessionId's hold on the connection pool. Safe to call
	 * with configs the session never acquired.
	 */
	async release(sessionId: string, config: McpServerHttp): Promise<void> {
		const key = keyOf(config);
		const entry = this.#entries.get(key);
		if (!entry) return;
		entry.refs.delete(sessionId);
		if (entry.refs.size === 0) {
			await this.#evict(key, entry);
		}
	}

	/** Release every connection held by `sessionId`. */
	async releaseAll(sessionId: string): Promise<void> {
		const toEvict: Array<[string, PoolEntry]> = [];
		for (const [key, entry] of this.#entries) {
			entry.refs.delete(sessionId);
			if (entry.refs.size === 0) toEvict.push([key, entry]);
		}
		await Promise.all(toEvict.map(([key, entry]) => this.#evict(key, entry)));
	}

	/** Return the cached `tools/list` catalog for a previously-acquired URL. */
	getTools(config: McpServerHttp): McpToolDescriptor[] {
		return this.#entries.get(keyOf(config))?.tools ?? [];
	}

	/** Return the connected `Client` for a previously-acquired URL. */
	getClient(config: McpServerHttp): Client | undefined {
		return this.#entries.get(keyOf(config))?.client;
	}

	/** Number of live connections — useful for tests. */
	size(): number {
		return this.#entries.size;
	}

	async #evict(key: string, entry: PoolEntry): Promise<void> {
		this.#entries.delete(key);
		try {
			await entry.close();
		} catch (err) {
			console.warn("[mcp-pool] close failed:", err);
		}
		this.#emit({ type: "disconnected", server: entry.config.name, url: entry.config.url });
	}

	#emit(event: McpPoolEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error("[mcp-pool] listener threw:", err);
			}
		}
	}
}

function keyOf(config: McpServerHttp): string {
	return config.url;
}

function fingerprintOf(config: McpServerHttp): string {
	const auth = (config.headers ?? []).find(
		(h) => typeof h.name === "string" && h.name.toLowerCase() === "authorization",
	);
	return typeof auth?.value === "string" ? auth.value : "";
}

function normaliseTool(raw: {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, object>;
		required?: string[];
	} & Record<string, unknown>;
}): McpToolDescriptor {
	return {
		name: raw.name,
		description: raw.description ?? "",
		inputSchema: raw.inputSchema,
	};
}

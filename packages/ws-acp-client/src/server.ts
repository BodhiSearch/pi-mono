/**
 * WebSocket-fronted ACP host. Each connection calls `startAgent` with
 * the shared `HostState.registry` and a per-connection `BodhiProvider`
 * (auth tokens are per-user). See `README.md`.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { BodhiProvider, type StartAgentHandle, startAgent } from "@bodhiapp/web-acp-agent";
import { type WebSocket, WebSocketServer } from "ws";
import type { HostState } from "./services/assemble";
import { createSqlitePreferenceStore, createSqliteSessionStore } from "./storage";
import { type WsTransportPair, wsToTransport } from "./transport/ws-transport";

export interface WsAcpServerOptions {
	host: HostState;
	/** Listen port (0 = random). */
	port?: number;
	/** Bind interface. Defaults to `127.0.0.1`. */
	bindAddress?: string;
	/** Build version reported on `initialize.agentInfo.version`. */
	buildVersion?: string;
	/** Logger; defaults to `console`. Tests pass a silent logger. */
	logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface WsAcpServer {
	/** Resolved listen port. Useful when `port: 0` was requested. */
	port: number;
	/** Resolved bind URL (for status messages). */
	url: string;
	/** Number of currently-connected WS clients. */
	readonly connectionCount: number;
	/** Stop accepting connections, terminate live ones, and close the http server. */
	close(): Promise<void>;
}

interface ConnectionRecord {
	ws: WebSocket;
	pair: WsTransportPair;
	agent?: StartAgentHandle;
}

const DEFAULT_BUILD_VERSION = "0.0.0";

export async function startWsAcpServer(opts: WsAcpServerOptions): Promise<WsAcpServer> {
	const log = opts.logger ?? console;
	const port = opts.port ?? 0;
	const bindAddress = opts.bindAddress ?? "127.0.0.1";
	const buildVersion = opts.buildVersion ?? DEFAULT_BUILD_VERSION;

	const sessions = createSqliteSessionStore(opts.host.db);
	const preferences = createSqlitePreferenceStore(opts.host.db);

	const httpServer: HttpServer = createServer((req, res) => {
		if (req.url === "/healthz") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end("ok");
			return;
		}
		res.writeHead(426, { "content-type": "text/plain" });
		res.end("Upgrade required: this endpoint speaks WebSocket only.");
	});

	const wss = new WebSocketServer({ server: httpServer });
	const connections = new Set<ConnectionRecord>();

	wss.on("connection", (ws, req) => {
		const remote = req.socket.remoteAddress ?? "unknown";
		log.log(`[ws-acp-client] connection from ${remote}`);

		const pair = wsToTransport(ws);
		const record: ConnectionRecord = { ws, pair };
		connections.add(record);

		try {
			record.agent = startAgent({
				transport: pair.transport,
				provider: new BodhiProvider(),
				registry: opts.host.registry,
				sessions,
				preferences,
				buildVersion,
			});
		} catch (err) {
			log.error("[ws-acp-client] startAgent failed:", err);
			try {
				ws.close(1011, "agent boot failed");
			} catch {
				// ignore
			}
			connections.delete(record);
			return;
		}

		pair.closed.finally(() => {
			connections.delete(record);
			void record.agent?.dispose().catch((err: unknown) => {
				log.warn("[ws-acp-client] agent.dispose() failed:", err);
			});
		});
	});

	wss.on("error", (err) => {
		log.error("[ws-acp-client] wss error:", err);
	});

	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(port, bindAddress, () => {
			httpServer.removeListener("error", reject);
			resolve();
		});
	});

	const address = httpServer.address();
	if (!address || typeof address === "string") {
		throw new Error("ws-acp-client: http server returned no address");
	}
	const resolvedPort = address.port;
	const url = `ws://${bindAddress}:${resolvedPort}`;
	log.log(`[ws-acp-client] listening on ${url}`);

	return {
		port: resolvedPort,
		url,
		get connectionCount(): number {
			return connections.size;
		},
		async close(): Promise<void> {
			for (const rec of connections) {
				try {
					rec.ws.close(1001, "server shutting down");
				} catch {
					// ignore
				}
			}
			await Promise.allSettled(Array.from(connections, (rec) => rec.pair.closed));
			await new Promise<void>((resolve) => {
				wss.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		},
	};
}

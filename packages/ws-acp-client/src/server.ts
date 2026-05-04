/**
 * WebSocket-fronted ACP host. Wraps a single shared `HostState`
 * (sqlite + cwd ZenFS mount) and accepts WS connections at a single
 * path (`/`). Each connection receives a fresh `BodhiProvider` and
 * `AcpAgentAdapter` wired over the WS transport.
 *
 * NDJSON-framed JSON-RPC is the wire — `@agentclientprotocol/sdk`'s
 * `ndJsonStream` does the framing, this file just adapts `ws` to the
 * WHATWG byte-stream contract.
 */

import { createServer, type Server as HttpServer } from "node:http";
import { type AcpAgentAdapter, type AcpTransport, startAcpAgent } from "@bodhiapp/web-acp-agent";
import { type WebSocket, WebSocketServer } from "ws";
import { createConnectionServices, type HostState } from "./services/assemble";
import { wsToTransport } from "./transport/ws-transport";

export interface WsAcpServerOptions {
	host: HostState;
	/** Listen port (0 = random). */
	port?: number;
	/** Bind interface. Defaults to `127.0.0.1`. */
	bindAddress?: string;
	/** Build version reported on `initialize.agentInfo.version`. */
	buildVersion?: string;
	/** ACP SDK version reported on the `/version` builtin. */
	acpSdkVersion?: string;
	/** Enable DEV-only features (forceToolCall, etc.). */
	isDev?: boolean;
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
	transport: AcpTransport;
	closed: Promise<void>;
	adapter?: AcpAgentAdapter;
}

const DEFAULT_BUILD_VERSION = "0.0.0";
const DEFAULT_ACP_SDK_VERSION = "0.21.0";

export async function startWsAcpServer(opts: WsAcpServerOptions): Promise<WsAcpServer> {
	const log = opts.logger ?? console;
	const port = opts.port ?? 0;
	const bindAddress = opts.bindAddress ?? "127.0.0.1";

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

		const { transport, closed } = wsToTransport(ws);
		const record: ConnectionRecord = { ws, transport, closed };
		connections.add(record);

		const conn = createConnectionServices(opts.host);
		try {
			startAcpAgent(transport, conn.services, {
				isDev: opts.isDev ?? false,
				buildVersion: opts.buildVersion ?? DEFAULT_BUILD_VERSION,
				acpSdkVersion: opts.acpSdkVersion ?? DEFAULT_ACP_SDK_VERSION,
				onAdapter: (a) => {
					record.adapter = a;
				},
			});
		} catch (err) {
			log.error("[ws-acp-client] startAcpAgent failed:", err);
			try {
				ws.close(1011, "agent boot failed");
			} catch {
				// ignore
			}
			connections.delete(record);
			return;
		}

		closed.finally(() => {
			connections.delete(record);
			void record.adapter?.dispose().catch((err) => {
				log.warn("[ws-acp-client] adapter.dispose() failed:", err);
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
			await Promise.allSettled(Array.from(connections, (rec) => rec.closed));
			await new Promise<void>((resolve) => {
				wss.close(() => resolve());
			});
			await new Promise<void>((resolve) => {
				httpServer.close(() => resolve());
			});
		},
	};
}

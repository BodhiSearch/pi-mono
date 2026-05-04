import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type CallbackEvent =
	| { kind: "access_request"; requestId: string }
	| { kind: "code"; code: string; state: string }
	| { kind: "error"; error: string; description?: string };

export interface PendingCallback {
	event: CallbackEvent;
	respondSuccess(): void;
	respondRedirect(url: string): void;
	respondError(message: string): void;
}

export interface CallbackServer {
	readonly redirectUri: string;
	awaitNext(timeoutMs?: number): Promise<PendingCallback>;
	close(): Promise<void>;
}

export async function startCallbackServer(port: number): Promise<CallbackServer> {
	const waiters: Array<(cb: PendingCallback) => void> = [];
	const queued: PendingCallback[] = [];

	function deliver(cb: PendingCallback): void {
		const next = waiters.shift();
		if (next) {
			next(cb);
			return;
		}
		queued.push(cb);
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/callback") {
			handleCallbackGet(url, res, deliver);
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});

	const address = server.address() as AddressInfo;
	const redirectUri = `http://localhost:${address.port}/callback`;

	return {
		redirectUri,
		awaitNext(timeoutMs?: number) {
			const queuedCb = queued.shift();
			if (queuedCb) return Promise.resolve(queuedCb);
			const wait = new Promise<PendingCallback>((resolve) => waiters.push(resolve));
			if (timeoutMs && timeoutMs > 0) {
				return Promise.race([
					wait,
					new Promise<PendingCallback>((_, reject) =>
						setTimeout(() => reject(new Error("callback timeout")), timeoutMs),
					),
				]);
			}
			return wait;
		},
		close: () => closeServer(server),
	};
}

function handleCallbackGet(
	url: URL,
	res: ServerResponse<IncomingMessage>,
	deliver: (cb: PendingCallback) => void,
): void {
	const error = url.searchParams.get("error");
	if (error) {
		const description = url.searchParams.get("error_description") ?? undefined;
		deliver(makePending(res, { kind: "error", error, description }));
		return;
	}
	const requestId = url.searchParams.get("id") ?? url.searchParams.get("request_id");
	if (requestId) {
		deliver(makePending(res, { kind: "access_request", requestId }));
		return;
	}
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (code && state) {
		deliver(makePending(res, { kind: "code", code, state }));
		return;
	}
	const queryDump = url.searchParams.toString() || "<empty>";
	deliver(
		makePending(res, {
			kind: "error",
			error: "missing_params",
			description: `callback received with no recognised params (query: ${queryDump})`,
		}),
	);
}

function makePending(res: ServerResponse<IncomingMessage>, event: CallbackEvent): PendingCallback {
	let responded = false;
	const guard = (fn: () => void): void => {
		if (responded) return;
		responded = true;
		fn();
	};
	return {
		event,
		respondSuccess: () =>
			guard(() => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(
					'<!doctype html><html><body style="font-family:system-ui;text-align:center;margin:3rem auto;max-width:32rem"><h1>Login complete</h1><p>You can close this tab and return to the terminal.</p></body></html>',
				);
			}),
		respondRedirect: (url: string) =>
			guard(() => {
				res.writeHead(302, { Location: url });
				res.end();
			}),
		respondError: (message: string) =>
			guard(() => {
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(
					`<!doctype html><html><body style="font-family:system-ui;margin:3rem auto;max-width:32rem"><h1>Login failed</h1><p>${escapeHtml(message)}</p></body></html>`,
				);
			}),
	};
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections?.();
	});
}

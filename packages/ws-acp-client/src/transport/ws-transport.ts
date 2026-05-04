/**
 * Adapter from a `ws` WebSocket connection to the WHATWG byte-stream
 * pair (`ReadableStream<Uint8Array>` + `WritableStream<Uint8Array>`)
 * that `@bodhiapp/web-acp-agent`'s `startAgent` consumes.
 *
 * NDJSON framing (one JSON-RPC message per line, terminated by `\n`)
 * is handled inside `ndJsonStream` in the agent SDK. This adapter is
 * deliberately framing-unaware — it surfaces every WS message as raw
 * bytes onto the readable stream, and forwards every chunk written to
 * the writable stream as a single WS message. NDJSON's terminator
 * preserves boundaries so that one ws message MAY contain multiple
 * lines or a partial line; the agent SDK handles both.
 */

import type { AcpTransport } from "@bodhiapp/web-acp-agent";
import type { WebSocket } from "ws";

export interface WsTransportPair {
	transport: AcpTransport;
	/** Resolves once the underlying WS closes (either side). */
	closed: Promise<void>;
}

export function wsToTransport(ws: WebSocket): WsTransportPair {
	const encoder = new TextEncoder();

	let closeResolve: (() => void) | undefined;
	const closed = new Promise<void>((resolve) => {
		closeResolve = resolve;
	});

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			const onMessage = (data: unknown): void => {
				try {
					if (data instanceof ArrayBuffer) {
						controller.enqueue(new Uint8Array(data));
						return;
					}
					if (data instanceof Uint8Array) {
						controller.enqueue(data);
						return;
					}
					if (Array.isArray(data)) {
						for (const chunk of data) {
							if (chunk instanceof Uint8Array) controller.enqueue(chunk);
							else if (chunk instanceof ArrayBuffer) controller.enqueue(new Uint8Array(chunk));
							else if (typeof chunk === "string") controller.enqueue(encoder.encode(chunk));
						}
						return;
					}
					if (typeof data === "string") {
						controller.enqueue(encoder.encode(data));
						return;
					}
					// Fallback: try Buffer-like via `Buffer.from`
					if (data && typeof (data as { toString: () => string }).toString === "function") {
						controller.enqueue(encoder.encode(String(data)));
					}
				} catch (err) {
					controller.error(err);
				}
			};
			const onClose = (): void => {
				try {
					controller.close();
				} catch {
					// already closed
				}
				closeResolve?.();
			};
			const onError = (err: Error): void => {
				try {
					controller.error(err);
				} catch {
					// already errored
				}
				closeResolve?.();
			};
			ws.on("message", onMessage);
			ws.on("close", onClose);
			ws.on("error", onError);
		},
		cancel() {
			try {
				ws.close();
			} catch {
				// ignore
			}
		},
	});

	const decoder = new TextDecoder();
	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			return new Promise<void>((resolve, reject) => {
				if (ws.readyState !== ws.OPEN) {
					// Drop silently — the readable side will surface the close.
					resolve();
					return;
				}
				// Browser-side `WebSocketTransport` requires text frames
				// (binary frames are explicitly dropped). Decode the
				// chunk back to a string and send as text so the agent's
				// NDJSON output rides over the wire as text.
				const text = decoder.decode(chunk, { stream: false });
				ws.send(text, { binary: false }, (err) => {
					if (err) reject(err);
					else resolve();
				});
			});
		},
		close() {
			try {
				ws.close();
			} catch {
				// ignore
			}
		},
		abort() {
			try {
				ws.terminate();
			} catch {
				// ignore
			}
		},
	});

	return {
		transport: { readable, writable },
		closed,
	};
}

import type { AuthenticateResponse, Client, InitializeResponse } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
	BODHI_AUTH_METHOD_ID,
	BodhiProvider,
	type BodhiServerInfoResponse,
	createInMemoryDuplex,
	startAgent,
	ZenfsVolumeRegistry,
} from "@bodhiapp/web-acp-agent";

export interface EmbeddedAgent {
	initialize(): Promise<InitializeResponse>;
	/**
	 * Push credentials to the agent. The agent's `LlmProvider.setAuthToken`
	 * runs as a side effect and (for `BodhiProvider`) returns the
	 * BodhiApp `/info` payload, surfaced under
	 * `_meta.bodhi.providerInfo` in the response.
	 */
	authenticate(opts: { token: string; baseUrl: string }): Promise<AuthenticateResponse>;
	close(): Promise<void>;
}

export async function createEmbeddedAgent(): Promise<EmbeddedAgent> {
	const duplex = createInMemoryDuplex();
	const handle = startAgent({
		transport: duplex.agent,
		provider: new BodhiProvider(),
		registry: new ZenfsVolumeRegistry(),
	});

	const stream = ndJsonStream(duplex.client.writable, duplex.client.readable);
	const handler: Client = {
		// SDK requires `requestPermission`; agent never invokes it.
		async requestPermission() {
			return { outcome: { outcome: "cancelled" } };
		},
		async sessionUpdate() {},
	};
	const conn = new ClientSideConnection(() => handler, stream);

	return {
		initialize: () =>
			conn.initialize({
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		authenticate: (opts) =>
			conn.authenticate({
				methodId: BODHI_AUTH_METHOD_ID,
				_meta: { token: opts.token, baseUrl: opts.baseUrl },
			}),
		close: async () => {
			await handle.dispose().catch(() => {});
			await closeStream(duplex.client.writable);
			await closeStream(duplex.agent.writable);
		},
	};
}

/**
 * Helper for hosts: extract the BodhiApp server info from an
 * `AuthenticateResponse._meta.bodhi.providerInfo` payload.
 */
export function readBodhiServerInfo(response: AuthenticateResponse | undefined): BodhiServerInfoResponse | undefined {
	const meta = response?._meta as { bodhi?: { providerInfo?: unknown } } | undefined;
	const info = meta?.bodhi?.providerInfo;
	return info && typeof info === "object" ? (info as BodhiServerInfoResponse) : undefined;
}

async function closeStream(stream: WritableStream<Uint8Array>): Promise<void> {
	try {
		const writer = stream.getWriter();
		await writer.close();
		writer.releaseLock();
	} catch {
		// already closed
	}
}

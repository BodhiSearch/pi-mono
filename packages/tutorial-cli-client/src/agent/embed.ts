import type { Client, InitializeResponse } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
	type AcpAgentAdapter,
	assembleServices,
	BODHI_AUTH_METHOD_ID,
	BODHI_SERVER_INFO_METHOD,
	BodhiProvider,
	type BodhiServerInfoResponse,
	createInlineAgent,
	createStreamFn,
	requestPermissionStub,
	startAcpAgent,
	ZenfsVolumeRegistry,
} from "@bodhiapp/web-acp-agent";
import { createInMemoryDuplex } from "./duplex";

export interface EmbeddedAgent {
	initialize(): Promise<InitializeResponse>;
	authenticate(opts: { token: string; baseUrl: string }): Promise<void>;
	serverInfo(): Promise<BodhiServerInfoResponse>;
	close(): Promise<void>;
}

export async function createEmbeddedAgent(): Promise<EmbeddedAgent> {
	const provider = new BodhiProvider();
	const inline = createInlineAgent(createStreamFn(provider, () => ({})));
	const services = assembleServices({
		inline,
		bodhi: provider,
		registry: new ZenfsVolumeRegistry(),
	});

	const duplex = createInMemoryDuplex();

	let adapter: AcpAgentAdapter | undefined;
	startAcpAgent(duplex.agent, services, {
		isDev: false,
		buildVersion: "0.0.0",
		acpSdkVersion: "0.21.0",
		onAdapter: (a) => {
			adapter = a;
		},
	});

	const clientStream = ndJsonStream(duplex.client.writable, duplex.client.readable);
	const handler: Client = {
		requestPermission: requestPermissionStub,
		async sessionUpdate() {},
	};
	const conn = new ClientSideConnection(() => handler, clientStream);

	return {
		async initialize(): Promise<InitializeResponse> {
			return conn.initialize({
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
			});
		},
		async authenticate(authOpts) {
			await conn.authenticate({
				methodId: BODHI_AUTH_METHOD_ID,
				_meta: { token: authOpts.token, baseUrl: authOpts.baseUrl },
			});
		},
		async serverInfo() {
			const result = await conn.extMethod(BODHI_SERVER_INFO_METHOD, {});
			return result as BodhiServerInfoResponse;
		},
		async close() {
			await adapter?.dispose().catch(() => {});
			await closeStream(duplex.client.writable);
			await closeStream(duplex.agent.writable);
		},
	};
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

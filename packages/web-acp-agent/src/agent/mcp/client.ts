/**
 * Worker-side MCP client factory.
 *
 * Wraps `@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`
 * so the rest of the worker can ask for a ready-to-use `Client` given the
 * plain `McpServerHttp` config that arrived on `session/new` /
 * `session/load`. Headers supplied by the main thread (including the
 * `Authorization: Bearer <jwt>` entry) are forwarded verbatim as
 * `requestInit.headers`.
 *
 * This module is the only worker entry point that touches the MCP
 * transport; the rest of the worker depends on the returned `Client`
 * handle.
 */
import type { McpServerHttp } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP_CLIENT_NAME = 'web-acp';
const MCP_CLIENT_VERSION = '0.1.0';

export interface CreateMcpClientResult {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Create and connect a Streamable-HTTP MCP client for the given server
 * config. The caller owns the returned handle and must invoke `close()`
 * when the refcount drops to zero (see `McpConnectionPool`).
 */
export async function createMcpClient(config: McpServerHttp): Promise<CreateMcpClientResult> {
  const url = new URL(config.url);
  const headers = headersFromConfig(config);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  const client = new Client(
    { name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
    { capabilities: {} }
  );
  try {
    await client.connect(transport);
  } catch (err) {
    try {
      await transport.close();
    } catch {
      /* swallow cleanup failure; surface the original connect error */
    }
    throw err;
  }
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch (err) {
        console.warn('[mcp-client] client.close() threw:', err);
      }
    },
  };
}

function headersFromConfig(config: McpServerHttp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of config.headers ?? []) {
    if (!header || typeof header.name !== 'string') continue;
    if (typeof header.value !== 'string') continue;
    out[header.name] = header.value;
  }
  return out;
}

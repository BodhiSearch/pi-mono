import type {
  ToolCallUpdate as AcpToolCallUpdate,
  AvailableCommand,
  McpServer,
  McpServerHttp,
} from '@agentclientprotocol/sdk';
import type { AgentMessage, AgentMessage as CoreMessage } from '@mariozechner/pi-agent-core';
import type { CommandDef } from '../agent/commands';
import type { McpToggleSnapshot } from '../storage/mcp-toggle-shape';
import type {
  AnyBodhiBuiltinAction,
  BodhiMcpInstanceDescriptor,
  BodhiMcpToggleSnapshot,
  BodhiSessionMeta,
} from '../wire';

// Defensive coercion: malformed input returns empty arrays so the
// worker keeps running for clients that didn't push the meta.
export function extractSessionMeta(meta: unknown): BodhiSessionMeta {
  if (!meta || typeof meta !== 'object') return {};
  const bodhi = (meta as { bodhi?: unknown }).bodhi;
  if (!bodhi || typeof bodhi !== 'object') return {};
  const rec = bodhi as Record<string, unknown>;
  const out: BodhiSessionMeta = {};
  const requested = rec.requestedMcpUrls;
  if (Array.isArray(requested)) {
    out.requestedMcpUrls = requested.filter((u): u is string => typeof u === 'string');
  }
  const instances = rec.mcpInstances;
  if (Array.isArray(instances)) {
    const filtered: BodhiMcpInstanceDescriptor[] = [];
    for (const entry of instances) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.slug === 'string' && typeof e.name === 'string' && typeof e.path === 'string') {
        filtered.push({ slug: e.slug, name: e.name, path: e.path });
      }
    }
    out.mcpInstances = filtered;
  }
  return out;
}

// We advertise `http` only; drop stdio/sse rather than throwing so
// a misconfigured entry doesn't break the whole session.
export function filterHttpServers(servers: McpServer[]): McpServerHttp[] {
  const out: McpServerHttp[] = [];
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;
    if ('type' in server && server.type !== 'http') continue;
    if (!('url' in server) || typeof (server as { url: unknown }).url !== 'string') continue;
    out.push({
      name: (server as { name: string }).name,
      url: (server as { url: string }).url,
      headers: (server as { headers?: Array<{ name: string; value: string }> }).headers ?? [],
    });
  }
  return out;
}

// Spread to plain object literals so JSON-RPC serialisation doesn't
// drag unexpected keys from the worker-side maps.
export function toWireMcpToggles(snapshot: McpToggleSnapshot): BodhiMcpToggleSnapshot {
  return {
    servers: { ...snapshot.servers },
    tools: Object.fromEntries(
      Object.entries(snapshot.tools).map(([slug, toolMap]) => [slug, { ...toolMap }])
    ),
  };
}

export function toAvailableCommand(def: CommandDef): AvailableCommand {
  const out: AvailableCommand = {
    name: def.name,
    description: def.description,
  };
  if (def.argumentHint) {
    out.input = { hint: def.argumentHint };
  }
  return out;
}

export function toolTitle(toolName: string, args: unknown): string {
  if (toolName === 'bash') {
    const script = (args as { script?: unknown })?.script;
    if (typeof script === 'string' && script.trim().length > 0) {
      const line = script.split('\n')[0].trim();
      return `bash: ${line.length > 80 ? `${line.slice(0, 77)}…` : line}`;
    }
    return 'bash';
  }
  return toolName;
}

export function toToolCallContent(
  content: Array<{ type?: unknown; text?: unknown }>
): AcpToolCallUpdate['content'] {
  const blocks = [];
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string') {
      blocks.push({
        type: 'content' as const,
        content: { type: 'text' as const, text: part.text },
      });
    }
  }
  return blocks.length > 0 ? (blocks as AcpToolCallUpdate['content']) : undefined;
}

export function extractAssistantText(msg: CoreMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (!Array.isArray(msg.content)) return '';
  const out: string[] = [];
  for (const part of msg.content) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part
    ) {
      out.push(part.text as string);
    }
  }
  return out.join('');
}

export function extractMessageId(msg: CoreMessage): string | undefined {
  const anyMsg = msg as unknown as { id?: unknown };
  return typeof anyMsg.id === 'string' ? anyMsg.id : undefined;
}

export interface BuiltinTagShape {
  command: string;
  action?: AnyBodhiBuiltinAction;
}

// `_builtin` tag drives MessageBubble's "not sent to LLM" rendering
// after `bodhi/getSession` replay; live sends stamp the same shape.
export function makeBuiltinUserMessage(text: string, tag: BuiltinTagShape): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    _builtin: tag,
  } as unknown as AgentMessage;
}

export function makeBuiltinAssistantMessage(text: string, tag: BuiltinTagShape): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    _builtin: tag,
  } as unknown as AgentMessage;
}

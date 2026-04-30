import type {
  AgentSideConnection,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  builtinAvailableCommands,
  findBuiltin,
  type BuiltinHandlerCtx,
} from '@/agent/commands/builtins';
import { toAvailableCommand } from '../wire-utils';
import type { AcpAdapterServices } from './services';
import type { AcpSessionRuntime } from './session-runtime';

interface BodhiPromptMeta {
  bodhi?: {
    modelId?: string;
  };
}

export interface BuiltinDispatchArgs {
  conn: AgentSideConnection;
  services: AcpAdapterServices;
  runtime: AcpSessionRuntime;
  buildVersion: string;
  acpSdkVersion: string;
  params: PromptRequest;
  rawText: string;
}

/**
 * Recognise an agent-handled built-in (M4 phase B). Returns a
 * resolved `PromptResponse` when the input matched (the chunk + the
 * `'builtin'` store entry have already been written) and `null`
 * otherwise so the caller falls through to the normal LLM path.
 *
 * Built-ins emit via the raw connection (NOT `runtime.emit`) so they
 * don't also get persisted as `'notification'` entries — the
 * `'builtin'` store entry plus the `bodhi/getSession` interleaving
 * on reload is the single source of truth for replay.
 */
export async function tryHandleBuiltin(args: BuiltinDispatchArgs): Promise<PromptResponse | null> {
  const { conn, services, runtime, buildVersion, acpSdkVersion, params, rawText } = args;
  const match = findBuiltin(rawText);
  if (!match) return null;
  const sessionId = params.sessionId;
  const session = runtime.getSession(sessionId);
  const ctx: BuiltinHandlerCtx = {
    sessionId,
    modelId: resolveBuiltinModelId(params),
    serverUrl: services.bodhi.getBaseUrl?.() ?? null,
    sessionStats: await runtime.sessionStatsFor(sessionId),
    mcpServersConnected: runtime.mcpConnectedFor(sessionId),
    mcpInstances: session?.mcpInstances ?? [],
    requestedMcpUrls: session?.requestedMcpUrls ?? [],
    advertisedCommands: [
      ...builtinAvailableCommands(),
      ...runtime.getAvailableCommands().map(toAvailableCommand),
    ],
    inlineMessages: services.inline.getMessages(),
    buildVersion,
    acpSdkVersion,
  };
  let result;
  try {
    result = await match.cmd.handler(match.args, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      replyText: `Built-in \`/${match.cmd.name}\` failed: ${message}`,
    };
  }
  const meta = {
    bodhi: {
      builtin: {
        command: match.cmd.name,
        ...(result.action ? { action: result.action } : {}),
      },
    },
  };
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: result.replyText },
    },
    _meta: meta,
  } as SessionNotification);
  if (services.store) {
    try {
      await services.store.recordBuiltin(sessionId, {
        command: match.cmd.name,
        userText: rawText,
        replyText: result.replyText,
        ...(result.action ? { action: result.action } : {}),
      });
    } catch (err) {
      console.error('[builtin-dispatch] failed to persist builtin entry:', err);
    }
  }
  return { stopReason: 'end_turn' };
}

function resolveBuiltinModelId(params: PromptRequest): string | null {
  // Best-effort: prefer the model id the client passed in this turn's
  // `_meta.bodhi.modelId`. Built-ins still work without a model —
  // handlers display `(none selected)`.
  const meta = (params._meta ?? {}) as BodhiPromptMeta;
  return meta.bodhi?.modelId ?? null;
}

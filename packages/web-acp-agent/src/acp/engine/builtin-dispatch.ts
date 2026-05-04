import type {
  AgentSideConnection,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  type BuiltinHandlerCtx,
  builtinAvailableCommands,
  findBuiltin,
} from '../../agent/commands/builtins';
import {
  BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
  type BodhiBuiltinActionNotificationParams,
} from '../../wire';
import { toAvailableCommand } from '../wire-utils';
import type { AcpAdapterServices } from './services';
import type { AcpSessionRuntime } from './session-runtime';

function extractServerUrl(providerInfo: unknown): string | null {
  if (!providerInfo || typeof providerInfo !== 'object') return null;
  const url = (providerInfo as { url?: unknown }).url;
  return typeof url === 'string' ? url : null;
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
 * Returns a resolved `PromptResponse` when input matched a built-in,
 * `null` otherwise. Emits via raw connection (not `runtime.emit`) so
 * the chunk isn't also persisted as a `'notification'` entry — the
 * `'builtin'` store entry is the single source of truth for replay.
 */
export async function tryHandleBuiltin(args: BuiltinDispatchArgs): Promise<PromptResponse | null> {
  const { conn, services, runtime, buildVersion, acpSdkVersion, params, rawText } = args;
  const match = findBuiltin(rawText);
  if (!match) return null;
  const sessionId = params.sessionId;
  const session = runtime.getSession(sessionId);
  const ctx: BuiltinHandlerCtx = {
    sessionId,
    modelId: session?.currentModelId ?? null,
    serverUrl: extractServerUrl(services.lastProviderInfo),
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
  // Tag on the chunk drives the "not sent to LLM" badge; optional
  // `action` rides a separate `extNotification` side-channel below.
  const meta = {
    bodhi: {
      builtin: {
        command: match.cmd.name,
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
  if (result.action) {
    const params: BodhiBuiltinActionNotificationParams = {
      sessionId,
      command: match.cmd.name,
      action: result.action,
    };
    await conn.extNotification(
      BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
      params as unknown as Record<string, unknown>
    );
  }
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

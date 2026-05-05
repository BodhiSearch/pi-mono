import type {
  AgentSideConnection,
  PromptRequest,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  type BuiltinExtensionsHandle,
  type BuiltinHandlerCtx,
  builtinAvailableCommands,
  findBuiltin,
} from '../../agent/commands/builtins';
import { installExtensionFromNpm } from '../../agent/extensions';
import { writeDisabledExtensions } from '../../agent/internal/extensions-prefs';
import { WELL_KNOWN_VOLUME_TAGS } from '../../agent/well-known-volume-tags';
import {
  BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
  type BodhiBuiltinActionNotificationParams,
} from '../../wire';
import { toAvailableCommand } from '../wire-utils';
import { buildExtensionsSnapshot } from './ext-methods/extensions-snapshot';
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

const COMMAND_PATTERN = /^\/(\S+)(?:\s+([\s\S]*))?$/;

interface ParsedSlash {
  name: string;
  args: string;
}

function parseSlash(text: string): ParsedSlash | null {
  const match = COMMAND_PATTERN.exec(text);
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

/**
 * Returns a resolved `PromptResponse` when input matched an
 * extension-registered slash command, `null` otherwise. Routed
 * through the same muted-reply + persistence path as built-ins,
 * so the `_meta.bodhi.builtin.command` tag carries the extension
 * command name for replay.
 */
export async function tryHandleExtensionCommand(
  args: BuiltinDispatchArgs
): Promise<PromptResponse | null> {
  const { conn, services, params, rawText } = args;
  const extensions = services.extensions;
  if (!extensions) return null;
  const parsed = parseSlash(rawText);
  if (!parsed) return null;
  const found = extensions.findCommand(parsed.name);
  if (!found) return null;
  const sessionId = params.sessionId;
  let replyText: string;
  extensions.setActiveSession(sessionId);
  try {
    replyText = await found.definition.handler(parsed.args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    replyText = `Extension command \`/${parsed.name}\` failed: ${message}`;
  } finally {
    extensions.setActiveSession(null);
  }
  const meta = {
    bodhi: {
      builtin: {
        command: parsed.name,
      },
    },
  };
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: replyText },
    },
    _meta: meta,
  } as SessionNotification);
  if (services.store) {
    try {
      await services.store.recordBuiltin(sessionId, {
        command: parsed.name,
        userText: rawText,
        replyText,
      });
    } catch (err) {
      console.error('[builtin-dispatch] failed to persist extension command entry:', err);
    }
  }
  return { stopReason: 'end_turn' };
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
    extensions: buildExtensionsHandle(services, runtime, sessionId),
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

/**
 * Bridge `BuiltinExtensionsHandle` for the per-call ctx. Returns
 * `undefined` when no `ExtensionRegistry` is wired so `/extension`
 * fails gracefully instead of crashing.
 */
function buildExtensionsHandle(
  services: AcpAdapterServices,
  runtime: AcpSessionRuntime,
  sessionId: string
): BuiltinExtensionsHandle | undefined {
  const extensions = services.extensions;
  if (!extensions) return undefined;
  return {
    active: () => extensions.list().map(ext => ({ name: ext.name, mountName: ext.mountName })),
    disabled: () => extensions.getDisabled(),
    known: () => extensions.getKnownNames(),
    async setDisabled(names) {
      const dedup = Array.from(new Set(names));
      if (services.preferences) {
        await writeDisabledExtensions(services.preferences, dedup);
      }
      extensions.setDisabled(dedup);
      await extensions.reload();
      await runtime.refreshAvailableCommands(sessionId);
      await runtime.broadcastExtensionsState(buildExtensionsSnapshot(extensions));
      return {
        active: extensions.list().map(ext => ({ name: ext.name })),
        disabled: extensions.getDisabled(),
      };
    },
    async add(spec, options) {
      if (!services.registry) {
        throw new Error('extensions:volume-registry-missing — no VolumeRegistry was provided');
      }
      if (!services.extensionsWriteFs) {
        throw new Error('extensions:write-fs-missing — host did not provide an ExtensionsWriteFs');
      }
      const target = services.registry.findByTag(WELL_KNOWN_VOLUME_TAGS.AGENT_WD);
      if (!target) {
        throw new Error(
          `extensions:no-agent-wd-volume — no mounted volume is tagged '${WELL_KNOWN_VOLUME_TAGS.AGENT_WD}'`
        );
      }
      const installed = await installExtensionFromNpm({
        spec,
        agentWdMount: target.mountName,
        writeFs: services.extensionsWriteFs,
        ...(options?.registryUrl ? { registryUrl: options.registryUrl } : {}),
      });
      await extensions.reload();
      await runtime.refreshAvailableCommands(sessionId);
      await runtime.broadcastExtensionsState(buildExtensionsSnapshot(extensions));
      return {
        name: installed.name,
        version: installed.version,
        extensionName: installed.extensionName,
        installPath: installed.installPath,
        active: extensions.list().map(ext => ({ name: ext.name })),
      };
    },
  };
}

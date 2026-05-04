import type {
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  SessionInfo,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { reconstructMessages, walkEntries } from '../engine/replay';
import { writeFeature } from '../../agent/internal/feature-prefs';
import { isServerEnabled } from '../../storage/mcp-toggle-shape';
import { type BodhiLoadSessionMeta, type BodhiSessionInfoMeta } from '../../wire';
import { decodeCursor, encodeCursor } from './list-sessions-cursor';
import { buildFeatureConfigOptions, configIdToFeatureKey } from '../feature-config';
import { extractSessionMeta, filterHttpServers, toWireMcpToggles } from '../wire-utils';
import {
  type AcpAdapterContext,
  buildModelState,
  resolveSeededModelId,
  tryEnsureModels,
} from './adapter-context';

export async function handleNewSession(
  ctx: AcpAdapterContext,
  params: NewSessionRequest
): Promise<NewSessionResponse> {
  const sessionId = `bodhi-${crypto.randomUUID()}`;
  const mcpServers = filterHttpServers(params.mcpServers ?? []);
  const sessionMeta = extractSessionMeta(params._meta);
  ctx.runtime.setSession(sessionId, {
    id: sessionId,
    mcpServers,
    requestedMcpUrls: sessionMeta.requestedMcpUrls ?? [],
    mcpInstances: sessionMeta.mcpInstances ?? [],
    currentModelId: null,
  });
  if (ctx.services.store) {
    await ctx.services.store.createSession(sessionId);
  }
  ctx.services.inline.clearMessages();
  ctx.runtime.setActiveInlineSessionId(sessionId);
  await ctx.runtime.acquireMcpConnections(sessionId, mcpServers);
  await ctx.runtime.refreshAvailableCommands(sessionId);

  const models = await tryEnsureModels(ctx);
  const defaultModelId = models[0]?.id ?? null;
  ctx.runtime.setSessionModel(sessionId, defaultModelId);

  const response: NewSessionResponse = { sessionId };
  const modelState = buildModelState(models, defaultModelId);
  if (modelState) response.models = modelState;
  const featureSnapshot = await ctx.runtime.readFeatures(sessionId);
  response.configOptions = buildFeatureConfigOptions(featureSnapshot);
  return response;
}

export async function handleLoadSession(
  ctx: AcpAdapterContext,
  params: LoadSessionRequest
): Promise<LoadSessionResponse> {
  const store = ctx.services.store;
  if (!store) {
    throw new Error('session/load: server has no session store configured');
  }
  const row = await store.getSession(params.sessionId);
  if (!row) {
    throw new Error(`session/load: unknown session '${params.sessionId}'`);
  }
  // Agent owns toggle application: read stored toggles and drop any
  // server marked disabled. The host passes the full composed list and
  // doesn't need to know which servers are off — the worker-side
  // toggles are the source of truth. Per-tool toggles still apply
  // downstream in `mcpToolsForSession`.
  const toggles = await ctx.runtime.readMcpToggles(params.sessionId);
  const mcpServers = filterHttpServers(params.mcpServers ?? []).filter(cfg =>
    isServerEnabled(toggles, cfg.name)
  );
  const sessionMeta = extractSessionMeta(params._meta);
  const existing = ctx.runtime.getSession(params.sessionId);
  if (existing) {
    // Release exactly the previously-held configs so the pool can re-key under new headers
    // without dropping servers the caller wants to keep.
    await ctx.runtime.releaseMcpConnections(params.sessionId, existing.mcpServers);
  }
  ctx.runtime.setSession(params.sessionId, {
    id: params.sessionId,
    mcpServers,
    requestedMcpUrls: sessionMeta.requestedMcpUrls ?? [],
    mcpInstances: sessionMeta.mcpInstances ?? [],
    currentModelId: row.lastModelId,
  });

  const entries = await store.readEntries(params.sessionId);
  let lastTurnMessages: AgentMessage[] | undefined;
  await walkEntries(entries, {
    notification: async payload => {
      // sendRawNotification bypasses persistence — store already has this row.
      await ctx.runtime.sendRawNotification(payload);
    },
    turn: payload => {
      if (Array.isArray(payload.finalMessages)) {
        lastTurnMessages = payload.finalMessages;
      }
    },
  });
  if (lastTurnMessages) {
    ctx.services.inline.restoreMessages(lastTurnMessages);
  } else {
    ctx.services.inline.clearMessages();
  }
  ctx.runtime.setActiveInlineSessionId(params.sessionId);
  await ctx.runtime.acquireMcpConnections(params.sessionId, mcpServers);
  await ctx.runtime.refreshAvailableCommands(params.sessionId);

  const models = await tryEnsureModels(ctx);
  const seededModelId = resolveSeededModelId(models, row.lastModelId);
  ctx.runtime.setSessionModel(params.sessionId, seededModelId);

  const response: LoadSessionResponse = {};
  const modelState = buildModelState(models, seededModelId);
  if (modelState) response.models = modelState;
  const featureSnapshot = await ctx.runtime.readFeatures(params.sessionId);
  response.configOptions = buildFeatureConfigOptions(featureSnapshot);
  const meta: BodhiLoadSessionMeta = {
    title: row.title,
    mcpToggles: toWireMcpToggles(toggles),
    messages: reconstructMessages(entries),
  };
  response._meta = { bodhi: meta };
  return response;
}

export async function handleListSessions(
  ctx: AcpAdapterContext,
  params: ListSessionsRequest
): Promise<ListSessionsResponse> {
  const store = ctx.services.store;
  if (!store) {
    throw new Error('session/list: server has no session store configured');
  }
  // Cursor is base64(`page=N&per_page=10&sort_by=updated_at&sort_seq=desc`).
  // Bad cursor → defaults to page 1 (lenient decode).
  const cursor = decodeCursor(params.cursor);
  const { rows, total } = await store.listSummariesPage({
    page: cursor.page,
    perPage: cursor.perPage,
  });
  const sessions: SessionInfo[] = rows.map(row => {
    const meta: BodhiSessionInfoMeta = {
      turnCount: row.turnCount,
      lastModelId: row.lastModelId,
      createdAt: row.createdAt,
    };
    return {
      sessionId: row.id,
      cwd: '/',
      title: row.title,
      updatedAt: new Date(row.updatedAt).toISOString(),
      _meta: { bodhi: meta },
    };
  });
  const consumed = cursor.page * cursor.perPage;
  const response: ListSessionsResponse = { sessions };
  if (consumed < total) {
    response.nextCursor = encodeCursor({ ...cursor, page: cursor.page + 1 });
  }
  return response;
}

export async function handleCloseSession(
  ctx: AcpAdapterContext,
  params: CloseSessionRequest
): Promise<CloseSessionResponse> {
  // Driver is shared across sessions; abort only when active turn matches this sessionId.
  await ctx.runtime.tearDownSession(params.sessionId, {
    persistRow: true,
    abortPromptIfActive: id => ctx.driver.abortIfActive(id),
  });
  return {};
}

export async function handleSetSessionModel(
  ctx: AcpAdapterContext,
  params: SetSessionModelRequest
): Promise<SetSessionModelResponse> {
  const session = ctx.runtime.getSession(params.sessionId);
  if (!session) {
    throw new Error(`unstable_setSessionModel: unknown session '${params.sessionId}'`);
  }
  const models = await tryEnsureModels(ctx);
  const match = models.find(m => m.id === params.modelId);
  if (!match) {
    throw new Error(`unstable_setSessionModel: unknown model id '${params.modelId}'`);
  }
  ctx.runtime.setSessionModel(params.sessionId, params.modelId);
  return {};
}

export async function handleSetSessionConfigOption(
  ctx: AcpAdapterContext,
  params: SetSessionConfigOptionRequest
): Promise<SetSessionConfigOptionResponse> {
  const featureKey = configIdToFeatureKey(params.configId);
  if (!featureKey) {
    throw new Error(`setSessionConfigOption: unknown configId '${params.configId}'`);
  }
  if (!ctx.services.preferences) {
    throw new Error('setSessionConfigOption: preference store unavailable');
  }
  const value = params.value;
  let nextBool: boolean;
  if (value === 'on') {
    nextBool = true;
  } else if (value === 'off') {
    nextBool = false;
  } else {
    throw new Error(
      `setSessionConfigOption: configId '${params.configId}' value must be 'on' | 'off'`
    );
  }
  const next = await writeFeature(ctx.services.preferences, params.sessionId, featureKey, nextBool);
  const options = buildFeatureConfigOptions(next);
  await ctx.runtime.emitConfigOptionUpdate(params.sessionId, options);
  return { configOptions: options };
}

export async function handleCancel(
  ctx: AcpAdapterContext,
  params: CancelNotification
): Promise<void> {
  // Driver is single-instance for the worker; abort only when active turn matches.
  ctx.driver.abortIfActive(params.sessionId);
}

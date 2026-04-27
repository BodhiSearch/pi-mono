import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  AvailableCommand,
  Client,
  McpServerHttp,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { AcpClient } from '@/acp/client';
import { buildFsHandlers } from '@/acp/fs-handlers';
import type {
  BodhiBuiltinTag,
  BodhiFeatureBag,
  BodhiModelDescriptor,
  BodhiSessionSummary,
} from '@/acp/index';
import { isBuiltinName } from '@/agent/commands/builtins';
import {
  extractBuiltinMeta,
  getBuiltinTag,
  renderConversationMarkdown,
  withBuiltinTag,
} from '@/lib/builtin-format';
import { composeMcpServers, type McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import type { McpConnectionMeta, McpInstanceView } from '@/mcp/types';
import { useMcpInstances } from '@/mcp/useMcpInstances';
import { createMessagePortStream } from '@/transport/worker-stream';
import { createVolumeControl, type VolumeControl } from '@/transport/volume-control';
import { getErrorMessage } from '@/lib/utils';
import { getServerUrlOrThrow } from '@/lib/agent-model';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import type { VolumeInit } from '@/agent/volume-mount';
import { MainZenfs } from '@/vault/main-zenfs';
import { useVolumes, type UseVolumesResult } from '@/hooks/useVolumes';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];
const EMPTY_SESSIONS: BodhiSessionSummary[] = [];
const EMPTY_FEATURES: BodhiFeatureBag = {};
const EMPTY_TOOL_CALLS: ToolCallView[] = [];
const EMPTY_MCP_STATES: Record<string, McpConnectionMeta> = {};
const EMPTY_MCP_INSTANCES: McpInstanceView[] = [];
const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;
const EMPTY_AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([]);

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  title: string;
  status: 'in_progress' | 'completed' | 'failed' | 'pending';
  rawInput?: unknown;
  rawOutput?: unknown;
  text: string;
  turn: number;
}

interface AcpRuntime {
  worker: Worker;
  client: AcpClient;
  volumeControl: VolumeControl;
  mainZenfs: MainZenfs;
  initialize: Promise<void>;
  resolveInit: (volumes: VolumeInit[]) => void;
}

// StrictMode double-mounts every effect; keep the worker + client at
// module scope so we spawn exactly one agent worker for the tab.
let _runtime: AcpRuntime | null = null;
let _authKey: string | null = null;
let _authPromise: Promise<void> | null = null;
let _authModels: BodhiModelDescriptor[] = [];
let _session: string | null = null;
let _sessionPromise: Promise<string> | null = null;

function ensureRuntime(): AcpRuntime {
  if (_runtime) return _runtime;
  const worker = new Worker(new URL('../agent/agent-worker.ts', import.meta.url), {
    type: 'module',
  });
  const channel = new MessageChannel();
  // `init` is posted lazily once the main thread has resolved the
  // initial volume list (FSA handles + dev/test seeds). The
  // `ClientSideConnection` below would otherwise dispatch requests
  // into a worker that hasn't constructed the agent yet.
  let resolveInit!: (volumes: VolumeInit[]) => void;
  let initPosted = false;
  const mainZenfs = new MainZenfs();
  const initPromise = new Promise<void>(resolve => {
    resolveInit = (volumes: VolumeInit[]) => {
      if (initPosted) return;
      initPosted = true;
      // Mount duplicate backends on the main thread for the fs/*
      // client handler seam. We don't block ACP init on this — the
      // worker owns the source of truth and the handlers defensively
      // check membership on every call — but we do start mounting
      // immediately so handlers see the right entries by the time
      // an external ACP agent calls fs/readTextFile.
      void mainZenfs.mountAll(volumes);
      worker.postMessage({ type: 'init', agentPort: channel.port2, volumes }, [channel.port2]);
      resolve();
    };
  });
  const { readable, writable } = createMessagePortStream(channel.port1);
  const stream = ndJsonStream(writable, readable);

  const holder: { client?: AcpClient } = {};
  const fsHandlers = buildFsHandlers({ view: { list: () => mainZenfs.list() } });
  const handler: Client = {
    async requestPermission() {
      throw new Error('requestPermission: not supported in web-acp M0');
    },
    async sessionUpdate(params: SessionNotification) {
      holder.client?.dispatchSessionUpdate(params);
    },
    async readTextFile(params) {
      return fsHandlers.readTextFile(params);
    },
    async writeTextFile(params) {
      return fsHandlers.writeTextFile(params);
    },
  };
  const conn = new ClientSideConnection(() => handler, stream);
  const client = new AcpClient(conn);
  holder.client = client;

  const initialize = initPromise.then(() => client.initialize()).then(() => undefined);
  const volumeControl = wrapVolumeControl(createVolumeControl(worker), mainZenfs);
  _runtime = { worker, client, volumeControl, mainZenfs, initialize, resolveInit };
  return _runtime;
}

/**
 * Mirror worker-side mount/unmount onto the main-thread ZenFS so the
 * `fs/*` handlers stay in sync with the volume registry. Worker-side
 * mount is authoritative — main-thread failures are logged but never
 * surfaced to the caller since the handler falls through to a
 * membership check anyway.
 */
function wrapVolumeControl(inner: VolumeControl, mainZenfs: MainZenfs): VolumeControl {
  return {
    async mount(init) {
      await inner.mount(init);
      try {
        await mainZenfs.mount(init);
      } catch (err) {
        console.warn('[useAcp] main-zenfs mount failed:', err);
      }
    },
    async unmount(mountName) {
      await inner.unmount(mountName);
      try {
        await mainZenfs.unmount(mountName);
      } catch (err) {
        console.warn('[useAcp] main-zenfs unmount failed:', err);
      }
    },
    dispose() {
      inner.dispose();
    },
  };
}

function authKeyOf(token: string, baseUrl: string): string {
  return `${baseUrl}::${token}`;
}

function toBodhiModelInfo(model: BodhiModelDescriptor): BodhiModelInfo {
  return { id: model.id, apiFormat: model.apiFormat as ApiFormat };
}

function emptyAssistantMessage(): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
  } as unknown as AgentMessage;
}

function getAssistantText(msg: AgentMessage): string {
  const content = (msg as unknown as { content: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('');
}

function withAssistantText(msg: AgentMessage, text: string): AgentMessage {
  return {
    ...(msg as unknown as Record<string, unknown>),
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

/**
 * Recognise an agent-handled built-in invocation in raw user input
 * (M4 phase B). Mirrors the worker's prefix rule (`/<name>` then
 * end-of-string or whitespace) so client-side bubble tagging stays
 * aligned with how the worker decides to dispatch the command.
 */
function detectBuiltinTag(text: string): BodhiBuiltinTag | undefined {
  if (!text.startsWith('/')) return undefined;
  const rest = text.slice(1);
  const wsMatch = rest.match(/\s/);
  const name = wsMatch ? rest.slice(0, wsMatch.index) : rest;
  if (!isBuiltinName(name)) return undefined;
  return { command: name };
}

async function dispatchBuiltinAction(kind: string, messages: AgentMessage[]): Promise<void> {
  if (kind === 'copy') {
    const markdown = renderConversationMarkdown(messages);
    if (!markdown) {
      toast.error('Nothing to copy yet');
      return;
    }
    try {
      await navigator.clipboard.writeText(markdown);
      toast.success('Copied conversation to clipboard');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Clipboard write failed';
      toast.error(`Copy failed: ${message}`);
    }
    return;
  }
  toast.error(`Unknown built-in action: ${kind}`);
}

function toolCallContentText(
  content:
    | Array<{ type?: unknown; content?: { type?: unknown; text?: unknown } }>
    | null
    | undefined
): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      block.type === 'content' &&
      block.content &&
      block.content.type === 'text' &&
      typeof block.content.text === 'string'
    ) {
      parts.push(block.content.text);
    }
  }
  return parts.join('\n');
}

function mapToolStatus(
  status: string | undefined
): 'in_progress' | 'completed' | 'failed' | 'pending' | undefined {
  if (status === 'in_progress' || status === 'completed' || status === 'failed') return status;
  if (status === 'pending') return 'pending';
  return undefined;
}

function extractMcpMeta(meta: unknown): McpConnectionMeta | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const bodhi = (meta as { bodhi?: unknown }).bodhi;
  if (!bodhi || typeof bodhi !== 'object') return undefined;
  const mcp = (bodhi as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== 'object') return undefined;
  const rec = mcp as Record<string, unknown>;
  const server = rec.server;
  const state = rec.state;
  if (typeof server !== 'string') return undefined;
  if (
    state !== 'disconnected' &&
    state !== 'connecting' &&
    state !== 'connected' &&
    state !== 'error'
  ) {
    return undefined;
  }
  const out: McpConnectionMeta = { server, state };
  if (typeof rec.error === 'string') out.error = rec.error;
  if (Array.isArray(rec.tools) && rec.tools.every(t => typeof t === 'string')) {
    out.tools = rec.tools as string[];
  }
  return out;
}

export function useAcp() {
  const { client: bodhiClient, auth, isAuthenticated, isReady } = useBodhi();
  const mcpInstances = useMcpInstances();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | undefined>(undefined);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<BodhiModelDescriptor[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModelState] = useState<string>('');
  const [selectedApiFormat, setSelectedApiFormat] = useState<ApiFormat>('openai');
  const [sessions, setSessions] = useState<BodhiSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [features, setFeatures] = useState<BodhiFeatureBag>({});
  const [featureDefaults, setFeatureDefaults] = useState<BodhiFeatureBag>({});
  const [toolCalls, setToolCalls] = useState<ToolCallView[]>([]);
  const [mcpStates, setMcpStates] = useState<Record<string, McpConnectionMeta>>(EMPTY_MCP_STATES);
  const [mcpToggles, setMcpToggles] = useState<McpToggleSnapshot>(EMPTY_MCP_TOGGLES);
  const [availableCommands, setAvailableCommands] =
    useState<readonly AvailableCommand[]>(EMPTY_AVAILABLE_COMMANDS);
  const toolCallsRef = useRef<Map<string, ToolCallView>>(new Map());
  const turnIndexRef = useRef(0);
  const mcpInstancesRef = useRef<McpInstanceView[]>(EMPTY_MCP_INSTANCES);
  useEffect(() => {
    mcpInstancesRef.current = mcpInstances.instances;
  }, [mcpInstances.instances]);

  const streamingRef = useRef<AgentMessage | undefined>(undefined);
  const streamingMessageIdRef = useRef<string | undefined>(undefined);
  const messagesRef = useRef<AgentMessage[]>(EMPTY_MESSAGES);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const loadingModelsRef = useRef(false);
  // Remembers the last `auth.accessToken` we *handed to the worker*.
  // The first auth effect fire (token A after `null`) is the ordinary
  // login path; subsequent transitions (A → B, both non-null) are
  // rotations that force a `session/load` rebuild so the pool picks
  // up the new `Bearer` header. See `mcp.md` for the rotation
  // decision log.
  const lastWorkerTokenRef = useRef<string | null>(null);
  const mcpTogglesRef = useRef<McpToggleSnapshot>(EMPTY_MCP_TOGGLES);
  useEffect(() => {
    mcpTogglesRef.current = mcpToggles;
  }, [mcpToggles]);
  // When `session/load` is replaying stored notifications back at us, we
  // ignore them in the live stream handler — the UI rehydrates from
  // the `bodhi/getSession` snapshot instead, which is already the
  // collapsed transcript and has a defined `lastModelId`.
  const isReplayingRef = useRef(false);

  // Worker + client stay alive across re-renders; initialize once.
  useEffect(() => {
    ensureRuntime();
  }, []);

  const runtime = useMemo(() => ensureRuntime(), []);
  const volumeControl = runtime.volumeControl;

  const handleInitialVolumes = useCallback(
    (initial: VolumeInit[]) => {
      runtime.resolveInit(initial);
    },
    [runtime]
  );

  const volumes = useVolumes({ volumeControl, onInitialVolumes: handleInitialVolumes });

  // Route session/update → streaming message state.
  useEffect(() => {
    const runtime = ensureRuntime();
    const unsub = runtime.client.onSessionUpdate(notification => {
      // MCP connection lifecycle events ride on empty `agent_message_chunk`
      // notifications with `_meta.bodhi.mcp` set; they must be routed
      // regardless of replay guard.
      const mcpMeta = extractMcpMeta(notification._meta);
      if (mcpMeta) {
        setMcpStates(prev => ({ ...prev, [mcpMeta.server]: mcpMeta }));
        return;
      }
      // `available_commands_update` is a per-session refresh that must
      // hydrate the picker even when we're replaying — the latest
      // refresh after the replay is the freshest list and overrides
      // any stale persisted entry.
      if (notification.update.sessionUpdate === 'available_commands_update') {
        const list = notification.update.availableCommands ?? [];
        setAvailableCommands(list.length > 0 ? list : EMPTY_AVAILABLE_COMMANDS);
        return;
      }
      if (isReplayingRef.current) return;
      const update = notification.update;
      // M4 phase B: built-in slash commands ride the standard
      // `agent_message_chunk` wire with `_meta.bodhi.builtin` set
      // so the bubble renders muted with a "not sent to LLM"
      // badge. The tag is applied to the streaming message so it
      // travels through the existing chunk-accumulation path.
      const builtinMeta = extractBuiltinMeta(notification._meta);
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        if (!content || content.type !== 'text') return;
        const delta = content.text ?? '';
        if (!delta) return;

        const messageId = update.messageId ?? undefined;
        if (messageId && messageId !== streamingMessageIdRef.current) {
          streamingMessageIdRef.current = messageId;
          streamingRef.current = emptyAssistantMessage();
        }

        const current = streamingRef.current ?? emptyAssistantMessage();
        const nextText = getAssistantText(current) + delta;
        let next = withAssistantText(current, nextText);
        const carriedTag = builtinMeta ?? getBuiltinTag(current);
        if (carriedTag) next = withBuiltinTag(next, carriedTag);
        streamingRef.current = next;
        setStreamingMessage(next);
        return;
      }
      if (update.sessionUpdate === 'tool_call') {
        const view: ToolCallView = {
          toolCallId: update.toolCallId,
          toolName: update.title?.split(':')[0] ?? 'tool',
          title: update.title ?? update.toolCallId,
          status: update.status === 'pending' ? 'pending' : 'in_progress',
          rawInput: update.rawInput,
          text: toolCallContentText(update.content),
          turn: turnIndexRef.current,
        };
        toolCallsRef.current.set(update.toolCallId, view);
        setToolCalls(Array.from(toolCallsRef.current.values()));
        return;
      }
      if (update.sessionUpdate === 'tool_call_update') {
        const existing = toolCallsRef.current.get(update.toolCallId);
        if (!existing) return;
        const next: ToolCallView = {
          ...existing,
          status: mapToolStatus(update.status) ?? existing.status,
          rawOutput: update.rawOutput ?? existing.rawOutput,
          text: update.content ? toolCallContentText(update.content) : existing.text,
        };
        toolCallsRef.current.set(update.toolCallId, next);
        setToolCalls(Array.from(toolCallsRef.current.values()));
        return;
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!isReady) return;
    const token = auth.accessToken ?? null;
    const runtime = ensureRuntime();

    if (!token) {
      _authKey = null;
      _authPromise = null;
      _authModels = [];
      lastWorkerTokenRef.current = null;
      return;
    }

    loadingModelsRef.current = true;
    let cancelled = false;
    const prevWorkerToken = lastWorkerTokenRef.current;

    const run = async () => {
      setIsLoadingModels(true);
      setError(null);
      try {
        const serverUrl = getServerUrlOrThrow(bodhiClient.getState());
        const key = authKeyOf(token, serverUrl);
        if (key !== _authKey || !_authPromise) {
          _authKey = key;
          _authPromise = (async () => {
            await runtime.initialize;
            await runtime.client.authenticate({ token, baseUrl: serverUrl });
            _authModels = await runtime.client.listModels();
          })();
        }
        await _authPromise;
        if (cancelled) return;
        lastWorkerTokenRef.current = token;
        setModels(_authModels);
        if (_authModels.length > 0) {
          setSelectedModelState(prev => {
            if (prev && _authModels.some(m => m.id === prev)) return prev;
            const first = _authModels[0];
            setSelectedApiFormat(first.apiFormat as ApiFormat);
            return first.id;
          });
        }
        // Token *rotation* (A → B, both non-null) on an already-active
        // session: the worker's MCP pool still holds the stale
        // `Bearer A` header, so re-issue `session/load` with freshly
        // composed servers. The pool evicts + reconnects on the auth
        // fingerprint change. New-login (null → A) path is handled by
        // the auto-`ensureSession` effect below.
        if (prevWorkerToken && prevWorkerToken !== token && _session) {
          try {
            const servers = composeMcpServers(
              mcpInstancesRef.current,
              token,
              serverUrl,
              mcpTogglesRef.current
            );
            await runtime.client.loadSession(_session, servers);
          } catch (rotErr) {
            console.error('[useAcp] token-rotation session/load failed:', rotErr);
          }
        }
      } catch (err) {
        console.error('ACP authenticate/listModels failed:', err);
        _authKey = null;
        _authPromise = null;
        if (!cancelled) {
          setError(getErrorMessage(err, 'Failed to connect to agent'));
        }
      } finally {
        loadingModelsRef.current = false;
        if (!cancelled) setIsLoadingModels(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [auth.accessToken, bodhiClient, isReady]);

  const loadModels = useCallback(async () => {
    if (loadingModelsRef.current) return;
    if (!isAuthenticated) {
      setError('Please log in to load models');
      return;
    }
    loadingModelsRef.current = true;
    setIsLoadingModels(true);
    setError(null);
    try {
      const runtime = ensureRuntime();
      await runtime.initialize;
      const list = await runtime.client.listModels();
      _authModels = list;
      setModels(list);
      if (list.length > 0) {
        setSelectedModelState(prev => {
          if (prev && list.some(m => m.id === prev)) return prev;
          const first = list[0];
          setSelectedApiFormat(first.apiFormat as ApiFormat);
          return first.id;
        });
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(getErrorMessage(err, 'Failed to fetch models'));
    } finally {
      setIsLoadingModels(false);
      loadingModelsRef.current = false;
    }
  }, [isAuthenticated]);

  const setSelectedModel = useCallback((id: string, fmt: ApiFormat) => {
    setSelectedModelState(id);
    setSelectedApiFormat(fmt);
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!isAuthenticated) {
      setSessions([]);
      return;
    }
    try {
      const runtime = ensureRuntime();
      await runtime.initialize;
      const list = await runtime.client.listSessions();
      setSessions(list);
    } catch (err) {
      console.error('bodhi/listSessions failed:', err);
    }
  }, [isAuthenticated]);

  // Refresh sessions once auth is in place; list persists across reload
  // because the worker writes to IndexedDB. `refreshSessions` already
  // clears state when unauthenticated.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await refreshSessions();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  const refreshFeatures = useCallback(async (sessionId: string) => {
    const runtime = ensureRuntime();
    try {
      await runtime.initialize;
      const payload = await runtime.client.listFeatures(sessionId);
      setFeatures(payload.features ?? {});
      setFeatureDefaults(payload.defaults ?? {});
    } catch (err) {
      console.error('_bodhi/features/list failed:', err);
    }
  }, []);

  const setFeature = useCallback(
    async (key: string, value: boolean) => {
      if (!_session) return;
      const runtime = ensureRuntime();
      try {
        const payload = await runtime.client.setFeature(_session, key, value);
        setFeatures(payload.features ?? {});
      } catch (err) {
        console.error('_bodhi/features/set failed:', err);
        setError(getErrorMessage(err, 'Failed to toggle feature'));
        await refreshFeatures(_session);
      }
    },
    [refreshFeatures]
  );

  const composeCurrentMcpServers = useCallback(
    (toggles?: McpToggleSnapshot): McpServerHttp[] => {
      const token = auth.accessToken;
      if (!token) return [];
      try {
        const baseUrl = getServerUrlOrThrow(bodhiClient.getState());
        return composeMcpServers(mcpInstancesRef.current, token, baseUrl, toggles);
      } catch (err) {
        console.warn('[useAcp] composeMcpServers failed:', err);
        return [];
      }
    },
    [auth.accessToken, bodhiClient]
  );

  /**
   * Flip a per-session MCP toggle. `toolName` omitted toggles the
   * server; otherwise toggles the individual tool. The worker responds
   * with the full snapshot so we rehydrate local state in one shot.
   *
   * A server-level toggle change implies a new `mcpServers` composition
   * for the worker's pool (the disabled server must come off / come
   * back on). We re-issue `session/load` with the freshly composed
   * array so the worker releases / acquires the right connections —
   * tool-only toggles just trickle through to the next `prompt` turn
   * since the pool is unchanged.
   */
  const setMcpToggle = useCallback(
    async (serverSlug: string, value: boolean, toolName?: string) => {
      if (!_session) return;
      const runtime = ensureRuntime();
      try {
        const payload = await runtime.client.setMcpToggle(_session, serverSlug, value, toolName);
        const nextToggles = (payload.toggles ?? { servers: {}, tools: {} }) as McpToggleSnapshot;
        setMcpToggles(nextToggles);
        if (!toolName) {
          const servers = composeCurrentMcpServers(nextToggles);
          await runtime.client.loadSession(_session, servers);
        }
      } catch (err) {
        console.error('_bodhi/mcp/toggles/set failed:', err);
        setError(getErrorMessage(err, 'Failed to toggle MCP'));
      }
    },
    [composeCurrentMcpServers]
  );

  const ensureSession = useCallback(async (): Promise<string> => {
    if (_session) return _session;
    if (_sessionPromise) return _sessionPromise;
    const runtime = ensureRuntime();
    _sessionPromise = (async () => {
      await runtime.initialize;
      // Fresh session: no stored toggles yet so everything defaults to on.
      const servers = composeCurrentMcpServers();
      const response = await runtime.client.newSession(servers);
      _session = response.sessionId;
      return _session;
    })();
    try {
      const id = await _sessionPromise;
      setCurrentSessionId(id);
      setMcpToggles(EMPTY_MCP_TOGGLES);
      void refreshFeatures(id);
      return id;
    } finally {
      _sessionPromise = null;
    }
  }, [composeCurrentMcpServers, refreshFeatures]);

  // Ensure a session exists once auth lands so feature defaults are
  // fetched before the user interacts with the feature panel. This
  // also gives `_bodhi/features/set` a sessionId to write against.
  //
  // The MCP instances fetch kicks off from `useMcpInstances` at the
  // same moment auth lands. We gate `ensureSession` on `isReady` —
  // which is cleared synchronously the instant auth flips — so the
  // worker pool receives the composed `McpServerHttp[]` on the very
  // first `session/new`. Fetch failures still flip `isReady: true`
  // with an empty list, so the gate never deadlocks.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (currentSessionId) return;
    if (!mcpInstances.isReady) return;
    let cancelled = false;
    const run = async () => {
      if (_authPromise) {
        try {
          await _authPromise;
        } catch {
          return;
        }
      }
      if (cancelled) return;
      try {
        await ensureSession();
      } catch (err) {
        console.error('auto-ensureSession failed:', err);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, currentSessionId, ensureSession, mcpInstances.isReady]);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const runtime = ensureRuntime();
      setError(null);
      setIsLoadingSession(true);
      isReplayingRef.current = true;
      streamingRef.current = undefined;
      streamingMessageIdRef.current = undefined;
      setStreamingMessage(undefined);
      try {
        await runtime.initialize;
        // If auth already landed we also want to ensure models are
        // loaded so the caller can re-select `lastModelId`.
        if (_authPromise) {
          try {
            await _authPromise;
          } catch {
            /* handled by auth effect */
          }
        }
        // Fetch the persisted snapshot (messages + lastModelId + toggles)
        // *before* `session/load` so we can filter the composed
        // `mcpServers` with the stored per-session toggles. `getSession`
        // reads straight from Dexie — it does not require the session
        // to be resident in the worker's in-memory map.
        const snapshot = await runtime.client.getSession(sessionId);
        const toggles = snapshot.mcpToggles ?? { servers: {}, tools: {} };
        const servers = composeCurrentMcpServers(toggles);
        await runtime.client.loadSession(sessionId, servers);
        _session = sessionId;
        setCurrentSessionId(sessionId);
        setMessages((snapshot.messages ?? []) as AgentMessage[]);
        setMcpToggles(toggles);
        void refreshFeatures(sessionId);
        toolCallsRef.current.clear();
        turnIndexRef.current = 0;
        setToolCalls([]);
        if (snapshot.lastModelId) {
          const match = _authModels.find(m => m.id === snapshot.lastModelId);
          if (match) {
            setSelectedModelState(match.id);
            setSelectedApiFormat(match.apiFormat as ApiFormat);
          }
        }
      } catch (err) {
        console.error('session/load failed:', err);
        setError(getErrorMessage(err, 'Failed to load session'));
      } finally {
        isReplayingRef.current = false;
        setIsLoadingSession(false);
      }
    },
    [composeCurrentMcpServers, refreshFeatures]
  );

  const sendMessage = useCallback(
    async (prompt: string) => {
      const builtinTag = detectBuiltinTag(prompt);
      // Built-ins (M4 phase B) bypass the LLM entirely on the worker
      // side, so the "no model selected" gate doesn't apply to them —
      // /help, /version, /session, /copy must work without a model.
      if (!builtinTag && !selectedModel) {
        setError('Please select a model first');
        return;
      }
      const runtime = ensureRuntime();
      setError(null);

      // Wait for auth to land before sending the first prompt.
      if (_authPromise) {
        try {
          await _authPromise;
        } catch {
          // error surfaced by the auth effect; abort send
          return;
        }
      }

      const localUserMsg = builtinTag
        ? withBuiltinTag(userMessage(prompt), builtinTag)
        : userMessage(prompt);
      setMessages(prev => [...prev, localUserMsg]);
      streamingRef.current = undefined;
      streamingMessageIdRef.current = undefined;
      setStreamingMessage(undefined);
      setIsStreaming(true);

      try {
        const sessionId = await ensureSession();
        const response = await runtime.client.prompt(sessionId, prompt, selectedModel);
        const finalMsg = streamingRef.current;
        if (finalMsg && response.stopReason !== 'cancelled') {
          setMessages(prev => [...prev, finalMsg]);
          // M4 phase B: dispatch any client-side action attached to a
          // built-in's reply. We snapshot `messagesRef.current` here
          // (one tick before the appended built-in pair lands) and let
          // the markdown renderer drop built-in entries — that gives
          // /copy the LLM-only conversation.
          const replyTag = getBuiltinTag(finalMsg);
          if (replyTag?.action) {
            void dispatchBuiltinAction(replyTag.action.kind, messagesRef.current);
          }
        }
        void refreshSessions();
      } catch (err) {
        console.error('session/prompt failed:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      } finally {
        streamingRef.current = undefined;
        streamingMessageIdRef.current = undefined;
        setStreamingMessage(undefined);
        setIsStreaming(false);
        turnIndexRef.current += 1;
      }
    },
    [selectedModel, ensureSession, refreshSessions]
  );

  const stop = useCallback(() => {
    if (!_session) return;
    const runtime = ensureRuntime();
    void runtime.client.cancel(_session);
  }, []);

  const clearMessages = useCallback(() => {
    if (_session) {
      const runtime = ensureRuntime();
      void runtime.client.cancel(_session);
    }
    _session = null;
    streamingRef.current = undefined;
    streamingMessageIdRef.current = undefined;
    setMessages([]);
    setStreamingMessage(undefined);
    setError(null);
    setCurrentSessionId(null);
    setFeatures({});
    setMcpStates(EMPTY_MCP_STATES);
    setMcpToggles(EMPTY_MCP_TOGGLES);
    setAvailableCommands(EMPTY_AVAILABLE_COMMANDS);
    toolCallsRef.current.clear();
    turnIndexRef.current = 0;
    setToolCalls([]);
  }, []);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const runtime = ensureRuntime();
      try {
        await runtime.initialize;
        const isActive = sessionId === _session;
        if (isActive) {
          // Cancel any in-flight prompt before the row is destroyed
          // so a late stream chunk can't reattach to a phantom row.
          try {
            await runtime.client.cancel(sessionId);
          } catch {
            /* swallow — worker may already have torn the session down */
          }
          clearMessages();
        }
        await runtime.client.deleteSession(sessionId);
      } catch (err) {
        console.error('_bodhi/sessions/delete failed:', err);
        setError(getErrorMessage(err, 'Failed to delete session'));
      } finally {
        await refreshSessions();
      }
    },
    [clearMessages, refreshSessions]
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    if (isAuthenticated || !_session) return;
    let cancelled = false;
    const run = async () => {
      const runtime = ensureRuntime();
      try {
        await runtime.client.cancel(_session!);
      } catch {
        /* swallow — we're tearing down anyway */
      }
      _session = null;
      if (!cancelled) setCurrentSessionId(null);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const displayModels = models.map(toBodhiModelInfo);

  return {
    messages: isAuthenticated ? messages : EMPTY_MESSAGES,
    streamingMessage: isAuthenticated ? streamingMessage : undefined,
    isStreaming: isAuthenticated ? isStreaming : false,
    selectedModel: isAuthenticated ? selectedModel : '',
    selectedApiFormat,
    setSelectedModel,
    sendMessage,
    stop,
    clearMessages,
    error: isAuthenticated ? error : null,
    clearError,
    models: isAuthenticated ? displayModels : EMPTY_MODELS,
    isLoadingModels: isAuthenticated ? isLoadingModels : false,
    loadModels,
    sessions: isAuthenticated ? sessions : EMPTY_SESSIONS,
    refreshSessions,
    loadSession,
    deleteSession,
    currentSessionId: isAuthenticated ? currentSessionId : null,
    isLoadingSession: isAuthenticated ? isLoadingSession : false,
    volumes,
    features: isAuthenticated ? features : EMPTY_FEATURES,
    featureDefaults,
    setFeature,
    toolCalls: isAuthenticated ? toolCalls : EMPTY_TOOL_CALLS,
    availableCommands: isAuthenticated ? availableCommands : EMPTY_AVAILABLE_COMMANDS,
    mcp: {
      instances: isAuthenticated ? mcpInstances.instances : EMPTY_MCP_INSTANCES,
      states: isAuthenticated ? mcpStates : EMPTY_MCP_STATES,
      toggles: isAuthenticated ? mcpToggles : EMPTY_MCP_TOGGLES,
      isLoading: mcpInstances.isLoading,
      error: mcpInstances.error,
      refresh: mcpInstances.refresh,
      setToggle: setMcpToggle,
    },
  };
}

export type { UseVolumesResult };

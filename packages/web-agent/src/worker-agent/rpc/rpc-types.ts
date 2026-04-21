/**
 * RPC protocol types.
 *
 * All values on the wire must be structured-cloneable — no functions,
 * no AgentTool instances (their `execute` closures don't survive cloning).
 * Tools and stream functions are configured on the server-side AgentSession
 * directly; only turn-lifecycle commands flow through RPC.
 */

import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { LlmAuthCredential } from '../llm/types';
import type { SlashCommandInfo } from '../core/commands/types';
import type { ExtensionDescriptor, ExtensionError } from '../core/extensions/types';
import type {
  SessionHeader,
  SessionMeta,
  SessionSummary,
  UiMessageMeta,
} from '../core/session/types';
import type { SerializedError } from './error';

// ============================================================================
// Commands (client → server)
// ============================================================================

export type RpcCommand =
  | { id: string; type: 'prompt'; message: string }
  | { id: string; type: 'abort' }
  | { id: string; type: 'get_state' }
  | { id: string; type: 'get_messages' }
  | { id: string; type: 'set_model'; provider: string; modelId: string }
  /**
   * Ask the Worker for its current model catalog. The Worker delegates to
   * the injected `LlmProvider.getAvailableModels()` — for Bodhi this
   * round-trips `/bodhi/v1/models` each call, so the main thread owns
   * none of the fetching/mapping logic.
   */
  | { id: string; type: 'get_available_models' }
  | { id: string; type: 'set_system_prompt'; prompt: string }
  | { id: string; type: 'reset' }
  /**
   * Rotate the worker-side LLM auth credential. The payload carries a
   * `provider` tag so future non-Bodhi auth providers can coexist; the
   * worker's `LlmProvider` inspects the tag and accepts or ignores
   * the credential accordingly.
   */
  | { id: string; type: 'set_auth_token'; credential: LlmAuthCredential | null }
  | { id: string; type: 'mount_vault'; handle: FileSystemDirectoryHandle }
  | { id: string; type: 'unmount_vault' }
  | { id: string; type: 'set_mcp_tools'; tools: McpToolDescriptor[] }
  | {
      id: string;
      type: 'tool_call_response';
      callId: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      type: 'tool_call_response';
      callId: string;
      ok: false;
      error: SerializedError;
    }
  | { id: string; type: 'list_sessions' }
  | { id: string; type: 'load_session'; sessionId: string }
  | { id: string; type: 'new_session'; parentSession?: string }
  | { id: string; type: 'delete_session'; sessionId: string }
  | { id: string; type: 'set_session_name'; name: string }
  | { id: string; type: 'get_session_meta' }
  | { id: string; type: 'fork_session'; fromEntryId: string }
  | { id: string; type: 'navigate_to_leaf'; entryId: string }
  | { id: string; type: 'compact_now' }
  /**
   * Return the unified slash-command listing (builtins + prompt
   * templates loaded from the mounted vault's `.pi/prompts/`). Feeds
   * the main-thread autocomplete palette.
   */
  | { id: string; type: 'list_commands' }
  /**
   * Re-scan the vault's `.pi/prompts/` directory for template changes
   * and return the refreshed listing. Invoked by `/reload`.
   */
  | { id: string; type: 'reload_commands' }
  /**
   * Return the current extension descriptor list (name, enabled,
   * loaded, error) for the main-thread ExtensionsPanel. The worker is
   * the source of truth because the actual extension factories only
   * run there.
   */
  | { id: string; type: 'list_extensions' }
  /**
   * Push a new enabled-state map from the main thread (Dexie-backed) to
   * the worker. The worker reconciles against the map at the next
   * `agent_end` boundary, then surfaces an `extension_states` event
   * with the refreshed descriptor list.
   */
  | { id: string; type: 'set_extension_states'; states: Record<string, boolean> };

export type RpcCommandType = RpcCommand['type'];

/**
 * Plain-data description of an MCP tool. The actual `execute` closure lives
 * on the main thread (it captures the MCP client + auth context); the
 * Worker-side AgentSession sees only this descriptor and emits a
 * `tool_call_request` event when the agent invokes one.
 */
export interface McpToolDescriptor {
  name: string;
  description: string;
  parameters: unknown;
}

// ============================================================================
// Session state snapshot
// ============================================================================

export interface RpcSessionState {
  isStreaming: boolean;
  messageCount: number;
  /**
   * The currently selected model, or `undefined` when none has been set.
   * Shape mirrors `coding-agent/src/modes/rpc/rpc-types.ts::RpcSessionState.model`.
   */
  model?: Model<Api>;
  errorMessage?: string;
}

// ============================================================================
// Responses (server → client, correlated by id)
// ============================================================================

export type RpcResponse =
  | { id: string; type: 'response'; command: 'prompt'; success: true }
  | { id: string; type: 'response'; command: 'abort'; success: true }
  | { id: string; type: 'response'; command: 'get_state'; success: true; data: RpcSessionState }
  | { id: string; type: 'response'; command: 'get_messages'; success: true; data: AgentMessage[] }
  | {
      id: string;
      type: 'response';
      command: 'set_model';
      success: true;
      data: Model<Api>;
    }
  | {
      id: string;
      type: 'response';
      command: 'get_available_models';
      success: true;
      data: { models: Model<Api>[] };
    }
  | { id: string; type: 'response'; command: 'set_system_prompt'; success: true }
  | { id: string; type: 'response'; command: 'reset'; success: true }
  | { id: string; type: 'response'; command: 'set_auth_token'; success: true }
  | { id: string; type: 'response'; command: 'mount_vault'; success: true }
  | { id: string; type: 'response'; command: 'unmount_vault'; success: true }
  | { id: string; type: 'response'; command: 'set_mcp_tools'; success: true }
  | { id: string; type: 'response'; command: 'tool_call_response'; success: true }
  | {
      id: string;
      type: 'response';
      command: 'list_sessions';
      success: true;
      data: SessionSummary[];
    }
  | { id: string; type: 'response'; command: 'load_session'; success: true }
  | {
      id: string;
      type: 'response';
      command: 'new_session';
      success: true;
      data: { sessionId: string };
    }
  | { id: string; type: 'response'; command: 'delete_session'; success: true }
  | { id: string; type: 'response'; command: 'set_session_name'; success: true }
  | {
      id: string;
      type: 'response';
      command: 'get_session_meta';
      success: true;
      data: SessionMeta | null;
    }
  | {
      id: string;
      type: 'response';
      command: 'fork_session';
      success: true;
      data: { sessionId: string };
    }
  | { id: string; type: 'response'; command: 'navigate_to_leaf'; success: true }
  | { id: string; type: 'response'; command: 'compact_now'; success: true }
  | {
      id: string;
      type: 'response';
      command: 'list_commands';
      success: true;
      data: SlashCommandInfo[];
    }
  | {
      id: string;
      type: 'response';
      command: 'reload_commands';
      success: true;
      data: SlashCommandInfo[];
    }
  | {
      id: string;
      type: 'response';
      command: 'list_extensions';
      success: true;
      data: ExtensionDescriptor[];
    }
  | {
      id: string;
      type: 'response';
      command: 'set_extension_states';
      success: true;
      data: ExtensionDescriptor[];
    }
  | {
      id: string;
      type: 'response';
      command: RpcCommandType;
      success: false;
      error: SerializedError;
    };

// ============================================================================
// Events (server → client, unsolicited; no id correlation)
// ============================================================================

/**
 * Event envelope carries the underlying AgentEvent plus a snapshot of
 * derived state (messages, streaming message, error) so the client can
 * update its UI without issuing follow-up get_* commands on every event.
 */
export interface RpcAgentEventEnvelope {
  type: 'event';
  event: AgentEvent;
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  errorMessage?: string;
}

/**
 * Worker → Main upcall: the agent invoked a tool whose closure lives on the
 * main thread (e.g. an MCP tool that holds the bodhiClient + auth context).
 * Main runs the actual call and sends `tool_call_response` back.
 */
export interface RpcToolCallRequest {
  type: 'tool_call_request';
  callId: string;
  toolName: string;
  args: unknown;
}

/**
 * Worker → Main synthetic event: a session was loaded (either at boot
 * restore from localStorage, or after an explicit `load_session` command).
 * Carries the full restored message list + header + name so the main
 * thread can update its UI state from one envelope without further
 * round-trips.
 */
export interface RpcSessionLoadedEvent {
  type: 'session_loaded';
  sessionId: string;
  header: SessionHeader | null;
  name?: string;
  messages: AgentMessage[];
  /** Per-message metadata aligned with `messages` (entry ids + compaction info). */
  messageMeta: UiMessageMeta[];
  /**
   * The model identifier the session resolved to after replaying its
   * persisted `model_change` entries, or `null` when the session has no
   * selected model. Populated by the Worker so the main thread can drive
   * its combobox state directly off this envelope — no follow-up
   * `get_state` round trip is needed to recover the selection.
   *
   * Shape `{ provider, id }` mirrors `Model<Api>` rather than the
   * internal `SessionContext.model.modelId` name so the UI can match
   * directly against entries from `get_available_models`.
   */
  model: { provider: string; id: string } | null;
}

/**
 * Worker → Main synthetic event: a compaction pipeline has started or
 * finished. Drives the UI's "compacting…" indicator without per-turn
 * polling; the accompanying `messages` refresh happens via the
 * `session_loaded` re-emission the Worker runs on success.
 */
export interface RpcCompactionEvent {
  type: 'compaction_start' | 'compaction_end';
  /** Whether the pipeline finished with a persisted CompactionEntry. */
  success?: boolean;
  /** Error message populated when `success === false`. */
  errorMessage?: string;
  /** Tokens-before snapshot, carried on `compaction_end.success=true` for telemetry. */
  tokensBefore?: number;
}

/**
 * Worker → Main synthetic event: the set of loaded extensions changed.
 *
 * Fired after `mount_vault`, `unmount_vault`, `set_extension_states`
 * reconciliation, and `reload_commands`. The main thread uses this to
 * render the `ExtensionsPanel` without needing to poll `list_extensions`.
 */
export interface RpcExtensionStatesEvent {
  type: 'extension_states';
  extensions: ExtensionDescriptor[];
}

/**
 * Worker → Main synthetic event: a hook handler, factory, or tool
 * execution inside an extension threw. Rendered as a transient error
 * message (same treatment as `compaction_end.success=false`).
 */
export interface RpcExtensionErrorEvent extends ExtensionError {
  type: 'extension_error';
}

export type RpcEventEnvelope =
  | RpcAgentEventEnvelope
  | RpcToolCallRequest
  | RpcSessionLoadedEvent
  | RpcCompactionEvent
  | RpcExtensionStatesEvent
  | RpcExtensionErrorEvent;

// ============================================================================
// Wire envelope
// ============================================================================

export type RpcMessage = RpcCommand | RpcResponse | RpcEventEnvelope;
export type { UiMessageMeta } from '../core/session/types';
export type { SlashCommandInfo, SlashCommandSource } from '../core/commands/types';
export type { ExtensionDescriptor, ExtensionError } from '../core/extensions/types';

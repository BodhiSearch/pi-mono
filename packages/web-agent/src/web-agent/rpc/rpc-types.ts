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
import type { SessionHeader, SessionMeta, SessionSummary } from '../core/session/types';
import type { SerializedError } from './error';

// ============================================================================
// Commands (client → server)
// ============================================================================

export type RpcCommand =
  | { id: string; type: 'prompt'; message: string }
  | { id: string; type: 'abort' }
  | { id: string; type: 'get_state' }
  | { id: string; type: 'get_messages' }
  | { id: string; type: 'set_model'; model: Model<Api> | undefined }
  | { id: string; type: 'set_system_prompt'; prompt: string }
  | { id: string; type: 'reset' }
  | { id: string; type: 'set_auth_token'; token: string | null }
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
  | { id: string; type: 'get_session_meta' };

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
  hasModel: boolean;
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
  | { id: string; type: 'response'; command: 'set_model'; success: true }
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
}

export type RpcEventEnvelope = RpcAgentEventEnvelope | RpcToolCallRequest | RpcSessionLoadedEvent;

// ============================================================================
// Wire envelope
// ============================================================================

export type RpcMessage = RpcCommand | RpcResponse | RpcEventEnvelope;

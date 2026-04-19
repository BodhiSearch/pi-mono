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
  | { id: string; type: 'reset' };

export type RpcCommandType = RpcCommand['type'];

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
  | { id: string; type: 'response'; command: RpcCommandType; success: false; error: string };

// ============================================================================
// Events (server → client, unsolicited; no id correlation)
// ============================================================================

/**
 * Event envelope carries the underlying AgentEvent plus a snapshot of
 * derived state (messages, streaming message, error) so the client can
 * update its UI without issuing follow-up get_* commands on every event.
 */
export interface RpcEventEnvelope {
  type: 'event';
  event: AgentEvent;
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AgentMessage;
  errorMessage?: string;
}

// ============================================================================
// Wire envelope
// ============================================================================

export type RpcMessage = RpcCommand | RpcResponse | RpcEventEnvelope;

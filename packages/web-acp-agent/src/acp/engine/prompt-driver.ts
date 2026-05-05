import type {
  ToolCall as AcpToolCall,
  ToolCallUpdate as AcpToolCallUpdate,
  AgentSideConnection,
  PromptRequest,
  PromptResponse,
  ToolCallStatus,
} from '@agentclientprotocol/sdk';
import type {
  AfterToolCallResult,
  AgentEvent,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { TSchema } from '@sinclair/typebox';
import { expandCommand } from '../../agent/commands';
import type { InlineAgentSetModelOptions } from '../../agent/inline-agent';
import { composeSystemPrompt } from '../../agent/system-prompt';
import { createBashTool } from '../../agent/tools/bash-tool';
import {
  extractAssistantText,
  extractMessageId,
  toolTitle,
  toToolCallContent,
} from '../wire-utils';
import { tryHandleBuiltin, tryHandleExtensionCommand } from './builtin-dispatch';
import type { AcpAdapterServices } from './services';
import type { AcpSessionRuntime } from './session-runtime';

interface StreamCursor {
  messageId: string | undefined;
  emittedLength: number;
}

/**
 * Engine-layer turn driver. Runs one `session/prompt` end-to-end:
 * built-in early-return → model resolve → slash expansion → inline
 * rehydrate-if-needed → tool assembly → stream + persist.
 */
export class PromptTurnDriver {
  readonly #conn: AgentSideConnection;
  readonly #services: AcpAdapterServices;
  readonly #runtime: AcpSessionRuntime;
  readonly #buildVersion: string;
  readonly #acpSdkVersion: string;

  #cancelled = false;
  #turnAbort: AbortController | undefined;
  #promptSessionId: string | null = null;
  // Per-session mutex: a second concurrent `prompt` rejects rather
  // than interleaving streams. Cleared in `run()`'s finally.
  readonly #inflightBySession = new Map<string, Promise<PromptResponse>>();

  constructor(args: {
    conn: AgentSideConnection;
    services: AcpAdapterServices;
    runtime: AcpSessionRuntime;
    buildVersion: string;
    acpSdkVersion: string;
  }) {
    this.#conn = args.conn;
    this.#services = args.services;
    this.#runtime = args.runtime;
    this.#buildVersion = args.buildVersion;
    this.#acpSdkVersion = args.acpSdkVersion;
  }

  async run(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#runtime.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    if (this.#inflightBySession.has(params.sessionId)) {
      const err = new Error(
        `session/prompt: a turn is already in flight for session '${params.sessionId}'`
      );
      (err as unknown as { code: number }).code = -32011;
      throw err;
    }
    const turnPromise = this.#runTurn(params, session);
    this.#inflightBySession.set(params.sessionId, turnPromise);
    try {
      return await turnPromise;
    } finally {
      this.#inflightBySession.delete(params.sessionId);
    }
  }

  async #runTurn(
    params: PromptRequest,
    session: NonNullable<ReturnType<AcpSessionRuntime['getSession']>>
  ): Promise<PromptResponse> {
    // Built-ins run before model resolution so `/help` etc. work with
    // no model selected and never enter the LLM history. Extension
    // commands sit on the same path: registered through
    // `pi.registerCommand`, dispatched ahead of built-ins so a vault
    // command and an extension command sharing a name resolve to the
    // extension (extensions are user-installed first-class).
    const rawText = this.#extractPromptText(params);
    if (rawText) {
      const dispatchArgs = {
        conn: this.#conn,
        services: this.#services,
        runtime: this.#runtime,
        buildVersion: this.#buildVersion,
        acpSdkVersion: this.#acpSdkVersion,
        params,
        rawText,
      };
      const handledByExt = await tryHandleExtensionCommand(dispatchArgs);
      if (handledByExt) return handledByExt;
      const handled = await tryHandleBuiltin(dispatchArgs);
      if (handled) return handled;
    }

    const model = this.#resolveModel(params.sessionId);
    if (!model) {
      throw new Error('No model selected: call unstable_setSessionModel first');
    }

    this.#applySlashCommandExpansion(params);
    let text = this.#extractPromptText(params);
    if (!text) {
      throw new Error('session/prompt payload must contain at least one text block');
    }

    if (this.#services.extensions) {
      const inputResult = await this.#services.extensions.dispatchInput({
        type: 'input',
        sessionId: params.sessionId,
        text,
        source: 'user',
      });
      if (inputResult?.action === 'handled') {
        return { stopReason: 'end_turn' };
      }
      if (inputResult?.action === 'transform') {
        text = inputResult.text;
      }
    }

    // The shared inline runtime holds one history; rehydrate from
    // store if a prompt arrives for a non-active session (e.g. worker
    // restart racing `session/load`).
    if (this.#runtime.getActiveInlineSessionId() !== params.sessionId) {
      await this.#runtime.rehydrateInlineFromStore(params.sessionId);
    }

    const featureSnapshot = await this.#runtime.readFeatures(params.sessionId);
    const mcpToggleSnapshot = await this.#runtime.readMcpToggles(params.sessionId);
    const volumes = this.#services.registry?.list() ?? [];
    const tools: AgentTool<TSchema>[] = [];
    const hasVolumes = volumes.length > 0;
    this.#turnAbort = new AbortController();
    if (featureSnapshot.bashEnabled && hasVolumes && this.#services.registry) {
      const bashTool = createBashTool({ registry: this.#services.registry });
      tools.push(
        bindAbortSignal(bashTool, this.#turnAbort.signal) as unknown as AgentTool<TSchema>
      );
    }
    for (const mcpTool of this.#runtime.mcpToolsForSession(session, mcpToggleSnapshot)) {
      tools.push(bindAbortSignal(mcpTool, this.#turnAbort.signal) as AgentTool<TSchema>);
    }
    if (this.#services.extensions) {
      for (const extTool of this.#services.extensions.listTools()) {
        tools.push(
          bindAbortSignal(extTool, this.#turnAbort.signal) as unknown as AgentTool<TSchema>
        );
      }
    }
    const baseSystemPrompt = composeSystemPrompt(volumes);
    let systemPrompt = baseSystemPrompt;
    if (this.#services.extensions) {
      const patch = await this.#services.extensions.dispatchBeforeAgentStart({
        type: 'before_agent_start',
        sessionId: params.sessionId,
        prompt: text,
        systemPrompt: baseSystemPrompt,
      });
      if (patch && typeof patch.systemPrompt === 'string') {
        systemPrompt = patch.systemPrompt;
      }
    }
    const setModelOpts: InlineAgentSetModelOptions = { tools, systemPrompt };
    const extensions = this.#services.extensions;
    if (extensions) {
      const sessionId = params.sessionId;
      setModelOpts.beforeToolCall = async toolCtx => {
        const argsRecord =
          toolCtx.args && typeof toolCtx.args === 'object'
            ? (toolCtx.args as Record<string, unknown>)
            : {};
        const result = await extensions.dispatchToolCall({
          type: 'tool_call',
          sessionId,
          toolName: toolCtx.toolCall.name,
          input: argsRecord,
        });
        if (!result) return undefined;
        return result;
      };
      setModelOpts.afterToolCall = async toolCtx => {
        const argsRecord =
          toolCtx.args && typeof toolCtx.args === 'object'
            ? (toolCtx.args as Record<string, unknown>)
            : {};
        const baseResult = toolCtx.result as { content?: unknown[]; details?: unknown };
        const result = await extensions.dispatchToolResult({
          type: 'tool_result',
          sessionId,
          toolName: toolCtx.toolCall.name,
          input: argsRecord,
          content: Array.isArray(baseResult.content) ? baseResult.content : [],
          details: baseResult.details,
          isError: toolCtx.isError,
        });
        if (!result) return undefined;
        const out: AfterToolCallResult = {};
        if (result.content !== undefined) {
          out.content = result.content as AfterToolCallResult['content'];
        }
        if (result.details !== undefined) out.details = result.details;
        if (result.isError !== undefined) out.isError = result.isError;
        return out;
      };
    }
    this.#services.inline.setModel(model, setModelOpts);

    // `forceToolCall` is meaningless without a tool registered.
    if (this.#services.streamOverrides) {
      const toolChoice = featureSnapshot.forceToolCall && tools.length > 0 ? 'required' : undefined;
      this.#services.streamOverrides.current = toolChoice ? { toolChoice } : {};
    }

    const cursor: StreamCursor = { messageId: undefined, emittedLength: 0 };
    this.#cancelled = false;
    this.#promptSessionId = params.sessionId;
    const toolState = new Map<string, { toolName: string; args: unknown }>();

    // pi-agent-core treats listener throws as poison; log instead.
    const unsubscribe = this.#services.inline.subscribe(event => {
      this.#forwardEvent(params.sessionId, event, cursor, toolState).catch(err => {
        console.error(
          `[acp-prompt-driver] forwardEvent failed for session '${params.sessionId}':`,
          err
        );
      });
    });

    if (this.#services.activeSession) {
      this.#services.activeSession.current = params.sessionId;
    }

    try {
      await this.#services.inline.prompt(text);
      if (this.#cancelled) {
        return { stopReason: 'cancelled' };
      }
      const errorMessage = this.#services.inline.getErrorMessage();
      if (errorMessage) {
        throw new Error(errorMessage);
      }
      if (this.#services.store) {
        await this.#services.store.recordTurn(
          params.sessionId,
          text,
          this.#services.inline.getMessages(),
          model.id
        );
      }
      return { stopReason: 'end_turn' };
    } finally {
      unsubscribe();
      if (this.#services.streamOverrides) this.#services.streamOverrides.current = {};
      if (this.#services.activeSession) this.#services.activeSession.current = null;
      this.#turnAbort = undefined;
      this.#promptSessionId = null;
    }
  }

  abort(): void {
    this.#cancelled = true;
    this.#turnAbort?.abort();
    this.#services.inline.cancel();
  }

  // The driver is single-instance per worker, so close/delete paths
  // must guard against aborting an unrelated session's turn.
  abortIfActive(sessionId: string): void {
    if (this.#promptSessionId === sessionId) {
      this.abort();
    }
  }

  #resolveModel(sessionId: string): Model<Api> | undefined {
    const session = this.#runtime.getSession(sessionId);
    const modelId = session?.currentModelId ?? null;
    if (!modelId) return undefined;
    return this.#runtime.getModels().find(m => m.id === modelId);
  }

  // ACP makes Text + ResourceLink mandatory; flatten links into
  // `[title](uri)` so built-ins / LLM see them as text. Other block
  // kinds are gated off by `promptCapabilities`.
  #extractPromptText(params: PromptRequest): string {
    const parts: string[] = [];
    for (const block of params.prompt ?? []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
        continue;
      }
      if (block.type === 'resource_link') {
        const link = block as {
          uri?: unknown;
          name?: unknown;
          title?: unknown;
          description?: unknown;
        };
        const uri = typeof link.uri === 'string' ? link.uri : '';
        if (!uri) continue;
        const label =
          (typeof link.title === 'string' && link.title) ||
          (typeof link.name === 'string' && link.name) ||
          uri;
        const desc = typeof link.description === 'string' ? ` — ${link.description}` : '';
        parts.push(`[${label}](${uri})${desc}`);
      }
    }
    return parts.join('\n');
  }

  // If the last text block starts with `/`, replace it in-place with
  // the expanded template so the LLM sees the rendered prompt.
  #applySlashCommandExpansion(params: PromptRequest): void {
    const cached = this.#runtime.getAvailableCommands();
    if (cached.length === 0) return;
    const blocks = params.prompt;
    if (!Array.isArray(blocks)) return;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block && block.type === 'text' && typeof block.text === 'string') {
        if (!block.text.startsWith('/')) return;
        const result = expandCommand(block.text, cached);
        if (result.matched && typeof result.expanded === 'string') {
          block.text = result.expanded;
        }
        return;
      }
    }
  }

  async #forwardEvent(
    sessionId: string,
    event: AgentEvent,
    cursor: StreamCursor,
    toolState: Map<string, { toolName: string; args: unknown }>
  ): Promise<void> {
    if (event.type === 'message_update') {
      const msg = event.message;
      if (msg.role !== 'assistant') return;

      const messageId = extractMessageId(msg);
      if (messageId !== cursor.messageId) {
        cursor.messageId = messageId;
        cursor.emittedLength = 0;
      }

      const text = extractAssistantText(msg);
      if (text.length <= cursor.emittedLength) return;
      const delta = text.slice(cursor.emittedLength);
      cursor.emittedLength = text.length;

      await this.#runtime.emit({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: delta },
          ...(messageId ? { messageId } : {}),
        },
      });
      return;
    }
    if (event.type === 'tool_execution_start') {
      toolState.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      const payload: AcpToolCall = {
        toolCallId: event.toolCallId,
        title: toolTitle(event.toolName, event.args),
        kind: 'execute',
        status: 'pending',
        rawInput: event.args,
      };
      await this.#runtime.emit({
        sessionId,
        update: { sessionUpdate: 'tool_call', ...payload },
      });
      return;
    }
    if (event.type === 'tool_execution_update') {
      const update: AcpToolCallUpdate = {
        toolCallId: event.toolCallId,
        status: 'in_progress',
        ...(event.partialResult?.content
          ? {
              content: toToolCallContent(event.partialResult.content),
            }
          : {}),
      };
      await this.#runtime.emit({
        sessionId,
        update: { sessionUpdate: 'tool_call_update', ...update },
      });
      return;
    }
    if (event.type === 'tool_execution_end') {
      const status: ToolCallStatus = event.isError ? 'failed' : 'completed';
      const content = event.result?.content ? toToolCallContent(event.result.content) : undefined;
      const update: AcpToolCallUpdate = {
        toolCallId: event.toolCallId,
        status,
        rawOutput: event.result?.details ?? event.result,
        ...(content ? { content } : {}),
      };
      await this.#runtime.emit({
        sessionId,
        update: { sessionUpdate: 'tool_call_update', ...update },
      });
      toolState.delete(event.toolCallId);
      return;
    }
  }
}

// Chain the per-turn cancel signal into the tool's execute signal so
// `session/cancel` short-circuits in-flight tool runs.
function bindAbortSignal<TParams extends TSchema, TDetails>(
  tool: AgentTool<TParams, TDetails>,
  turnSignal: AbortSignal
): AgentTool<TParams, TDetails> {
  const originalExecute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (
      toolCallId: string,
      params,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<TDetails>
    ): Promise<AgentToolResult<TDetails>> => {
      const controller = new AbortController();
      if (turnSignal.aborted) controller.abort(turnSignal.reason);
      else
        turnSignal.addEventListener('abort', () => controller.abort(turnSignal.reason), {
          once: true,
        });
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else
          signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
      return originalExecute(toolCallId, params, controller.signal, onUpdate);
    },
  };
}

import type {
  AgentSideConnection,
  PromptRequest,
  PromptResponse,
  ToolCall as AcpToolCall,
  ToolCallStatus,
  ToolCallUpdate as AcpToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  AgentEvent,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import type { TSchema } from '@sinclair/typebox';
import type { Api, Model } from '@mariozechner/pi-ai';
import { expandCommand } from '@/agent/commands';
import { composeSystemPrompt } from '@/agent/system-prompt';
import { createBashTool } from '@/agent/tools/bash-tool';
import {
  extractAssistantText,
  extractMessageId,
  toToolCallContent,
  toolTitle,
} from '../wire-utils';
import { tryHandleBuiltin } from './builtin-dispatch';
import type { AcpAdapterServices } from './services';
import type { AcpSessionRuntime } from './session-runtime';

interface BodhiPromptMeta {
  bodhi?: {
    modelId?: string;
  };
}

interface StreamCursor {
  messageId: string | undefined;
  emittedLength: number;
}

/**
 * Engine-layer turn driver. Runs one `session/prompt` turn end-to-end:
 *
 *  1. early-return for built-in slash commands (`/help`, `/version`,
 *     `/copy`, `/session`, `/mcp`),
 *  2. resolve the requested model from the runtime catalog cache,
 *  3. expand vault slash commands in-place on the prompt blocks,
 *  4. ensure the inline runtime's history matches this session
 *     (rehydrating from store if needed),
 *  5. assemble the per-turn tool list (bash + MCP) wrapped with the
 *     turn's abort signal,
 *  6. install the streaming subscription, run the prompt, persist
 *     the resulting turn.
 *
 * Owns per-turn state (`#turnAbort`, `#cancelled`); these reset each
 * `run()`. Mirrors coding-agent's `agent-session.ts` turn loop, scaled
 * down to what M4 ACP currently needs.
 */
export class PromptTurnDriver {
  readonly #conn: AgentSideConnection;
  readonly #services: AcpAdapterServices;
  readonly #runtime: AcpSessionRuntime;
  readonly #buildVersion: string;
  readonly #acpSdkVersion: string;
  readonly #isDev: boolean;

  #cancelled = false;
  #turnAbort: AbortController | undefined;

  constructor(args: {
    conn: AgentSideConnection;
    services: AcpAdapterServices;
    runtime: AcpSessionRuntime;
    buildVersion: string;
    acpSdkVersion: string;
    isDev: boolean;
  }) {
    this.#conn = args.conn;
    this.#services = args.services;
    this.#runtime = args.runtime;
    this.#buildVersion = args.buildVersion;
    this.#acpSdkVersion = args.acpSdkVersion;
    this.#isDev = args.isDev;
  }

  async run(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#runtime.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${params.sessionId}`);
    }

    // M4 phase B: built-in slash commands run before any model
    // resolution / expansion so `/help`, `/version`, etc. work even
    // when no model is selected and never count against the LLM
    // history. The handler decides everything; we emit a chunk +
    // persist a 'builtin' entry + return without touching the inline
    // agent.
    const rawText = this.#extractPromptText(params);
    if (rawText) {
      const handled = await tryHandleBuiltin({
        conn: this.#conn,
        services: this.#services,
        runtime: this.#runtime,
        buildVersion: this.#buildVersion,
        acpSdkVersion: this.#acpSdkVersion,
        params,
        rawText,
      });
      if (handled) return handled;
    }

    const model = this.#resolveModel(params);
    if (!model) {
      throw new Error('No model selected: send session/prompt with _meta.bodhi.modelId');
    }

    this.#applySlashCommandExpansion(params);
    const text = this.#extractPromptText(params);
    if (!text) {
      throw new Error('session/prompt payload must contain at least one text block');
    }

    // Guard against prompt being routed to a session whose history is
    // not currently loaded into the inline runtime. This can happen
    // after the worker restarts and the client races a prompt before
    // issuing `session/load`. Rebuild state from the store so we
    // don't splice another session's context into this one.
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
      tools.push(bindAbortSignal(bashTool, this.#turnAbort.signal) as AgentTool<TSchema>);
    }
    for (const mcpTool of this.#runtime.mcpToolsForSession(session, mcpToggleSnapshot)) {
      tools.push(bindAbortSignal(mcpTool, this.#turnAbort.signal) as AgentTool<TSchema>);
    }
    const systemPrompt = composeSystemPrompt(volumes);
    this.#services.inline.setModel(model, { tools, systemPrompt });

    // Push per-turn stream overrides. `forceToolCall` is gated to DEV
    // and only meaningful when we actually registered a tool.
    if (this.#services.streamOverrides) {
      const toolChoice =
        featureSnapshot.forceToolCall && this.#isDev && tools.length > 0 ? 'required' : undefined;
      this.#services.streamOverrides.current = toolChoice ? { toolChoice } : {};
    }

    const cursor: StreamCursor = { messageId: undefined, emittedLength: 0 };
    this.#cancelled = false;
    const toolState = new Map<string, { toolName: string; args: unknown }>();

    const unsubscribe = this.#services.inline.subscribe(event => {
      void this.#forwardEvent(params.sessionId, event, cursor, toolState);
    });

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
      this.#turnAbort = undefined;
    }
  }

  /**
   * Cancel an in-flight turn. Sets the cancel flag (so `run()`
   * returns a `cancelled` stop reason once the inline runtime
   * settles), aborts the per-turn signal (so long-running tools
   * short-circuit), and tells the inline runtime to stop streaming.
   */
  abort(): void {
    this.#cancelled = true;
    this.#turnAbort?.abort();
    this.#services.inline.cancel();
  }

  // --- private turn-loop helpers ---

  #resolveModel(params: PromptRequest): Model<Api> | undefined {
    const meta = (params._meta ?? {}) as BodhiPromptMeta;
    const modelId = meta.bodhi?.modelId;
    if (!modelId) return undefined;
    return this.#runtime.getModels().find(m => m.id === modelId);
  }

  #extractPromptText(params: PromptRequest): string {
    const parts: string[] = [];
    for (const block of params.prompt ?? []) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('');
  }

  /**
   * Look at the last `text` content block in the prompt and, if it
   * starts with `/`, run agent-side slash-command expansion. The
   * literal `/cmd args` text is replaced with the expanded template
   * so the LLM sees the rendered prompt — not the slash invocation.
   *
   * No expansion when the cache is empty or no command matches; the
   * literal text passes through untouched and the LLM (or the user)
   * gets to decide what `/cmd` means.
   */
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
        status: 'in_progress',
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

/**
 * Wraps a tool so its `execute` signal is chained with the per-turn
 * cancellation signal owned by the driver. pi-agent-core passes its
 * internal abort signal (for LLM streaming) into `execute`, but for
 * tool cancellation we also want the driver's `session/cancel`
 * controller to short-circuit the current run (bash, MCP, or other).
 */
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

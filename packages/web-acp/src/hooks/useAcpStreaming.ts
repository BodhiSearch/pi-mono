import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
  BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD,
  BODHI_MCP_STATE_NOTIFICATION_METHOD,
  type AnyBodhiBuiltinAction,
} from '@/acp/index';
import {
  detectBuiltinTag,
  parseBuiltinActionParams,
  parseMcpStateParams,
  userMessage,
} from '@/acp/message-shape';
import { ensureRuntime, getAuthPromise, getModelUpdatePromise, getSession } from '@/acp/runtime';
import type { AcpAction, StreamingState } from '@/acp/streaming-reducer';
import { withBuiltinTag } from '@/lib/builtin-format';
import { getErrorMessage } from '@/lib/utils';

export interface UseAcpStreamingResult {
  sendMessage: (prompt: string) => Promise<void>;
  stop: () => void;
  clearError: () => void;
}

/**
 * Owns the host-side prompt-turn loop and the `session/update`
 * subscription. Reducer state + dispatch are owned by the facade
 * (`useAcp.ts`) and threaded in so `useAcpSession` can also issue
 * `load-start` / `load-end` / `reset` actions against the same
 * reducer instance.
 */
export function useAcpStreaming({
  state,
  dispatch,
  ensureSession,
  refreshSessions,
  dispatchAction,
  selectedModel,
  setError,
}: {
  state: StreamingState;
  dispatch: Dispatch<AcpAction>;
  ensureSession: () => Promise<string>;
  refreshSessions: () => Promise<void>;
  dispatchAction: (action: AnyBodhiBuiltinAction, messages: AgentMessage[]) => Promise<void>;
  /** Used only for the "no model selected" gate; the agent reads `SessionState.currentModelId`. */
  selectedModel: string;
  setError: (msg: string | null) => void;
}): UseAcpStreamingResult {
  // Mirror reactive deps into refs so the extNotification listener below
  // doesn't need to resubscribe on every render.
  const messagesRef = useRef<AgentMessage[]>([]);
  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  const dispatchActionRef = useRef(dispatchAction);
  useEffect(() => {
    dispatchActionRef.current = dispatchAction;
  }, [dispatchAction]);

  // Single subscribe/unsubscribe pair for `session/update` + the `_bodhi/*`
  // extNotification side-channel — avoids double-subscribe on dispatch identity churn.
  useEffect(() => {
    const runtime = ensureRuntime();
    const unsubSession = runtime.client.onSessionUpdate(notification => {
      dispatch({ type: 'session-update', notif: notification });
    });
    const unsubExt = runtime.client.onExtNotification((method, params) => {
      if (method === BODHI_MCP_STATE_NOTIFICATION_METHOD) {
        const meta = parseMcpStateParams(params);
        if (meta) dispatch({ type: 'mcp-state', meta });
        return;
      }
      if (method === BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD) {
        const action = parseBuiltinActionParams(params);
        if (action) void dispatchActionRef.current(action, messagesRef.current);
        return;
      }
      // Extensions panel listens via `useExtensions` directly; no-op here.
      if (method === BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD) return;
      console.warn('[acp/streaming] unhandled extNotification:', method);
    });
    return () => {
      unsubSession();
      unsubExt();
    };
  }, [dispatch]);

  const sendMessage = useCallback(
    async (prompt: string) => {
      const builtinTag = detectBuiltinTag(prompt);
      // Built-ins (/help, /version, /session, /copy) bypass the LLM on the worker, so the model-selected gate doesn't apply.
      if (!builtinTag && !selectedModel) {
        setError('Please select a model first');
        return;
      }
      const runtime = ensureRuntime();
      setError(null);

      const authPromise = getAuthPromise();
      if (authPromise) {
        try {
          await authPromise;
        } catch {
          // error surfaced by the auth effect; abort send
          return;
        }
      }

      const localUserMsg = builtinTag
        ? withBuiltinTag(userMessage(prompt), builtinTag)
        : userMessage(prompt);

      try {
        const sessionId = await ensureSession();
        // Await any in-flight `unstable_setSessionModel` BEFORE rendering the user bubble,
        // so a model-update failure surfaces as an inline error instead of an orphan user message.
        const modelUpdate = getModelUpdatePromise();
        if (modelUpdate) {
          try {
            await modelUpdate;
          } catch (err) {
            setError(getErrorMessage(err, 'Failed to set model'));
            return;
          }
        }
        dispatch({ type: 'turn-start', userMessage: localUserMsg });
        const response = await runtime.client.prompt(sessionId, prompt);
        // Reducer folds `streamingMessage` into `messages` synchronously on `turn-end`; don't read it from a ref here.
        dispatch({
          type: 'turn-end',
          stopReason: response.stopReason ?? 'end_turn',
        });
        void refreshSessions();
      } catch (err) {
        console.error('session/prompt failed:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
        dispatch({ type: 'turn-end', stopReason: 'error' });
      }
    },
    [selectedModel, ensureSession, refreshSessions, setError, dispatch]
  );

  const stop = useCallback(() => {
    const id = getSession();
    if (!id) return;
    void ensureRuntime().client.cancel(id);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, [setError]);

  return { sendMessage, stop, clearError };
}

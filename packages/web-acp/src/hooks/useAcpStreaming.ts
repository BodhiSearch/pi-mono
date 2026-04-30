import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AnyBodhiBuiltinAction } from '@/acp/index';
import { detectBuiltinTag, userMessage } from '@/acp/message-shape';
import { ensureRuntime, getAuthPromise, getSession } from '@/acp/runtime';
import type { StreamingAction, StreamingState } from '@/acp/streaming-reducer';
import { getBuiltinTag, withBuiltinTag } from '@/lib/builtin-format';
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
  dispatch: Dispatch<StreamingAction>;
  ensureSession: () => Promise<string>;
  refreshSessions: () => Promise<void>;
  dispatchAction: (action: AnyBodhiBuiltinAction, messages: AgentMessage[]) => Promise<void>;
  selectedModel: string;
  setError: (msg: string | null) => void;
}): UseAcpStreamingResult {
  // Refs that mirror reducer state for closure-safe reads inside
  // `sendMessage`. The reducer's reduce-then-effect ordering means
  // these are guaranteed fresh by the time the next user-driven
  // turn fires.
  const streamingMessageRef = useRef<AgentMessage | undefined>(undefined);
  const messagesRef = useRef<AgentMessage[]>([]);
  useEffect(() => {
    streamingMessageRef.current = state.streamingMessage;
  }, [state.streamingMessage]);
  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  // Route session/update notifications into the reducer.
  useEffect(() => {
    const runtime = ensureRuntime();
    const unsub = runtime.client.onSessionUpdate(notification => {
      dispatch({ type: 'session-update', notif: notification });
    });
    return unsub;
  }, [dispatch]);

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
      dispatch({ type: 'turn-start', userMessage: localUserMsg });

      try {
        const sessionId = await ensureSession();
        const response = await runtime.client.prompt(sessionId, prompt, selectedModel);
        const finalMsg = streamingMessageRef.current;
        dispatch({
          type: 'turn-end',
          stopReason: response.stopReason ?? 'end_turn',
          finalMessage: finalMsg,
        });
        if (finalMsg && response.stopReason !== 'cancelled') {
          // M4 phase B: dispatch any client-side action attached to a
          // built-in's reply. Snapshot `messagesRef.current` here (one
          // tick before the appended built-in pair lands) and let the
          // markdown renderer drop built-in entries — that gives /copy
          // the LLM-only conversation.
          const replyTag = getBuiltinTag(finalMsg);
          if (replyTag?.action) {
            void dispatchAction(replyTag.action, messagesRef.current);
          }
        }
        void refreshSessions();
      } catch (err) {
        console.error('session/prompt failed:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
        dispatch({ type: 'turn-end', stopReason: 'error' });
      }
    },
    [selectedModel, ensureSession, refreshSessions, dispatchAction, setError, dispatch]
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

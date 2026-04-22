/**
 * Main-thread hook that mediates the `pi.ui.*` channel.
 *
 * Responsibilities:
 *   - Subscribe to the RPC client's `onExtensionUIRequest` stream.
 *   - Route `notify` through `sonner` (info / warning / error mapping).
 *   - Maintain a per-extension status-chip map that `ChatInput` renders
 *     in its footer. `setStatus(null)` clears the chip.
 *   - Queue modal dialog requests (`select` / `confirm` / `input`) in
 *     FIFO order and expose the head of the queue as `activeDialog`
 *     along with a `respond` callback the renderer invokes with the
 *     user's answer.
 *   - Forward every dialog reply through `rpcClient.sendExtensionUIResponse`.
 *
 * The worker-side `ExtensionUIController` owns timeouts, abort signals,
 * and session-reset cancellation, so this hook doesn't need to track
 * them itself — it just renders what the worker sends and replies when
 * the user answers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useWebAgent } from '@/providers/web-agent-context';
import type {
  ExtensionUIConfirmPayload,
  ExtensionUIInputPayload,
  ExtensionUINotifyPayload,
  ExtensionUIRequestEvent,
  ExtensionUISelectPayload,
  ExtensionUISetStatusPayload,
} from '@/worker-agent';

/**
 * Snapshot of a pending modal dialog. The renderer derives the concrete
 * component (select / confirm / input) from the `kind` discriminator.
 */
export type ActiveExtensionDialog =
  | {
      requestId: string;
      extensionPath: string;
      kind: 'select';
      payload: ExtensionUISelectPayload;
    }
  | {
      requestId: string;
      extensionPath: string;
      kind: 'confirm';
      payload: ExtensionUIConfirmPayload;
    }
  | {
      requestId: string;
      extensionPath: string;
      kind: 'input';
      payload: ExtensionUIInputPayload;
    };

export interface UseExtensionUIResult {
  /** Head of the pending dialog queue, or `null` when nothing is active. */
  activeDialog: ActiveExtensionDialog | null;
  /**
   * Per-extension status-chip map. The ChatInput footer renders one
   * chip per entry, keyed by extension path. `setStatus(null)` removes
   * the entry entirely.
   */
  statusChips: Record<string, string>;
  /**
   * Reply to the currently-active dialog. `result` is the raw response
   * payload: `{ index }` for `select`, `boolean` for `confirm`, or
   * `string | null` for `input`. Passing `null` resolves the worker's
   * pending promise with the dialog's `cancelValue`.
   */
  respond: (requestId: string, result: unknown) => void;
  /**
   * Cancel the currently-active dialog without running user input.
   * Used when the user clicks the backdrop or presses Escape.
   */
  dismissActive: () => void;
}

export function useExtensionUI(): UseExtensionUIResult {
  const { rpcClient } = useWebAgent();
  const [queue, setQueue] = useState<ActiveExtensionDialog[]>([]);
  const [statusChips, setStatusChips] = useState<Record<string, string>>({});

  const handleNotify = useCallback((_extensionPath: string, payload: ExtensionUINotifyPayload) => {
    switch (payload.notifyType) {
      case 'error':
        toast.error(payload.message);
        return;
      case 'warning':
        toast.warning(payload.message);
        return;
      case 'info':
      default:
        toast.info(payload.message);
    }
  }, []);

  const handleSetStatus = useCallback(
    (extensionPath: string, payload: ExtensionUISetStatusPayload) => {
      setStatusChips(prev => {
        if (payload.text === null) {
          if (!(extensionPath in prev)) return prev;
          const next = { ...prev };
          delete next[extensionPath];
          return next;
        }
        if (prev[extensionPath] === payload.text) return prev;
        return { ...prev, [extensionPath]: payload.text };
      });
    },
    []
  );

  useEffect(() => {
    const off = rpcClient.onExtensionUIRequest((event: ExtensionUIRequestEvent) => {
      switch (event.kind) {
        case 'notify':
          handleNotify(event.extensionPath, event.payload as ExtensionUINotifyPayload);
          return;
        case 'setStatus':
          handleSetStatus(event.extensionPath, event.payload as ExtensionUISetStatusPayload);
          return;
        case 'select':
          setQueue(prev => [
            ...prev,
            {
              requestId: event.requestId,
              extensionPath: event.extensionPath,
              kind: 'select',
              payload: event.payload as ExtensionUISelectPayload,
            },
          ]);
          return;
        case 'confirm':
          setQueue(prev => [
            ...prev,
            {
              requestId: event.requestId,
              extensionPath: event.extensionPath,
              kind: 'confirm',
              payload: event.payload as ExtensionUIConfirmPayload,
            },
          ]);
          return;
        case 'input':
          setQueue(prev => [
            ...prev,
            {
              requestId: event.requestId,
              extensionPath: event.extensionPath,
              kind: 'input',
              payload: event.payload as ExtensionUIInputPayload,
            },
          ]);
      }
    });
    return () => {
      off();
    };
  }, [rpcClient, handleNotify, handleSetStatus]);

  const respond = useCallback(
    (requestId: string, result: unknown) => {
      // Drop the matching entry from the queue; if the worker already
      // cancelled the request (session reset) the entry may be gone
      // already, in which case we still forward the reply — the worker
      // silently drops responses for unknown ids.
      setQueue(prev => prev.filter(item => item.requestId !== requestId));
      rpcClient.sendExtensionUIResponse(requestId, result).catch(err => {
        console.error('[useExtensionUI] sendExtensionUIResponse failed:', err);
      });
    },
    [rpcClient]
  );

  const activeDialog = queue.length === 0 ? null : queue[0];

  const dismissActive = useCallback(() => {
    if (!activeDialog) return;
    // Cancelled dialogs resolve the worker-side promise with the
    // kind-specific cancel value (null for select/input, false for
    // confirm). The worker's `request<T>` helper handles the actual
    // coercion once the response arrives.
    respond(activeDialog.requestId, null);
  }, [activeDialog, respond]);

  return useMemo(
    () => ({ activeDialog, statusChips, respond, dismissActive }),
    [activeDialog, statusChips, respond, dismissActive]
  );
}

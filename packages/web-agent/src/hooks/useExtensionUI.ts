/**
 * Main-thread hook that mediates the `pi.ui.*` channel.
 *
 * Responsibilities:
 *   - Subscribe to the RPC client's `onExtensionUIRequest` stream.
 *   - Route `notify` through `sonner` (info / warning / error mapping).
 *   - Maintain a per-extension status-chip map that `ChatInput` renders
 *     in its footer. `setStatus(null)` clears the chip.
 *   - Maintain a per-extension chat-header title map; the renderer
 *     picks the most-recently-updated non-null entry.
 *   - Maintain a flat `widgetId → { extensionPath, widget }` map the
 *     transcript renderer iterates over.
 *   - Queue modal dialog requests (`select` / `confirm` / `input` /
 *     `editor`) in FIFO order and expose the head of the queue as
 *     `activeDialog` along with a `respond` callback the renderer
 *     invokes with the user's answer.
 *   - Handle the fire-and-forget `setEditorText` verb by mutating the
 *     open editor dialog's prefill when the `extensionPath` matches.
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
  ExtensionUIEditorPayload,
  ExtensionUIInputPayload,
  ExtensionUINotifyPayload,
  ExtensionUIRequestEvent,
  ExtensionUISelectPayload,
  ExtensionUISetEditorTextPayload,
  ExtensionUISetStatusPayload,
  ExtensionUISetTitlePayload,
  ExtensionUISetWidgetPayload,
  ExtensionWidget,
} from '@/worker-agent';

/**
 * Snapshot of a pending modal dialog. The renderer derives the concrete
 * component (select / confirm / input / editor) from the `kind`
 * discriminator.
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
    }
  | {
      requestId: string;
      extensionPath: string;
      kind: 'editor';
      /** Tracks the current editor buffer so `setEditorText` can mutate it. */
      payload: ExtensionUIEditorPayload;
    };

/** Display-ready widget snapshot surfaced to the transcript renderer. */
export interface ExtensionWidgetSnapshot {
  /** Stable key — `${extensionPath}::${widgetId}` — so duplicate ids across extensions don't collide. */
  slotKey: string;
  widgetId: string;
  extensionPath: string;
  widget: ExtensionWidget;
}

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
   * The chat-header title contributed by the most-recently-updated
   * extension. `null` when no extension has set a title.
   */
  title: string | null;
  /** Extension path that last set the current `title` (for attribution). */
  titleExtensionPath: string | null;
  /**
   * Flat list of live widgets, in insertion order, for the transcript
   * renderer. Order is stable across renders because we derive it from
   * the backing `Map`.
   */
  widgets: ExtensionWidgetSnapshot[];
  /**
   * Reply to the currently-active dialog. `result` is the raw response
   * payload: `{ index }` for `select`, `boolean` for `confirm`,
   * `string | null` for `input`, `string | null` for `editor`. Passing
   * `null` resolves the worker's pending promise with the dialog's
   * `cancelValue`.
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
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [titleOrder, setTitleOrder] = useState<string[]>([]);
  const [widgetMap, setWidgetMap] = useState<Record<string, ExtensionWidgetSnapshot>>({});
  const [widgetOrder, setWidgetOrder] = useState<string[]>([]);

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

  const handleSetTitle = useCallback(
    (extensionPath: string, payload: ExtensionUISetTitlePayload) => {
      if (payload.text === null) {
        setTitles(prev => {
          if (!(extensionPath in prev)) return prev;
          const next = { ...prev };
          delete next[extensionPath];
          return next;
        });
        setTitleOrder(prev => prev.filter(path => path !== extensionPath));
        return;
      }
      setTitles(prev => ({ ...prev, [extensionPath]: payload.text as string }));
      setTitleOrder(prev => {
        const without = prev.filter(path => path !== extensionPath);
        return [...without, extensionPath];
      });
    },
    []
  );

  const handleSetWidget = useCallback(
    (extensionPath: string, payload: ExtensionUISetWidgetPayload) => {
      const slotKey = `${extensionPath}::${payload.widgetId}`;
      if (payload.widget === null) {
        setWidgetMap(prev => {
          if (!(slotKey in prev)) return prev;
          const next = { ...prev };
          delete next[slotKey];
          return next;
        });
        setWidgetOrder(prev => prev.filter(key => key !== slotKey));
        return;
      }
      const widget = payload.widget;
      setWidgetMap(prev => ({
        ...prev,
        [slotKey]: { slotKey, widgetId: payload.widgetId, extensionPath, widget },
      }));
      setWidgetOrder(prev => (prev.includes(slotKey) ? prev : [...prev, slotKey]));
    },
    []
  );

  const handleSetEditorText = useCallback(
    (extensionPath: string, payload: ExtensionUISetEditorTextPayload) => {
      // Only mutate the active editor (head of queue) when the
      // extension paths match — `setEditorText` from another extension
      // is silently ignored. The worker-side controller has the same
      // guard, but re-checking here keeps the UI resilient to
      // mis-delivered events.
      setQueue(prev => {
        const head = prev[0];
        if (!head || head.kind !== 'editor') return prev;
        if (head.extensionPath !== extensionPath) return prev;
        const nextHead: ActiveExtensionDialog = {
          ...head,
          payload: { ...head.payload, prefill: payload.text },
        };
        return [nextHead, ...prev.slice(1)];
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
        case 'setTitle':
          handleSetTitle(event.extensionPath, event.payload as ExtensionUISetTitlePayload);
          return;
        case 'setWidget':
          handleSetWidget(event.extensionPath, event.payload as ExtensionUISetWidgetPayload);
          return;
        case 'setEditorText':
          handleSetEditorText(
            event.extensionPath,
            event.payload as ExtensionUISetEditorTextPayload
          );
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
          return;
        case 'editor':
          setQueue(prev => [
            ...prev,
            {
              requestId: event.requestId,
              extensionPath: event.extensionPath,
              kind: 'editor',
              payload: event.payload as ExtensionUIEditorPayload,
            },
          ]);
      }
    });
    return () => {
      off();
    };
  }, [
    rpcClient,
    handleNotify,
    handleSetStatus,
    handleSetTitle,
    handleSetWidget,
    handleSetEditorText,
  ]);

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
    // kind-specific cancel value (null for select/input/editor, false
    // for confirm). The worker's `request<T>` helper coerces once the
    // response arrives.
    respond(activeDialog.requestId, null);
  }, [activeDialog, respond]);

  const title = useMemo(() => {
    for (let i = titleOrder.length - 1; i >= 0; i--) {
      const path = titleOrder[i];
      const value = titles[path];
      if (typeof value === 'string') return value;
    }
    return null;
  }, [titles, titleOrder]);

  const titleExtensionPath = useMemo(() => {
    for (let i = titleOrder.length - 1; i >= 0; i--) {
      const path = titleOrder[i];
      if (typeof titles[path] === 'string') return path;
    }
    return null;
  }, [titles, titleOrder]);

  const widgets = useMemo(() => {
    const out: ExtensionWidgetSnapshot[] = [];
    for (const key of widgetOrder) {
      const entry = widgetMap[key];
      if (entry) out.push(entry);
    }
    return out;
  }, [widgetMap, widgetOrder]);

  return useMemo(
    () => ({
      activeDialog,
      statusChips,
      title,
      titleExtensionPath,
      widgets,
      respond,
      dismissActive,
    }),
    [activeDialog, statusChips, title, titleExtensionPath, widgets, respond, dismissActive]
  );
}

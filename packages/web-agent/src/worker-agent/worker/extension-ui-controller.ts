/**
 * Worker-side controller for the `pi.ui.*` channel.
 *
 * Extensions call `ctx.ui.notify` / `setStatus` / `select` / `confirm` /
 * `input` → this controller marshals the call into an
 * `extension_ui_request` RPC event, stores a pending entry keyed by
 * `requestId`, and resolves the returned promise when the main thread
 * replies with `extension_ui_response`.
 *
 * The controller owns the per-request lifecycle:
 *   - `opts.signal` aborts → resolve with the cancellation sentinel.
 *   - `opts.timeout` fires → same cancellation path.
 *   - `cancelAllForSession()` (session reset / vault unmount / agent
 *     abort) → reject everything in-flight so extensions see a clean
 *     failure instead of a ghost promise.
 *
 * Runner / host stay pure — the controller is the only stateful piece
 * holding the in-flight map.
 */

import type {
  ExtensionSelectOption,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUINotifyType,
} from '../core/extensions/types';
import type {
  ExtensionUIRequestEvent,
  ExtensionUIRequestKind,
  ExtensionUIRequestPayload,
  ExtensionUIResponseCommand,
  RpcEventEnvelope,
} from '../rpc/rpc-types';

/** Dispatch for RPC events produced by the controller. */
export type ExtensionUIEventEmitter = (event: RpcEventEnvelope) => void;

interface PendingRequest {
  requestId: string;
  extensionPath: string;
  kind: ExtensionUIRequestKind;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Fallback value returned when dialog is cancelled/aborted/timed out. */
  cancelValue: unknown;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}

export interface ExtensionUIControllerOptions {
  emitEvent: ExtensionUIEventEmitter;
  /** Override the id factory for deterministic tests. */
  idFactory?: () => string;
}

export class ExtensionUIController {
  private readonly emit: ExtensionUIEventEmitter;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly idFactory: () => string;
  private idCounter = 0;

  constructor(options: ExtensionUIControllerOptions) {
    this.emit = options.emitEvent;
    this.idFactory = options.idFactory ?? (() => `ext-ui-${++this.idCounter}`);
  }

  /**
   * Produce an `ExtensionUIContext` bound to a specific extension path.
   * The loader hands this to the extension's factory so `pi.ui.*` calls
   * at both factory-time and handler-time route through the same
   * controller.
   */
  createContextFor(extensionPath: string): ExtensionUIContext {
    return {
      notify: (message, type) => this.notify(extensionPath, message, type),
      setStatus: text => this.setStatus(extensionPath, text),
      select: (title, options, opts) => this.select(extensionPath, title, options, opts),
      confirm: (title, message, opts) => this.confirm(extensionPath, title, message, opts),
      input: (title, placeholder, opts) => this.input(extensionPath, title, placeholder, opts),
    };
  }

  // --------------------------------------------------------------------------
  // Fire-and-forget side effects (no response)
  // --------------------------------------------------------------------------

  notify(extensionPath: string, message: string, type: ExtensionUINotifyType = 'info'): void {
    const requestId = this.idFactory();
    this.emitRequest({
      type: 'extension_ui_request',
      requestId,
      extensionPath,
      kind: 'notify',
      payload: { message, notifyType: type },
    });
  }

  setStatus(extensionPath: string, text?: string): void {
    const requestId = this.idFactory();
    this.emitRequest({
      type: 'extension_ui_request',
      requestId,
      extensionPath,
      kind: 'setStatus',
      payload: { text: text ?? null },
    });
  }

  // --------------------------------------------------------------------------
  // Request/response side effects (awaited promises)
  // --------------------------------------------------------------------------

  async select<T>(
    extensionPath: string,
    title: string,
    options: ExtensionSelectOption<T>[],
    opts?: ExtensionUIDialogOptions
  ): Promise<T | undefined> {
    // Serialise option values by index so the worker round-trip is
    // structured-clone-safe even when the extension passes object
    // payloads (e.g. `{ id, label }`). The main thread returns the
    // index it picked; we rehydrate back to the original value.
    const wireOptions = options.map((o, idx) => ({ label: o.label, index: idx }));
    const result = await this.request<{ index: number } | null>({
      extensionPath,
      kind: 'select',
      payload: { title, options: wireOptions },
      opts,
      cancelValue: null,
    });
    if (!result) return undefined;
    return options[result.index]?.value;
  }

  async confirm(
    extensionPath: string,
    title: string,
    message: string,
    opts?: ExtensionUIDialogOptions
  ): Promise<boolean> {
    const result = await this.request<boolean>({
      extensionPath,
      kind: 'confirm',
      payload: { title, message },
      opts,
      cancelValue: false,
    });
    return result === true;
  }

  async input(
    extensionPath: string,
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions
  ): Promise<string | undefined> {
    const result = await this.request<string | null>({
      extensionPath,
      kind: 'input',
      payload: { title, placeholder: placeholder ?? null },
      opts,
      cancelValue: null,
    });
    return result === null || result === undefined ? undefined : result;
  }

  // --------------------------------------------------------------------------
  // Response / cancellation plumbing
  // --------------------------------------------------------------------------

  /**
   * Apply a main-thread reply. Silently drops responses for unknown
   * request ids (likely late replies after a session reset).
   */
  handleResponse(response: ExtensionUIResponseCommand): void {
    const entry = this.pending.get(response.requestId);
    if (!entry) {
      console.warn(
        `[ExtensionUIController] response for unknown requestId=${response.requestId}; dropping`
      );
      return;
    }
    this.pending.delete(response.requestId);
    entry.cleanup?.();
    if (response.error) {
      entry.reject(new Error(response.error));
      return;
    }
    entry.resolve(response.result);
  }

  /**
   * Fail every in-flight request with the supplied reason. Invoked from
   * `session reset / unmount / agent abort` and on disposal.
   */
  cancelAllForSession(reason = 'session reset'): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.cleanup?.();
      entry.resolve(entry.cancelValue);
    }
    // Informational log to aid debugging when extensions see early resolutions.
    console.info(`[ExtensionUIController] cancelled ${entries.length} request(s): ${reason}`);
  }

  /** Test hook — exposes the in-flight count without leaking the map. */
  pendingCount(): number {
    return this.pending.size;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async request<T>(input: {
    extensionPath: string;
    kind: ExtensionUIRequestKind;
    payload: ExtensionUIRequestPayload;
    opts?: ExtensionUIDialogOptions;
    cancelValue: T;
  }): Promise<T> {
    const requestId = this.idFactory();
    const { opts } = input;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        requestId,
        extensionPath: input.extensionPath,
        kind: input.kind,
        resolve: v => resolve(v as T),
        reject,
        cancelValue: input.cancelValue,
      };

      const cleanup = () => {
        if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
        if (opts?.signal) opts.signal.removeEventListener('abort', onAbort);
      };
      const finishCancel = () => {
        if (!this.pending.has(requestId)) return;
        this.pending.delete(requestId);
        cleanup();
        resolve(input.cancelValue);
      };
      const onAbort = () => finishCancel();

      if (opts?.signal?.aborted) {
        // Already-aborted signals never fire their `abort` event; bail
        // synchronously before registering the listener.
        resolve(input.cancelValue);
        return;
      }
      if (opts?.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      if (typeof opts?.timeout === 'number' && opts.timeout > 0) {
        entry.timeoutHandle = setTimeout(finishCancel, opts.timeout);
      }
      entry.cleanup = cleanup;

      this.pending.set(requestId, entry);
      this.emitRequest({
        type: 'extension_ui_request',
        requestId,
        extensionPath: input.extensionPath,
        kind: input.kind,
        payload: input.payload,
      });
    });
  }

  private emitRequest(event: ExtensionUIRequestEvent): void {
    try {
      this.emit(event);
    } catch (err) {
      console.error('[ExtensionUIController] emitEvent threw:', err);
    }
  }
}

import { describe, expect, test, vi } from 'vitest';
import { ExtensionUIController } from './extension-ui-controller';
import type { ExtensionUIRequestEvent, RpcEventEnvelope } from '../rpc/rpc-types';

function makeController() {
  const events: ExtensionUIRequestEvent[] = [];
  const controller = new ExtensionUIController({
    emitEvent: (e: RpcEventEnvelope) => {
      if (e.type === 'extension_ui_request') events.push(e);
    },
    idFactory: (() => {
      let n = 0;
      return () => `req-${++n}`;
    })(),
  });
  return { controller, events };
}

describe('ExtensionUIController', () => {
  test('notify emits a fire-and-forget request event', () => {
    const { controller, events } = makeController();
    controller.notify('/ext/a', 'hello');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'extension_ui_request',
      kind: 'notify',
      extensionPath: '/ext/a',
      payload: { message: 'hello', notifyType: 'info' },
    });
    expect(controller.pendingCount()).toBe(0);
  });

  test('setStatus clears with undefined', () => {
    const { controller, events } = makeController();
    controller.setStatus('/ext/a', 'working');
    controller.setStatus('/ext/a');
    expect(events.map(e => (e.payload as { text: string | null }).text)).toEqual(['working', null]);
  });

  test('select resolves with the option picked by index', async () => {
    const { controller, events } = makeController();
    const promise = controller.select('/ext/a', 'Pick', [
      { label: 'A', value: 'alpha' },
      { label: 'B', value: 'beta' },
    ]);
    expect(events).toHaveLength(1);
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[0]!.requestId,
      result: { index: 1 },
    });
    await expect(promise).resolves.toBe('beta');
    expect(controller.pendingCount()).toBe(0);
  });

  test('select resolves with undefined on null result (cancel)', async () => {
    const { controller, events } = makeController();
    const promise = controller.select('/ext/a', 'Pick', [{ label: 'A', value: 'alpha' }]);
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[0]!.requestId,
      result: null,
    });
    await expect(promise).resolves.toBeUndefined();
  });

  test('confirm resolves to boolean; false on abort signal', async () => {
    const { controller, events } = makeController();
    const ac = new AbortController();
    const promise = controller.confirm('/ext/a', 'T', 'M', { signal: ac.signal });
    expect(events).toHaveLength(1);
    ac.abort();
    await expect(promise).resolves.toBe(false);
    expect(controller.pendingCount()).toBe(0);
  });

  test('confirm with already-aborted signal resolves synchronously without emitting', async () => {
    const { controller, events } = makeController();
    const ac = new AbortController();
    ac.abort();
    await expect(controller.confirm('/ext/a', 'T', 'M', { signal: ac.signal })).resolves.toBe(
      false
    );
    expect(events).toHaveLength(0);
  });

  test('input times out and resolves with undefined', async () => {
    vi.useFakeTimers();
    try {
      const { controller, events } = makeController();
      const promise = controller.input('/ext/a', 'Name', 'alice', { timeout: 1000 });
      expect(events).toHaveLength(1);
      vi.advanceTimersByTime(1500);
      await expect(promise).resolves.toBeUndefined();
      expect(controller.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('input resolves with the string supplied by the main thread', async () => {
    const { controller, events } = makeController();
    const promise = controller.input('/ext/a', 'Name');
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[0]!.requestId,
      result: 'alice',
    });
    await expect(promise).resolves.toBe('alice');
  });

  test('cancelAllForSession resolves all pending with their cancel values', async () => {
    const { controller, events } = makeController();
    const p1 = controller.confirm('/ext/a', 'T', 'M');
    const p2 = controller.input('/ext/a', 'Name');
    const p3 = controller.select('/ext/a', 'Pick', [{ label: 'A', value: 'alpha' }]);
    expect(events).toHaveLength(3);
    expect(controller.pendingCount()).toBe(3);
    controller.cancelAllForSession('test');
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBeUndefined();
    await expect(p3).resolves.toBeUndefined();
    expect(controller.pendingCount()).toBe(0);
  });

  test('handleResponse for unknown id is dropped with warning', () => {
    const { controller } = makeController();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: 'never-existed',
      result: 'x',
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('handleResponse.error rejects the pending promise', async () => {
    const { controller, events } = makeController();
    const promise = controller.confirm('/ext/a', 'T', 'M');
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[0]!.requestId,
      error: 'nope',
    });
    await expect(promise).rejects.toThrow('nope');
  });

  test('createContextFor exposes all UI methods bound to the extension path', () => {
    const { controller, events } = makeController();
    const ui = controller.createContextFor('/ext/bound');
    ui.notify('hi', 'warning');
    ui.setStatus('working');
    expect(events[0]).toMatchObject({ extensionPath: '/ext/bound', kind: 'notify' });
    expect(events[0]!.payload).toMatchObject({ notifyType: 'warning' });
    expect(events[1]).toMatchObject({ extensionPath: '/ext/bound', kind: 'setStatus' });
  });

  // --------------------------------------------------------------------------
  // Phase 2b verbs
  // --------------------------------------------------------------------------

  test('setTitle emits fire-and-forget setTitle without pending promise', () => {
    const { controller, events } = makeController();
    controller.setTitle('/ext/a', 'hello');
    controller.setTitle('/ext/a', null);
    expect(events.map(e => e.kind)).toEqual(['setTitle', 'setTitle']);
    expect((events[0]!.payload as { text: string | null }).text).toBe('hello');
    expect((events[1]!.payload as { text: string | null }).text).toBeNull();
    expect(controller.pendingCount()).toBe(0);
  });

  test('setWidget emits fire-and-forget setWidget with the widget payload', () => {
    const { controller, events } = makeController();
    controller.setWidget('/ext/a', 'w1', { kind: 'info', props: { message: 'hi' } });
    controller.setWidget('/ext/a', 'w1', null);
    expect(events.map(e => e.kind)).toEqual(['setWidget', 'setWidget']);
    const first = events[0]!.payload as { widgetId: string; widget: { kind: string } | null };
    const second = events[1]!.payload as { widget: unknown };
    expect(first.widgetId).toBe('w1');
    expect(first.widget!.kind).toBe('info');
    expect(second.widget).toBeNull();
    expect(controller.pendingCount()).toBe(0);
  });

  test('setEditorText is fire-and-forget and emits regardless of editor open state', () => {
    const { controller, events } = makeController();
    controller.setEditorText('/ext/a', 'new content');
    expect(events.map(e => e.kind)).toEqual(['setEditorText']);
    expect((events[0]!.payload as { text: string }).text).toBe('new content');
    expect(controller.pendingCount()).toBe(0);
  });

  test('editor joins the pending queue and resolves with the submitted string', async () => {
    const { controller, events } = makeController();
    const promise = controller.editor('/ext/a', 'Edit', 'before', { language: 'markdown' });
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('editor');
    expect(controller.pendingCount()).toBe(1);
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[0]!.requestId,
      result: 'after',
    });
    await expect(promise).resolves.toBe('after');
    expect(controller.pendingCount()).toBe(0);
  });

  test('editor resolves with undefined on null cancel result', async () => {
    const { controller, events } = makeController();
    const promise = controller.editor('/ext/a', 'Edit');
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[0]!.requestId,
      result: null,
    });
    await expect(promise).resolves.toBeUndefined();
  });

  test('editor resolves with undefined when cancelAllForSession tears down pending requests', async () => {
    const { controller, events } = makeController();
    const promise = controller.editor('/ext/a', 'Edit', 'prefill');
    expect(events).toHaveLength(1);
    controller.cancelAllForSession('session reset');
    await expect(promise).resolves.toBeUndefined();
    expect(controller.pendingCount()).toBe(0);
  });

  test('createContextFor exposes setTitle/setWidget/editor/setEditorText bound to the path', async () => {
    const { controller, events } = makeController();
    const ui = controller.createContextFor('/ext/bound');
    ui.setTitle('T');
    ui.setWidget('w1', { kind: 'progress', props: { ratio: 0.5 } });
    ui.setEditorText('X');
    const editorPromise = ui.editor('Edit', 'pre', { language: 'markdown' });
    expect(events.map(e => e.kind)).toEqual(['setTitle', 'setWidget', 'setEditorText', 'editor']);
    for (const ev of events) {
      expect(ev.extensionPath).toBe('/ext/bound');
    }
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[3]!.requestId,
      result: 'post',
    });
    await expect(editorPromise).resolves.toBe('post');
  });

  test('concurrent requests get distinct ids', async () => {
    const { controller, events } = makeController();
    const p1 = controller.confirm('/ext/a', 'T1', 'M1');
    const p2 = controller.confirm('/ext/b', 'T2', 'M2');
    expect(events[0]!.requestId).not.toBe(events[1]!.requestId);
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[0]!.requestId,
      result: true,
    });
    controller.handleResponse({
      type: 'extension_ui_response',
      requestId: events[1]!.requestId,
      result: false,
    });
    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(false);
  });
});

import '@testing-library/jest-dom';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// jsdom doesn't implement Web Workers; `useAcp` spawns one at mount.
// Component-level tests ("renders without crashing") only need the
// constructor not to throw — we never exercise the ACP round-trip in
// vitest. Integration coverage of the worker lives in the Playwright
// e2e suite.
class NoopWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  dispatchEvent(): boolean {
    return true;
  }
}
if (typeof (globalThis as { Worker?: unknown }).Worker === 'undefined') {
  (globalThis as { Worker: typeof NoopWorker }).Worker = NoopWorker;
}

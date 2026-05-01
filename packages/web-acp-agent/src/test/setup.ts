/**
 * Vitest setup for the agent package's unit suite. Runs in `jsdom`
 * (so the bash tool's `just-bash/browser` import resolves) but the
 * agent itself never touches the DOM. Worker globals are shimmed
 * because some upstream deps probe for them at module load.
 */
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
if (typeof (globalThis as { Worker?: unknown }).Worker === "undefined") {
	(globalThis as { Worker: typeof NoopWorker }).Worker = NoopWorker;
}

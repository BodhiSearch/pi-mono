import type { LlmProvider } from '../agent/bodhi-provider';
import type { VolumeInit } from '../agent/volume-registry';
import type { PreferenceStore } from '../storage/preference-store';
import type { SessionStore } from '../storage/session-store';

export interface AcpTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface StartAgentOptions {
  transport: AcpTransport;
  provider: LlmProvider;
  /** Volumes mounted before the agent starts handling ACP requests. */
  volumes?: VolumeInit[];
  /** Per-session transcript store. Defaults to an in-memory implementation. */
  sessions?: SessionStore;
  /** Per-session preferences (feature toggles, MCP toggles). Defaults to in-memory. */
  preferences?: PreferenceStore;
  buildVersion?: string;
}

export interface StartAgentHandle {
  dispose(): Promise<void>;
  /** Mount a volume after boot. Same shape as `StartAgentOptions.volumes`. */
  mount(init: VolumeInit): Promise<void>;
  /** Unmount a volume by mountName. */
  unmount(mountName: string): Promise<void>;
}

export interface InMemoryDuplex {
  agent: AcpTransport;
  client: AcpTransport;
}

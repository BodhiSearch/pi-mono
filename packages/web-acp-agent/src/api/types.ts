import type { LlmProvider } from '../agent/bodhi-provider';
import type { VolumeRegistry } from '../agent/volume-registry';
import type { PreferenceStore } from '../storage/preference-store';
import type { SessionStore } from '../storage/session-store';

export interface AcpTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface StartAgentOptions {
  transport: AcpTransport;
  provider: LlmProvider;
  /** Host-owned mount surface. See `volumes.md`. */
  registry: VolumeRegistry;
  /** Defaults to in-memory. */
  sessions?: SessionStore;
  /** Defaults to in-memory. */
  preferences?: PreferenceStore;
  buildVersion?: string;
}

export interface StartAgentHandle {
  dispose(): Promise<void>;
}

export interface InMemoryDuplex {
  agent: AcpTransport;
  client: AcpTransport;
}

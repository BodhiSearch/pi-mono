import type { LlmProvider } from '../agent/bodhi-provider';
import type { ExtensionRegistry, ExtensionsWriteFs } from '../agent/extensions';
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
  /**
   * Vault-sourced extension subsystem. Hosts construct
   * `new ExtensionRegistry()`, call `loadAll(...)` against the
   * mounted volumes, and pass it in. Omit to disable extensions.
   * See `extensions.md`.
   */
  extensions?: ExtensionRegistry;
  /**
   * Writable counterpart to the extension loader's read-only fs.
   * Required for `_bodhi/extensions/add` to land tarball contents
   * inside the volume tagged `agent-wd`. Omit on hosts that don't
   * support installing extensions at runtime.
   */
  extensionsWriteFs?: ExtensionsWriteFs;
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

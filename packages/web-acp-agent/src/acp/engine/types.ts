import type { McpServerHttp } from '@agentclientprotocol/sdk';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { LlmProvider } from '../../agent/bodhi-provider';
import type { InlineAgent } from '../../agent/inline-agent';
import type { McpConnectionPool } from '../../agent/mcp';
import type { VolumeRegistry } from '../../agent/volume-registry';
import type { FeatureSnapshot } from '../../storage/feature-defaults';
import type { McpToggleSnapshot } from '../../storage/mcp-toggle-shape';
import type { PreferenceStore } from '../../storage/preference-store';
import type { SessionStore } from '../../storage/session-store';
import type { BodhiMcpInstanceDescriptor } from '../../wire';

export interface SessionState {
  id: string;
  mcpServers: McpServerHttp[];
  /** URLs the user has asked Bodhi to approve; drives `/mcp` Pending rendering. */
  requestedMcpUrls: string[];
  /** Bodhi metadata for approved instances; carries `name` for the `/mcp` slug fallback. */
  mcpInstances: BodhiMcpInstanceDescriptor[];
  currentModelId: string | null;
}

// Narrow facade so handler files don't depend on the adapter class.
export interface ExtMethodHost {
  readonly bodhi: LlmProvider;
  readonly store: SessionStore | undefined;
  readonly registry: VolumeRegistry | undefined;
  readonly preferences: PreferenceStore | undefined;
  readonly mcpPool: McpConnectionPool;
  readonly inline: InlineAgent;
  readonly sessions: Map<string, SessionState>;
  getModels(): Model<Api>[];
  setModels(models: Model<Api>[]): void;
  getActiveInlineSessionId(): string | null;
  setActiveInlineSessionId(id: string | null): void;
  readFeatures(sessionId: string): Promise<FeatureSnapshot>;
  readMcpToggles(sessionId: string): Promise<McpToggleSnapshot>;
  // `persistRow: false` deletes the persisted row; default keeps it.
  tearDownSession(
    sessionId: string,
    opts?: {
      persistRow?: boolean;
      abortPromptIfActive?: (sessionId: string) => void;
    }
  ): Promise<void>;
  // Driver is single-instance; guard against aborting other sessions.
  abortPromptIfActive(sessionId: string): void;
}

import type { Api, Model } from '@mariozechner/pi-ai';
import type { PromptTurnDriver } from '../engine/prompt-driver';
import type { AcpAdapterServices } from '../engine/services';
import type { AcpSessionRuntime } from '../engine/session-runtime';

export interface AcpAdapterContext {
  readonly services: AcpAdapterServices;
  readonly runtime: AcpSessionRuntime;
  readonly driver: PromptTurnDriver;
  readonly buildVersion: string;
}

// Returns [] on failure so session creation still succeeds before authenticate runs.
export async function tryEnsureModels(ctx: AcpAdapterContext): Promise<Model<Api>[]> {
  try {
    return await ctx.runtime.ensureModelsLoaded();
  } catch (err) {
    console.error('[acp-agent-adapter] failed to load model catalog:', err);
    return [];
  }
}

// Returns undefined for an empty catalog — SDK schema requires >=1 entry when present.
export function buildModelState(
  models: Model<Api>[],
  currentModelId: string | null
):
  | { availableModels: Array<{ modelId: string; name: string }>; currentModelId: string }
  | undefined {
  if (models.length === 0) return undefined;
  return {
    availableModels: models.map(m => ({ modelId: m.id, name: m.id })),
    currentModelId: currentModelId ?? models[0].id,
  };
}

export function resolveSeededModelId(
  models: Model<Api>[],
  lastModelId: string | null
): string | null {
  if (lastModelId && models.some(m => m.id === lastModelId)) return lastModelId;
  return models[0]?.id ?? null;
}

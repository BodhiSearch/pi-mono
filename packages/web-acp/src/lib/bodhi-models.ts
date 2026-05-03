/**
 * Lightweight host-side model descriptor. Sourced from
 * `SessionModelState.availableModels` on `NewSessionResponse` /
 * `LoadSessionResponse`. Display-only — the agent resolves the
 * concrete model + provider from `currentModelId` at prompt time.
 */
export interface BodhiModelInfo {
  id: string;
}

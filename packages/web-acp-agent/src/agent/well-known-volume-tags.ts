/**
 * Tag vocabulary the agent runtime itself reaches for. Hosts and
 * extensions should reference these constants instead of literal
 * strings so renames are a single compile step. Free-form tags are
 * still allowed everywhere `VolumeInit.tags` is accepted.
 */
export const WELL_KNOWN_VOLUME_TAGS = {
  /** Target for `/extension add` unpacks (M6 phase 13). At most one volume. */
  AGENT_WD: 'agent-wd',
  /** Default cwd for the bash tool when no explicit override applies. */
  CWD: 'cwd',
  /** Read-only user data (skill manifests, prompt-template libraries). */
  DATA: 'data',
} as const;

export type WellKnownVolumeTag =
  (typeof WELL_KNOWN_VOLUME_TAGS)[keyof typeof WELL_KNOWN_VOLUME_TAGS];

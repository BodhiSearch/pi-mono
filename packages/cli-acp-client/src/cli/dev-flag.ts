/**
 * `CLI_ACP_DEV` env var resolution.
 *
 * The DEV flag gates a small set of agent-side behaviours
 * (`forceToolCall`, etc.) that are visible but inert outside DEV
 * builds. We default to `true` so a local `cli-acp` from a clone is
 * fully featured; explicit opt-outs (`0|false|no|off`,
 * case-insensitive) are the only paths to `false`. Empty strings
 * resolve to `false` so `CLI_ACP_DEV=` (set but empty) is treated as
 * an opt-out — that matches how shell users tend to "blank" a var.
 */

export function resolveIsDev(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const normalised = raw.trim().toLowerCase();
  if (
    normalised === '' ||
    normalised === '0' ||
    normalised === 'false' ||
    normalised === 'no' ||
    normalised === 'off'
  ) {
    return false;
  }
  return true;
}

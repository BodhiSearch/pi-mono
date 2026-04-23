/**
 * Compose the worker-owned system prompt from the current volume
 * registry snapshot. Called before every `prompt()` turn so the LLM
 * always sees the freshest list of mounts.
 *
 * The prompt stays empty when no volumes are mounted — we don't want
 * to hallucinate a `/mnt` filesystem for the LLM when the user hasn't
 * given us one.
 */
import type { VolumeSnapshot } from './volume-mount';

export function composeSystemPrompt(volumes: VolumeSnapshot[]): string {
  if (volumes.length === 0) return '';
  const lines: string[] = [];
  lines.push('You have access to the following volumes:');
  for (const volume of volumes) {
    const path = `/mnt/${volume.mountName}`;
    lines.push(volume.description ? `- ${path} — ${volume.description}` : `- ${path}`);
  }
  lines.push('Use the bash tool to explore them.');
  return lines.join('\n');
}

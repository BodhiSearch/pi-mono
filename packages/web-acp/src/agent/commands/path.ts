/**
 * Canonical command name derivation.
 *
 * Rule (matches Claude Code's `<plugin>:<skill>` namespacing applied
 * to mounted volumes): a command file at
 * `<mount>/.pi/commands/<a>/<b>/<name>.md` advertises as
 * `<mount>:<a>:<b>:<name>`. Each segment must match `[a-z][a-z0-9-]*`;
 * non-conforming files / directories are rejected by the loader.
 */

export const COMMANDS_DIR_RELPATH = '.pi/commands';

const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface CanonicalNameInput {
  mountName: string;
  /** Path relative to `<mount>/.pi/commands/`, e.g. `review/api.md`. */
  pathBelowCommands: string;
}

export function canonicalCommandName(input: CanonicalNameInput): string {
  if (!SEGMENT_PATTERN.test(input.mountName)) {
    throw new InvalidCommandPathError(`mount name '${input.mountName}' is not a valid segment`);
  }
  const parts = splitRelativePath(input.pathBelowCommands);
  if (parts.length === 0) {
    throw new InvalidCommandPathError('path below commands/ is empty');
  }
  const last = parts[parts.length - 1];
  if (!last.endsWith('.md')) {
    throw new InvalidCommandPathError(`command file '${last}' must end with .md`);
  }
  const stem = last.slice(0, -3);
  const segments = [...parts.slice(0, -1), stem];
  for (const seg of segments) {
    if (!SEGMENT_PATTERN.test(seg)) {
      throw new InvalidCommandPathError(`segment '${seg}' must match ${SEGMENT_PATTERN}`);
    }
  }
  return [input.mountName, ...segments].join(':');
}

export function isValidSegment(segment: string): boolean {
  return SEGMENT_PATTERN.test(segment);
}

function splitRelativePath(rel: string): string[] {
  const trimmed = rel.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return [];
  return trimmed.split('/').filter(part => part.length > 0);
}

export class InvalidCommandPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommandPathError';
  }
}

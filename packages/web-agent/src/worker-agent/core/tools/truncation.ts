/**
 * Truncation helper for tools that emit line-oriented output.
 *
 * Pattern trimmed from `packages/coding-agent/src/core/tools/truncate.ts`.
 * Dual-limit (lines + bytes); whichever limit is hit first stops output.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 100 * 1024;

export interface TruncationResult {
  /** The (possibly truncated) content. */
  content: string;
  /** Number of lines present in `content`. */
  outputLines: number;
  /** Total lines in the original input. */
  totalLines: number;
  /** Was the output truncated? */
  truncated: boolean;
  /** Which limit caused truncation. `null` when `truncated` is false. */
  truncatedBy: 'lines' | 'bytes' | null;
  /** True when the first line alone exceeded the byte budget. */
  firstLineExceedsLimit: boolean;
  /** Effective line limit applied. */
  maxLines: number;
  /** Effective byte limit applied. */
  maxBytes: number;
}

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

export function truncateHead(input: string, options: TruncateOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const encoder = new TextEncoder();

  const lines = input.split('\n');
  const totalLines = lines.length;

  // Check first-line-exceeds-limit edge case up front.
  if (lines.length > 0 && encoder.encode(lines[0]).length > maxBytes) {
    return {
      content: '',
      outputLines: 0,
      totalLines,
      truncated: true,
      truncatedBy: 'bytes',
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const selected: string[] = [];
  let byteLen = 0;
  let truncatedBy: 'lines' | 'bytes' | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (selected.length >= maxLines) {
      truncatedBy = 'lines';
      break;
    }
    const line = lines[i];
    // +1 for the newline that joins lines back together.
    const addition = encoder.encode(line).length + (selected.length > 0 ? 1 : 0);
    if (byteLen + addition > maxBytes) {
      truncatedBy = 'bytes';
      break;
    }
    selected.push(line);
    byteLen += addition;
  }

  const truncated = truncatedBy !== null;
  return {
    content: selected.join('\n'),
    outputLines: selected.length,
    totalLines,
    truncated,
    truncatedBy,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

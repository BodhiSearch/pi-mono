/** File-operation tracking: extract read/write/edit paths from tool calls. */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export function createFileOps(): FileOperations {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

/** Extract vault-tool path arguments from an assistant message's tool calls. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== 'assistant') return;
  const content = (message as AssistantMessage).content;
  for (const block of content) {
    if (block.type !== 'toolCall') continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    const path = args && typeof args.path === 'string' ? args.path : undefined;
    if (!path) continue;
    switch (block.name) {
      case 'read':
        fileOps.read.add(path);
        break;
      case 'write':
        fileOps.written.add(path);
        break;
      case 'edit':
        fileOps.edited.add(path);
        break;
    }
  }
}

/** Collapse the three sets into final read-only + modified lists. */
export function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter(f => !modified.has(f)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

/** Append `<read-files>` / `<modified-files>` sections to the summary body. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join('\n')}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>`);
  }
  if (sections.length === 0) return '';
  return `\n\n${sections.join('\n\n')}`;
}

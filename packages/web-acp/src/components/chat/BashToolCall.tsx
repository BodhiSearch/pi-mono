import type { ToolCallView } from '@/hooks/useAcp';

export interface BashToolCallProps {
  call: ToolCallView;
}

/**
 * Minimal renderer for the `bash` tool call. The title already
 * captures the first line of the script; we surface the status and a
 * truncated stdout/stderr preview. Anything richer is out of scope for
 * M2 — richer rendering is deferred to the coding-agent surface.
 */
export default function BashToolCall({ call }: BashToolCallProps) {
  const input = call.rawInput as { script?: string } | undefined;
  const output = call.rawOutput as
    | { stdout?: string; stderr?: string; exitCode?: number; truncated?: boolean }
    | undefined;

  return (
    <div
      data-testid={`tool-call-${call.toolCallId}`}
      data-test-state={call.status}
      data-toolname={call.toolName}
      className="my-2 rounded-md border border-gray-300 bg-white text-xs"
    >
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-2 py-1">
        <span className="font-mono text-[11px] text-gray-600 truncate">{call.title}</span>
        <span
          data-testid={`tool-call-status-${call.toolCallId}`}
          className={statusClass(call.status)}
        >
          {call.status}
        </span>
      </div>
      {input?.script && (
        <pre
          data-testid={`tool-call-script-${call.toolCallId}`}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11px] text-gray-700"
        >
          {input.script}
        </pre>
      )}
      {output && (
        <div className="border-t border-gray-200 p-2 font-mono text-[11px] text-gray-700">
          {typeof output.exitCode === 'number' && (
            <div data-testid={`tool-call-exit-${call.toolCallId}`} className="text-gray-500">
              exit: {output.exitCode}
              {output.truncated ? ' · truncated' : ''}
            </div>
          )}
          {output.stdout ? (
            <pre className="mt-1 whitespace-pre-wrap break-all text-green-700">{output.stdout}</pre>
          ) : null}
          {output.stderr ? (
            <pre className="mt-1 whitespace-pre-wrap break-all text-red-700">{output.stderr}</pre>
          ) : null}
        </div>
      )}
    </div>
  );
}

function statusClass(status: ToolCallView['status']): string {
  switch (status) {
    case 'completed':
      return 'text-green-600';
    case 'failed':
      return 'text-red-600';
    case 'in_progress':
      return 'text-blue-600 animate-pulse';
    default:
      return 'text-gray-500';
  }
}

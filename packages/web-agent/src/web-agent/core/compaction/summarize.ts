/**
 * LLM summarization: turns a `CompactionPreparation` into a `CompactionResult`.
 * Auth is Bearer header injected on the model; `apiKey` is a placeholder.
 */

import { completeSimple, type Api, type Model } from '@mariozechner/pi-ai';
import { formatFileOperations } from './file-ops';
import {
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
} from './prompts';
import { serializeConversation } from './serialize';
import type { CompactionPreparation, CompactionResult } from './types';

export interface CompactSummarizeOptions {
  /** Placeholder `apiKey` forwarded to the provider. Real auth is Bearer header. */
  apiKey: string;
  /** Optional Bearer token — merged into model headers before the request. */
  authToken?: string | null;
  signal?: AbortSignal;
}

export async function compactSummarize(
  preparation: CompactionPreparation,
  model: Model<Api>,
  options: CompactSummarizeOptions
): Promise<CompactionResult> {
  const { messagesToSummarize, previousSummary, firstKeptEntryId, tokensBefore } = preparation;

  const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  const conversation = serializeConversation(messagesToSummarize);
  const promptText = previousSummary
    ? `<conversation>\n${conversation}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${basePrompt}`
    : `<conversation>\n${conversation}\n</conversation>\n\n${basePrompt}`;

  const patchedModel = options.authToken
    ? {
        ...model,
        headers: {
          ...model.headers,
          Authorization: `Bearer ${options.authToken}`,
          'x-api-key': options.authToken,
        },
      }
    : model;

  const maxTokens = Math.floor(0.8 * (model.maxTokens ?? 4096));
  const response = await completeSimple(
    patchedModel,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: promptText }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens, signal: options.signal, apiKey: options.apiKey }
  );

  if (response.stopReason === 'error') {
    throw new Error(`Summarization failed: ${response.errorMessage ?? 'unknown error'}`);
  }

  const body = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  const summary = body + formatFileOperations(preparation.readFiles, preparation.modifiedFiles);

  return {
    summary,
    firstKeptEntryId,
    tokensBefore,
    details: {
      readFiles: preparation.readFiles,
      modifiedFiles: preparation.modifiedFiles,
    },
  };
}

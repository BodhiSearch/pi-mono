/**
 * LLM provider abstraction for the worker-agent.
 *
 * The `LlmProvider` interface is the single pluggable surface the worker
 * depends on for LLM access. It covers both sides of the gateway:
 *
 * - **Auth resolution** — `getApiKeyAndHeaders(model)` returns the per-request
 *   `{ apiKey, headers? }` shape. Mirrors coding-agent's
 *   `ModelRegistry.getApiKeyAndHeaders`. Both the live streamFn and the
 *   compaction summariser consume it the same way, so the worker-agent
 *   itself stays provider-agnostic and relies on pi-ai's built-in per-format
 *   auth handling (OpenAI → `Authorization: Bearer`, Anthropic → `x-api-key`,
 *   Gemini → key param).
 * - **Catalog listing** — `getAvailableModels()` returns the `Model<Api>[]`
 *   the worker resolves `(provider, modelId)` identifiers against. The
 *   concrete provider owns the fetch and the mapping; the worker-agent is
 *   oblivious to which upstream it talks to. Mirrors coding-agent's
 *   `ModelRegistry.getAvailable()` contract.
 *
 * The `setAuthToken` rotation sink takes a typed credential envelope so
 * future non-Bodhi providers can coexist without reshaping the RPC layer.
 */

import type { Api, Model } from '@mariozechner/pi-ai';

export interface LlmAuthCredential {
  /**
   * Provider tag identifying which auth namespace owns the credential.
   * Providers ignore credentials whose `provider` doesn't match their own
   * tag, so multiple auth providers can safely share one rotation channel.
   */
  provider: string;
  /** Server root bound to this credential (when relevant). */
  baseUrl?: string;
  /** The rotating secret. `null` clears the credential. */
  token: string | null;
}

export interface LlmProvider {
  /**
   * Resolve auth for a single LLM request.
   *
   * Returns `apiKey` (required by pi-ai's simple-stream path) and
   * optional `headers` to merge into the request. pi-ai's built-in
   * provider implementations already place the `apiKey` into the
   * correct per-format auth header, so most providers leave `headers`
   * unset.
   */
  getApiKeyAndHeaders(
    model: Model<Api>
  ): Promise<{ apiKey: string; headers?: Record<string, string> }>;

  /**
   * Return the authoritative list of models this provider exposes.
   *
   * The worker resolves `(provider, modelId)` identifiers against this
   * list in `setModel` and when restoring a persisted `model_change`
   * entry from a session. Implementations may fetch on every call or
   * cache internally; the worker treats the result as fresh.
   */
  getAvailableModels(): Promise<Model<Api>[]>;

  /**
   * Optional rotation sink for short-lived tokens. Invoked from the
   * `set_auth_token` RPC command. Implementations MUST ignore
   * credentials whose `provider` tag doesn't match their own.
   */
  setAuthToken?(credential: LlmAuthCredential | null): void;
}

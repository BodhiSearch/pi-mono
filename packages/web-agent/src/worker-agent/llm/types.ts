/**
 * LLM auth abstraction for the worker-agent.
 *
 * Mirrors coding-agent's `ModelRegistry.getApiKeyAndHeaders` — one narrow
 * method resolves `{ apiKey, headers }` per request. Both the live
 * streamFn and compaction summariser consume it the same way, so the
 * worker-agent itself stays provider-agnostic and relies on pi-ai's
 * built-in per-format auth handling (OpenAI → `Authorization: Bearer`,
 * Anthropic → `x-api-key`, Gemini → key param).
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

export interface LlmAuthProvider {
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
   * Optional rotation sink for short-lived tokens. Invoked from the
   * `set_auth_token` RPC command. Implementations MUST ignore
   * credentials whose `provider` tag doesn't match their own.
   */
  setAuthToken?(credential: LlmAuthCredential | null): void;
}

/**
 * Bodhi concrete implementation of `LlmAuthProvider`.
 *
 * Bodhi acts as a proxy for OpenAI / Anthropic / Gemini at different
 * base URLs (`/v1`, `/anthropic/v1`, `/v1beta`). The access token
 * obtained after the OAuth 2.1 flow on the main thread can be treated
 * as an ordinary API key — pi-ai's per-format provider code already
 * places it into the correct auth header. So this implementation is
 * intentionally tiny: hold the rotating token, return it as `apiKey`.
 */

import type { Api, Model } from '@mariozechner/pi-ai';
import type { LlmAuthCredential, LlmAuthProvider } from '../worker-agent/llm/types';

export const BODHI_PROVIDER_TAG = 'bodhi';

export class BodhiAuthProvider implements LlmAuthProvider {
  private token: string | null = null;
  private baseUrl: string | undefined;

  setAuthToken(credential: LlmAuthCredential | null): void {
    // A `null` credential or a credential tagged for a different provider
    // clears Bodhi's state. The provider-tag filter keeps future
    // co-resident providers from stepping on each other.
    if (!credential || credential.provider !== BODHI_PROVIDER_TAG) {
      this.token = null;
      this.baseUrl = undefined;
      return;
    }
    this.token = credential.token;
    this.baseUrl = credential.baseUrl;
  }

  async getApiKeyAndHeaders(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _model: Model<Api>
  ): Promise<{ apiKey: string; headers?: Record<string, string> }> {
    return { apiKey: this.token ?? '' };
  }

  /** Test-only inspector — the current server URL associated with the token. */
  getBaseUrl(): string | undefined {
    return this.baseUrl;
  }
}

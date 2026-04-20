import { Page, expect } from '@playwright/test';

export class ChatPage {
  constructor(private page: Page) {}

  selectors = {
    appTitle: '[data-testid="app-title"]',
    loginButton: '[data-testid="btn-auth-login"]',
    authenticated: '[data-testid="section-auth"][data-teststate="authenticated"]',
    clientReady: '[data-testid="badge-client-status"][data-teststate="ready"]',
    serverReady: '[data-testid="badge-server-status"][data-teststate="ready"]',
    setupOverlay: '[data-testid="div-setup-overlay-v2"]',
    setupIframe: '[data-testid="iframe-setup-v2"]',
    chatInput: '[data-testid="chat-input"]',
    sendButton: '[data-testid="send-button"]',
    modelSelector: '[data-testid="model-selector"]',
    modelSearchInput: '[data-testid="model-search-input"]',
    refreshModels: '[data-testid="btn-refresh-models"]',
    chatProcessing: '[data-testid="chat-processing"]',
    compactButton: '[data-testid="chat-compact-button"]',
    compactionSummary: '[data-testid="chat-compaction-summary"]',
    message: (turn: number, role: string) =>
      `[data-testid="chat-message-turn-${turn}"][data-messagetype="${role}"]`,
  };

  async waitServerReady(bodhiServerUrl: string): Promise<void> {
    await this.page.locator(this.selectors.appTitle).waitFor();
    // On cold load the setup overlay renders and the user walks through it.
    // On reload, bodhi-js-react reads the persisted server URL from
    // localStorage and skips the overlay entirely — so we race the iframe's
    // attach against `clientReady` and only walk the modal when the former
    // wins. Either path finishes at the same terminal check below.
    const iframe = this.page.locator(this.selectors.setupIframe);
    const clientReady = this.page.locator(this.selectors.clientReady);
    const winner = await Promise.race([
      iframe.waitFor({ state: 'attached' }).then(() => 'modal' as const),
      clientReady.waitFor().then(() => 'ready' as const),
    ]);
    if (winner === 'modal') {
      await this.walkSetupModal(bodhiServerUrl);
    }
    await clientReady.waitFor();
    await this.page.locator(this.selectors.serverReady).waitFor();
  }

  private async walkSetupModal(bodhiServerUrl: string): Promise<void> {
    const iframe = this.page.frameLocator(this.selectors.setupIframe);

    // Wait for setup screen to render inside the iframe
    await iframe.getByTestId('div-setup-screen').waitFor();

    // Fill server URL and connect
    const urlInput = iframe.getByTestId('input-server-url');
    await urlInput.fill(bodhiServerUrl);
    await iframe.getByTestId('btn-connect').click();

    // Wait for connected status then continue
    await iframe
      .getByTestId('text-probe-status-message')
      .filter({ hasText: 'Server is connected' })
      .waitFor();
    await iframe.getByTestId('btn-continue').click();

    await this.page.locator(this.selectors.setupOverlay).waitFor({ state: 'hidden' });
  }

  async login(credentials: { username: string; password: string }): Promise<void> {
    await this.page.locator(this.selectors.loginButton).click();

    // Bodhi server branded login page → click Login → redirects to Keycloak
    await this.page.waitForURL(/\/ui\/login/);
    await this.page.getByRole('button', { name: 'Login', exact: true }).click();

    // Keycloak login form
    await this.page.waitForURL(/\/realms\/bodhi\//);
    await this.page.locator('#username').waitFor();
    await this.page.fill('#username', credentials.username);
    await this.page.fill('#password', credentials.password);
    await this.page.click('#kc-login');

    // Access request review → uncheck every MCP checkbox so approve isn't
    // gated on MCP instances existing on the server → approve role-only.
    await this.page.waitForURL(/\/access-requests\/review/);
    const approveButton = this.page.getByTestId('review-approve-button');
    await approveButton.waitFor();
    const mcpToggles = this.page.locator('[data-testid^="review-mcp-toggle-"]');
    const count = await mcpToggles.count();
    for (let i = 0; i < count; i++) {
      const toggle = mcpToggles.nth(i);
      if ((await toggle.getAttribute('aria-checked')) === 'true') {
        await toggle.click();
      }
    }
    await expect(approveButton).toBeEnabled();
    await approveButton.click();

    // After approve: Keycloak SSO auto-completes the PKCE flow (same browser
    // context as the login above), redirecting back to the app via 302 chain.
    await this.page.waitForURL(/localhost:25173/);
    await this.page.locator(this.selectors.authenticated).waitFor();
  }

  async loadModels(): Promise<void> {
    await this.page.locator(this.selectors.refreshModels).click();
    await expect(this.page.locator(this.selectors.modelSelector)).toBeEnabled();
  }

  async selectModel(modelId: string): Promise<void> {
    const trigger = this.page.locator(this.selectors.modelSelector);
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await this.page.locator(this.selectors.modelSearchInput).fill(modelId);
    await this.page.getByTestId(`model-option-${modelId}`).click();
    await expect(trigger).toContainText(modelId);
  }

  async send(prompt: string): Promise<void> {
    await this.page.locator(this.selectors.chatInput).fill(prompt);
    await this.page.locator(this.selectors.sendButton).click();
  }

  async waitForAssistantTurn(turn: number): Promise<void> {
    await this.page.locator(this.selectors.message(turn, 'assistant')).waitFor();
    await this.page.locator(this.selectors.chatProcessing).waitFor({ state: 'hidden' });
  }

  async getAssistantText(turn: number): Promise<string> {
    return (await this.page.locator(this.selectors.message(turn, 'assistant')).textContent()) ?? '';
  }

  /** Wait for streaming to start and then finish (turn-agnostic). */
  async waitForStreamingDone(): Promise<void> {
    const processing = this.page.locator(this.selectors.chatProcessing);
    await processing.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    await processing.waitFor({ state: 'hidden' });
  }

  /** Text of the assistant reply that follows the last user message. */
  async lastAssistantText(): Promise<string> {
    const bubbles = this.page.locator('[data-testid^="chat-message-turn-"]');
    const count = await bubbles.count();
    let lastUserIdx = -1;
    for (let i = count - 1; i >= 0; i--) {
      if ((await bubbles.nth(i).getAttribute('data-messagetype')) === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return '';
    for (let i = lastUserIdx + 1; i < count; i++) {
      if ((await bubbles.nth(i).getAttribute('data-messagetype')) === 'assistant') {
        return (await bubbles.nth(i).textContent()) ?? '';
      }
    }
    return '';
  }

  async compactNow(): Promise<void> {
    const btn = this.page.locator(this.selectors.compactButton);
    await btn.click();
    await expect(btn).toHaveAttribute('data-test-state', 'idle', { timeout: 60_000 });
  }

  compactionSummary() {
    return this.page.locator(this.selectors.compactionSummary);
  }

  toolCall(name: string) {
    return this.page.locator(`[data-testid="tool-call"][data-tool="${name}"]`);
  }
}

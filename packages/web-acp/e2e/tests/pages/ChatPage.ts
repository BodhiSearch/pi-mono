import { Page, expect, type Locator } from '@playwright/test';

export class ChatPage {
  /** Pre-built locators used by the new thematic specs. */
  readonly input: Locator;
  readonly sendButton: Locator;
  readonly modelSelector: Locator;
  private readonly stopButton: Locator;
  private readonly chatArea: Locator;

  constructor(private page: Page) {
    this.input = page.locator('[data-testid="chat-input"]');
    this.sendButton = page.locator('[data-testid="send-button"]');
    this.modelSelector = page.locator('[data-testid="model-selector"]');
    this.stopButton = page.locator('[data-testid="btn-stop"]');
    this.chatArea = page.locator('[data-testid="chat-area"]');
  }

  selectors = {
    appTitle: '[data-testid="app-title"]',
    loginButton: '[data-testid="btn-auth-login"]',
    authenticated: '[data-testid="section-auth"][data-test-state="authenticated"]',
    clientReady: '[data-testid="badge-client-status"][data-test-state="ready"]',
    serverReady: '[data-testid="badge-server-status"][data-test-state="ready"]',
    setupOverlay: '[data-testid="div-setup-overlay-v2"]',
    setupIframe: '[data-testid="iframe-setup-v2"]',
    chatInput: '[data-testid="chat-input"]',
    sendButton: '[data-testid="send-button"]',
    modelSelector: '[data-testid="model-selector"]',
    modelSearchInput: '[data-testid="model-search-input"]',
    refreshModels: '[data-testid="btn-refresh-models"]',
    chatProcessing: '[data-testid="chat-processing"]',
    message: (turn: number, role: string) =>
      `[data-testid="chat-message-turn-${turn}"][data-messagetype="${role}"]`,
    sessionPicker: '[data-testid="session-picker"]',
    sessionRow: (id: string) => `[data-testid="session-row-${id}"]`,
    sessionDelete: (id: string) => `[data-testid="session-delete-${id}"]`,
    sessionPickerEmpty: '[data-testid="session-picker-empty"]',
    newChatButton: '[data-testid="btn-new-chat"]',
  };

  async waitServerReady(bodhiServerUrl: string): Promise<void> {
    await this.page.locator(this.selectors.appTitle).waitFor();
    // Setup overlay only appears on first boot or when the stored
    // server URL is unreachable. After a reload (IndexedDB + Bodhi
    // session restored) the badges go ready directly, so gate the
    // walkthrough on the overlay being visible.
    const overlay = this.page.locator(this.selectors.setupOverlay);
    if (await overlay.isVisible().catch(() => false)) {
      await this.walkSetupModal(bodhiServerUrl);
    }
    await this.page.locator(this.selectors.clientReady).waitFor();
    await this.page.locator(this.selectors.serverReady).waitFor();
  }

  private async walkSetupModal(bodhiServerUrl: string): Promise<void> {
    await this.page.locator(this.selectors.setupIframe).waitFor({ state: 'attached' });
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

  async login(
    credentials: { username: string; password: string },
    opts: { acceptMcps?: string[] } = {}
  ): Promise<void> {
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

    // Access request review. BodhiApp keys every MCP the client requests
    // by its upstream URL — the testid shape is
    // `review-mcp-toggle-<url>` for the checkbox and
    // `review-mcp-select-trigger-<url>` for the "Select an MCP
    // instance…" dropdown. The approve button stays disabled until
    // either (a) every requested MCP is unchecked or (b) every checked
    // MCP has an instance bound. `acceptMcps` is the list of upstream
    // URLs we want to leave checked + bound; everything else is
    // unchecked so approve falls back to role-only.
    await this.page.waitForURL(/\/access-requests\/review/);
    const approveButton = this.page.getByTestId('review-approve-button');
    await approveButton.waitFor();
    const accept = new Set(opts.acceptMcps ?? []);
    const mcpToggles = this.page.locator('[data-testid^="review-mcp-toggle-"]');
    const toggleIds: string[] = await mcpToggles.evaluateAll(els =>
      els.map(el => el.getAttribute('data-testid') ?? '')
    );
    for (const testid of toggleIds) {
      const url = testid.replace(/^review-mcp-toggle-/, '');
      const toggle = this.page.locator(`[data-testid="${testid}"]`);
      const currentlyChecked = (await toggle.getAttribute('aria-checked')) === 'true';
      const desired = accept.has(url);
      if (currentlyChecked !== desired) {
        await toggle.click();
      }
      if (desired) {
        // Radix Select renders items into a portal with role="option";
        // clicking the first option selects the only instance the
        // global-setup seeded for this MCP server.
        await this.page.locator(`[data-testid="review-mcp-select-trigger-${url}"]`).click();
        await this.page.locator('[role="option"]').first().click();
      }
    }
    await expect(approveButton).toBeEnabled();
    await approveButton.click();

    // After approve: Keycloak SSO auto-completes the PKCE flow (same browser
    // context as the login above), redirecting back to the app via 302 chain.
    await this.page.waitForURL(/localhost:5173/);
    await this.page.locator(this.selectors.authenticated).waitFor();
  }

  async loadModels(): Promise<void> {
    await this.page.locator(this.selectors.refreshModels).click();
    await expect(this.page.locator(this.selectors.modelSelector)).toBeEnabled();
  }

  async refreshModels(): Promise<void> {
    return this.loadModels();
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
    const input = this.page.locator(this.selectors.chatInput);
    await input.fill(prompt);
    // A bare slash token (e.g. `/copy`) keeps the command picker open,
    // and ChatInput.handleSubmit guards against submitting while the
    // picker has focus. Dismiss it so the click goes through.
    if (/^\/\S*$/.test(prompt)) {
      await input.press('Escape');
    }
    await this.page.locator(this.selectors.sendButton).click();
  }

  async waitForAssistantTurn(turn: number): Promise<void> {
    await this.page.locator(this.selectors.message(turn, 'assistant')).waitFor();
    await this.page.locator(this.selectors.chatProcessing).waitFor({ state: 'hidden' });
  }

  async waitForSessionCount(expected: number, opts: { timeout?: number } = {}): Promise<void> {
    const timeout = opts.timeout ?? 10000;
    await this.page
      .locator(`${this.selectors.sessionPicker}[data-test-state="${expected}"]`)
      .waitFor({ timeout });
  }

  async listSessionIds(): Promise<string[]> {
    return this.page
      .locator(`${this.selectors.sessionPicker} [data-sessionid]`)
      .evaluateAll(els => els.map(el => el.getAttribute('data-sessionid') ?? ''));
  }

  async getSessionTitle(sessionId: string): Promise<string> {
    return (
      (await this.page.locator(this.selectors.sessionRow(sessionId)).textContent())?.trim() ?? ''
    );
  }

  async getSelectedModel(): Promise<string> {
    return (await this.page.locator(this.selectors.modelSelector).textContent())?.trim() ?? '';
  }

  async newChat(): Promise<void> {
    await this.page.locator(this.selectors.newChatButton).click();
  }

  async clickSession(sessionId: string): Promise<void> {
    await this.page.locator(this.selectors.sessionRow(sessionId)).click();
    await this.page
      .locator(`${this.selectors.sessionRow(sessionId)}[data-test-state="active"]`)
      .waitFor();
  }

  async waitForAssistantTurnOnRestoredSession(): Promise<void> {
    // After `session/load`, the transcript is restored in one shot from
    // the `bodhi/getSession` snapshot, so turn indices are recomputed
    // from the full message list. Wait for the first assistant message
    // to be present.
    await this.page.locator(this.selectors.message(0, 'assistant')).waitFor();
  }

  async waitForActiveSession(sessionId: string): Promise<void> {
    await this.page
      .locator(`${this.selectors.sessionRow(sessionId)}[data-test-state="active"]`)
      .waitFor();
  }

  async deleteSession(sessionId: string): Promise<void> {
    // The delete button is hover-revealed (`opacity-0 group-hover:opacity-100`).
    // Playwright's `click()` auto-hovers the target, but the surrounding
    // `<li>` is what carries `group`, so we hover the row first to make
    // the button visible; clicking with `force: true` would skip
    // visibility/actionability checks but we want the real path.
    await this.page.locator(this.selectors.sessionRow(sessionId)).hover();
    await this.page.locator(this.selectors.sessionDelete(sessionId)).click();
  }

  async waitForSessionAbsent(sessionId: string): Promise<void> {
    await this.page.locator(this.selectors.sessionRow(sessionId)).waitFor({ state: 'detached' });
  }

  // ── New thematic-spec helpers ──────────────────────────────────────────────

  async fillRaw(text: string): Promise<void> {
    await this.input.fill(text);
  }

  async waitForStreaming(): Promise<void> {
    await expect(this.chatArea).toHaveAttribute('data-test-state', 'streaming');
  }

  async waitForIdle(): Promise<void> {
    await expect(this.chatArea).toHaveAttribute('data-test-state', 'idle');
  }

  async expectStopVisible(): Promise<void> {
    await expect(this.stopButton).toBeVisible();
  }

  async expectStopHidden(): Promise<void> {
    await expect(this.stopButton).toBeHidden();
  }

  async stop(): Promise<void> {
    await this.stopButton.click();
  }

  async expectInputDisabled(): Promise<void> {
    await expect(this.input).toBeDisabled();
  }
}

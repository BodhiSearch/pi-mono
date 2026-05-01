import { expect, type Page, type Locator } from '@playwright/test';

export interface Credentials {
  username: string;
  password: string;
}

export interface LoginOptions {
  acceptMcps?: string[];
}

export class AuthPage {
  readonly loginButton: Locator;
  readonly logoutButton: Locator;
  readonly authSection: Locator;
  readonly approveButton: Locator;

  constructor(private page: Page) {
    this.loginButton = page.locator('[data-testid="btn-auth-login"]');
    this.logoutButton = page.locator('[data-testid="btn-auth-logout"]');
    this.authSection = page.locator('[data-testid="section-auth"]');
    this.approveButton = page.getByTestId('review-approve-button');
  }

  /**
   * Cold login — first authentication of this browser context. Walks the
   * full path: BodhiApp `/ui/login` → Keycloak password screen → access
   * request review → app.
   */
  async login(credentials: Credentials, opts: LoginOptions = {}): Promise<void> {
    await this.loginButton.click();
    await this.completeKeycloakSignIn(credentials);
    await this.approveAccessRequest(opts);
    await this.expectReturnedToApp();
  }

  /**
   * Post-logout re-login. The OAuth logout clears BodhiApp's session but
   * the access-request review screen is always shown on every login cycle.
   */
  async reloginAfterLogout(opts: LoginOptions = {}): Promise<void> {
    await this.loginButton.click();
    await this.approveAccessRequest(opts);
    await this.expectReturnedToApp();
  }

  /**
   * Mid-session re-auth path used by `/mcp add` / `/mcp remove`. The
   * chat command triggers an automatic re-auth flow that lands on the
   * access-request review page.
   */
  async reauthForMcpChange(acceptMcps: string[] = []): Promise<void> {
    await this.approveAccessRequest({ acceptMcps });
    await this.expectReturnedToApp();
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
    await expect(this.authSection).toHaveAttribute('data-test-state', 'unauthenticated');
  }

  private async completeKeycloakSignIn(credentials: Credentials): Promise<void> {
    await this.page.waitForURL(/\/ui\/login/);
    await this.page.getByRole('button', { name: 'Login', exact: true }).click();
    await this.page.waitForURL(/\/realms\/bodhi\//);
    await this.page.locator('#username').waitFor();
    await this.page.fill('#username', credentials.username);
    await this.page.fill('#password', credentials.password);
    await this.page.click('#kc-login');
  }

  private async approveAccessRequest({ acceptMcps = [] }: LoginOptions): Promise<void> {
    await this.page.waitForURL(/\/access-requests\/review/);
    await this.approveButton.waitFor();
    const accept = new Set(acceptMcps);
    const toggleIds: string[] = await this.page
      .locator('[data-testid^="review-mcp-toggle-"]')
      .evaluateAll(els => els.map(el => el.getAttribute('data-testid') ?? ''));
    for (const testid of toggleIds) {
      const url = testid.replace(/^review-mcp-toggle-/, '');
      const toggle = this.page.locator(`[data-testid="${testid}"]`);
      const currentlyChecked = (await toggle.getAttribute('aria-checked')) === 'true';
      const desired = accept.has(url);
      if (currentlyChecked !== desired) {
        await toggle.click();
      }
      if (desired) {
        // note: Radix Select renders into a portal with role="option";
        // first option is the only seeded instance per global-setup.
        await this.page.locator(`[data-testid="review-mcp-select-trigger-${url}"]`).click();
        await this.page.locator('[role="option"]').first().click();
      }
    }
    await expect(this.approveButton).toBeEnabled();
    await this.approveButton.click();
  }

  private async expectReturnedToApp(): Promise<void> {
    await this.page.waitForURL(/localhost:5173/);
    await expect(this.authSection).toHaveAttribute('data-test-state', 'authenticated');
  }
}

import { expect, type Locator, type Page } from '@playwright/test';

export interface Credentials {
  username: string;
  password: string;
}

export interface LoginOptions {
  /**
   * URLs of the MCP servers the user wants approved on this access-request
   * cycle. The review page renders one toggle row per requested URL; we
   * flip the toggle on AND pick the first available instance from the
   * combobox. URLs not in this set are explicitly toggled off.
   */
  acceptMcps?: string[];
}

// POM for the Bodhi auth flow as seen from acp-ui:
//   1. Header "Login" button kicks off bodhi-js's redirect flow.
//   2. We land on the Bodhi server's `/ui/login` (proxied login page),
//      click the "Login" button there, which redirects to Keycloak.
//   3. Keycloak hosts the password form; on success it redirects back to
//      the Bodhi server's `/access-requests/review` page.
//   4. Approve there; we end up back on `localhost:5173` with auth state
//      flipped to "authenticated".
//
// This mirrors `packages/web-acp/e2e/tests/pages/AuthPage.ts` step-for-
// step. The only deltas are the data-testids (acp-ui uses
// `btn-bodhi-login` / `section-bodhi-auth`).
export class AuthPage {
  readonly loginButton: Locator;
  readonly logoutButton: Locator;
  readonly authSection: Locator;
  readonly authName: Locator;
  readonly approveButton: Locator;

  // Auth-method dialog (surfaced by the agent advertising auth methods
  // on `initialize`, before `session/new`).
  readonly methodDialog: Locator;
  readonly methodDialogCancel: Locator;
  readonly methodDialogClose: Locator;

  constructor(private page: Page) {
    this.loginButton = page.locator('[data-testid="btn-bodhi-login"]');
    this.logoutButton = page.locator('[data-testid="btn-bodhi-logout"]');
    this.authSection = page.locator('[data-testid="section-bodhi-auth"]');
    this.authName = page.locator('[data-testid="span-bodhi-auth-name"]');
    this.approveButton = page.getByTestId('review-approve-button');

    this.methodDialog = page.locator('[data-testid="dialog-auth-method"]');
    this.methodDialogCancel = page.locator('[data-testid="btn-auth-method-cancel"]');
    this.methodDialogClose = page.locator('[data-testid="btn-auth-method-close"]');
  }

  /** Click an advertised auth method (e.g. `bodhi-token`). */
  methodButton(methodId: string): Locator {
    return this.page.locator(`[data-testid="btn-auth-method-${methodId}"]`);
  }

  async cancelMethodDialog(): Promise<void> {
    await this.methodDialogCancel.click();
    await expect(this.methodDialog).toBeHidden();
  }

  async expectUnauthenticated(): Promise<void> {
    await expect(this.authSection).toHaveAttribute(
      'data-test-state',
      'unauthenticated'
    );
  }

  async expectAuthenticated(): Promise<void> {
    await expect(this.authSection).toHaveAttribute(
      'data-test-state',
      'authenticated'
    );
  }

  // Cold login — first authentication of this browser context. Walks
  // the full path: BodhiApp `/ui/login` → Keycloak password screen →
  // access request review → app.
  async login(credentials: Credentials, opts: LoginOptions = {}): Promise<void> {
    await this.loginButton.click();
    await this.completeKeycloakSignIn(credentials);
    await this.approveAccessRequest(opts);
    await this.expectReturnedToApp();
  }

  // Post-logout re-login. The OAuth logout clears BodhiApp's session
  // but the access-request review screen is always shown on every login
  // cycle, so a re-login still walks through it.
  async reloginAfterLogout(opts: LoginOptions = {}): Promise<void> {
    await this.loginButton.click();
    await this.approveAccessRequest(opts);
    await this.expectReturnedToApp();
  }

  /**
   * Mid-session re-auth path used by `/mcp add` / `/mcp remove`. The
   * built-in action triggers a `logout()` + `login(opts)` chain inside
   * acp-ui's session store; the browser lands on the access-request
   * review page (Keycloak SSO short-circuits the password prompt) and
   * we approve with the requested MCP scopes selected. Mirrors
   * `packages/web-acp/e2e/tests/pages/AuthPage.ts:reauthForMcpChange`.
   */
  async reauthForMcpChange(acceptMcps: string[] = []): Promise<void> {
    await this.approveAccessRequest({ acceptMcps });
    await this.expectReturnedToApp();
  }

  async logout(): Promise<void> {
    await this.logoutButton.click();
    await expect(this.authSection).toHaveAttribute(
      'data-test-state',
      'unauthenticated'
    );
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

  private async approveAccessRequest({ acceptMcps = [] }: LoginOptions = {}): Promise<void> {
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
        // Radix Select renders into a portal with role="option";
        // the first option is the only seeded instance per global-setup.
        await this.page.locator(`[data-testid="review-mcp-select-trigger-${url}"]`).click();
        await this.page.locator('[role="option"]').first().click();
      }
    }
    await expect(this.approveButton).toBeEnabled();
    await this.approveButton.click();
  }

  private async expectReturnedToApp(): Promise<void> {
    await this.page.waitForURL(/localhost:5173/);
    await this.expectAuthenticated();
  }
}

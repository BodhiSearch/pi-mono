import { expect, type Locator, type Page } from '@playwright/test';

export interface Credentials {
  username: string;
  password: string;
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

  constructor(private page: Page) {
    this.loginButton = page.locator('[data-testid="btn-bodhi-login"]');
    this.logoutButton = page.locator('[data-testid="btn-bodhi-logout"]');
    this.authSection = page.locator('[data-testid="section-bodhi-auth"]');
    this.authName = page.locator('[data-testid="span-bodhi-auth-name"]');
    this.approveButton = page.getByTestId('review-approve-button');
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
  async login(credentials: Credentials): Promise<void> {
    await this.loginButton.click();
    await this.completeKeycloakSignIn(credentials);
    await this.approveAccessRequest();
    await this.expectReturnedToApp();
  }

  // Post-logout re-login. The OAuth logout clears BodhiApp's session
  // but the access-request review screen is always shown on every login
  // cycle, so a re-login still walks through it.
  async reloginAfterLogout(): Promise<void> {
    await this.loginButton.click();
    await this.approveAccessRequest();
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

  private async approveAccessRequest(): Promise<void> {
    await this.page.waitForURL(/\/access-requests\/review/);
    await this.approveButton.waitFor();
    await expect(this.approveButton).toBeEnabled();
    await this.approveButton.click();
  }

  private async expectReturnedToApp(): Promise<void> {
    await this.page.waitForURL(/localhost:5173/);
    await this.expectAuthenticated();
  }
}

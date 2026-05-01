import { Page } from '@playwright/test';

export class LoginPage {
  constructor(
    private page: Page,
    private serverUrl: string,
    private credentials: { username: string; password: string }
  ) {}

  async performOAuthLogin(redirectPath: string = '/ui/chat'): Promise<void> {
    await this.page.goto(`${this.serverUrl}${redirectPath}`);
    await this.page.waitForURL(`${this.serverUrl}/ui/login/`);
    await this.page.getByRole('button', { name: 'Login' }).click();
    await this.page.waitForSelector('#username');
    await this.page.fill('#username', this.credentials.username);
    await this.page.fill('#password', this.credentials.password);
    await this.page.click('#kc-login');
    await this.page.waitForURL(`${this.serverUrl}/ui/chat/`);
  }
}

import type { BrowserContext } from 'playwright';

export interface AuthDriverCredentials {
  username: string;
  password: string;
}

export async function driveOAuthFlow(opts: {
  context: BrowserContext;
  reviewUrl: string;
  credentials: AuthDriverCredentials;
  navTimeoutMs?: number;
  log?: (msg: string) => void;
}): Promise<void> {
  const navTimeoutMs = opts.navTimeoutMs ?? 30_000;
  const log = opts.log ?? (() => {});
  const page = await opts.context.newPage();
  page.setDefaultTimeout(navTimeoutMs);

  let succeeded = false;
  try {
    log(`goto reviewUrl=${opts.reviewUrl}`);
    await page.goto(opts.reviewUrl);
    log(`landed at ${page.url()}`);

    const loginButton = page.getByRole('button', { name: 'Login', exact: true });
    const approveButton = page
      .getByRole('button', { name: /^Approve/, exact: false })
      .or(page.getByTestId('review-approve-button'));

    await Promise.race([
      loginButton.waitFor({ state: 'visible', timeout: navTimeoutMs }),
      approveButton.waitFor({ state: 'visible', timeout: navTimeoutMs }),
    ]);

    if (await loginButton.isVisible()) {
      log('login button visible — clicking');
      await loginButton.click();
      await page.waitForURL(/\/realms\/|\/access-requests\/review/, {
        timeout: navTimeoutMs,
      });
      log(`post-login-click landed at ${page.url()}`);
      if (/\/realms\//.test(page.url())) {
        await page.locator('#username').waitFor();
        await page.fill('#username', opts.credentials.username);
        await page.fill('#password', opts.credentials.password);
        await page.click('#kc-login');
        log(`kc-login submitted, current url=${page.url()}`);
        await page
          .waitForURL(/\/access-requests\/review/, { timeout: navTimeoutMs })
          .catch(async () => {
            log(`did not see review URL; force-navigating back to ${opts.reviewUrl}`);
            await page.goto(opts.reviewUrl);
          });
      }
    }

    await approveButton.waitFor({ state: 'visible', timeout: navTimeoutMs });
    log(`approve button visible at ${page.url()}; clicking`);
    await approveButton.click();
    log(`post-approve url=${page.url()}`);

    await page.waitForURL(/localhost:\d+\/callback/, { timeout: navTimeoutMs });
    log(`callback redirect captured: ${page.url()}`);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    succeeded = true;
  } finally {
    // Leave the failing page open so the caller can screenshot it.
    if (succeeded) {
      await page.close().catch(() => {});
    }
  }
}

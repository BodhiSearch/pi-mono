import type { BrowserContext } from '@playwright/test';

export interface AuthDriverCredentials {
  username: string;
  password: string;
}

/**
 * Drives the BodhiApp + Keycloak browser flow for the cli-acp-client OAuth
 * login. The CLI prints the `review_url` it wants the user to open;
 * Playwright then walks:
 *
 *   review_url
 *     → BodhiApp /ui/login (click Login)
 *     → Keycloak /realms/bodhi/... (fill creds, submit)
 *     → BodhiApp /access-requests/review (click Approve)
 *     → http://localhost:<cliPort>/callback?id=<id>&bodhi_flow=access_request
 *     → CLI's 302 → Keycloak authorize
 *     → Keycloak SSO (cookie present, no UI)
 *     → http://localhost:<cliPort>/callback?code=...&state=...
 *     → CLI's success page
 *
 * We rely on `Page.waitForURL` against the localhost callback to know the
 * flow finished. The CLI's stdout is the authoritative success signal —
 * see `cli.spec.ts` for the actual assertions.
 */
export async function driveOAuthFlow(opts: {
  context: BrowserContext;
  reviewUrl: string;
  credentials: AuthDriverCredentials;
  /** Extra: how long to wait for each navigation step. */
  navTimeoutMs?: number;
}): Promise<void> {
  const navTimeoutMs = opts.navTimeoutMs ?? 30_000;
  const page = await opts.context.newPage();
  page.setDefaultTimeout(navTimeoutMs);
  try {
    await page.goto(opts.reviewUrl);

    // BodhiApp's React app renders the unauth state CLIENT-SIDE without
    // changing the URL — the user stays at `/ui/apps/access-requests/
    // review?id=...` but sees a "Login to use the Bodhi App" card. We
    // therefore key off element presence, not URL, to decide which
    // state we're in. There are three possible starting states:
    //
    //   A. unauthenticated → `/ui/login`-like card with a Login button
    //   B. authenticated   → access-request review page with Approve
    //   C. mid-flight      → still loading info/user calls
    //
    // We wait for any of A or B to be ready, then act.
    const loginButton = page.getByRole('button', { name: 'Login', exact: true });
    const approveButton = page
      .getByRole('button', { name: /^Approve/, exact: false })
      .or(page.getByTestId('review-approve-button'));

    await Promise.race([
      loginButton.waitFor({ state: 'visible', timeout: navTimeoutMs }),
      approveButton.waitFor({ state: 'visible', timeout: navTimeoutMs }),
    ]);

    // State A: click Login → Keycloak.
    if (await loginButton.isVisible()) {
      await loginButton.click();
      // Wait for Keycloak credential screen OR a direct hop back to
      // the review page (cookie present and BodhiApp short-circuited).
      await page.waitForURL(/\/realms\/|\/access-requests\/review/, {
        timeout: navTimeoutMs,
      });
      if (/\/realms\//.test(page.url())) {
        await page.locator('#username').waitFor();
        await page.fill('#username', opts.credentials.username);
        await page.fill('#password', opts.credentials.password);
        await page.click('#kc-login');
        // After successful Keycloak login we land at BodhiApp's
        // `/ui/auth/callback` which then bounces to either the
        // originally-requested review URL OR `/ui/chat/`. If we end up
        // somewhere else, force-navigate back to the review URL — we
        // have a session now.
        await page
          .waitForURL(/\/access-requests\/review/, { timeout: navTimeoutMs })
          .catch(async () => {
            await page.goto(opts.reviewUrl);
          });
      }
    }

    // State B / post-login: review page must now have the Approve button.
    await approveButton.waitFor({ state: 'visible', timeout: navTimeoutMs });
    await approveButton.click();

    // After approve, BodhiApp redirects to our local callback, which
    // then 302s to Keycloak and bounces back. We just have to wait
    // until the browser sees the final localhost success page.
    await page.waitForURL(/localhost:\d+\/callback/, { timeout: navTimeoutMs });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  } finally {
    await page.close().catch(() => {});
  }
}

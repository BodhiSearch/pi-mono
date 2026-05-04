import type { BrowserContext } from "@playwright/test";

export interface AuthDriverCredentials {
	username: string;
	password: string;
}

/**
 * Drives the BodhiApp + Keycloak browser flow for the tutorial CLI's
 * access-request login. Mirrors packages/cli-acp-client/e2e auth-driver
 * exactly — same pages, same selectors, same flow.
 *
 *   review_url
 *     → BodhiApp /ui/login (click Login)
 *     → Keycloak /realms/bodhi/... (fill creds, submit)
 *     → BodhiApp /access-requests/review (click Approve)
 *     → http://localhost:5173/callback?id=<id>&bodhi_flow=access_request
 *     → CLI 302 → Keycloak authorize
 *     → Keycloak SSO (cookie present, no UI)
 *     → http://localhost:5173/callback?code=...&state=...
 *     → CLI success page
 */
export async function driveOAuthFlow(opts: {
	context: BrowserContext;
	reviewUrl: string;
	credentials: AuthDriverCredentials;
	navTimeoutMs?: number;
}): Promise<void> {
	const navTimeoutMs = opts.navTimeoutMs ?? 30_000;
	const page = await opts.context.newPage();
	page.setDefaultTimeout(navTimeoutMs);
	try {
		await page.goto(opts.reviewUrl);

		const loginButton = page.getByRole("button", { name: "Login", exact: true });
		const approveButton = page
			.getByRole("button", { name: /^Approve/, exact: false })
			.or(page.getByTestId("review-approve-button"));

		await Promise.race([
			loginButton.waitFor({ state: "visible", timeout: navTimeoutMs }),
			approveButton.waitFor({ state: "visible", timeout: navTimeoutMs }),
		]);

		if (await loginButton.isVisible()) {
			await loginButton.click();
			await page.waitForURL(/\/realms\/|\/access-requests\/review/, {
				timeout: navTimeoutMs,
			});
			if (/\/realms\//.test(page.url())) {
				await page.locator("#username").waitFor();
				await page.fill("#username", opts.credentials.username);
				await page.fill("#password", opts.credentials.password);
				await page.click("#kc-login");
				await page.waitForURL(/\/access-requests\/review/, { timeout: navTimeoutMs }).catch(async () => {
					await page.goto(opts.reviewUrl);
				});
			}
		}

		await approveButton.waitFor({ state: "visible", timeout: navTimeoutMs });
		await approveButton.click();

		await page.waitForURL(/localhost:\d+\/callback/, { timeout: navTimeoutMs });
		await page.waitForLoadState("domcontentloaded").catch(() => {});
	} finally {
		await page.close().catch(() => {});
	}
}

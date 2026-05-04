import { test, expect, chromium } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliHarness } from "./tests/utils/cli-harness";
import { driveOAuthFlow } from "./tests/utils/auth-driver";
import { getTestState } from "./tests/global-setup";

test("OAuth login round-trip stores tokens and /token surfaces JWT claims", async () => {
	const state = getTestState();

	const harness = await CliHarness.start({
		bodhiUrl: state.bodhiServerUrl,
		echo: !!process.env.CLI_ECHO,
	});

	try {
		const loginEvent = await test.step("CLI emits the access-request URL", async () => {
			const event = await harness.waitFor((ev) => typeof ev.login_url === "string");
			expect(event.login_url).toMatch(/\/access-requests\/review\?id=/);
			return event;
		});
		const reviewUrl = loginEvent.login_url as string;

		const browser = await chromium.launch({
			headless: process.env.HEADLESS !== "false",
		});
		const context = await browser.newContext();
		try {
			await test.step("Playwright drives Bodhi review + Keycloak SSO", async () => {
				await driveOAuthFlow({
					context,
					reviewUrl,
					credentials: { username: state.username, password: state.password },
					navTimeoutMs: 60_000,
				});
			});
		} finally {
			await context.close();
			await browser.close();
		}

		await test.step("CLI reports successful authentication", async () => {
			await harness.waitFor(/Authentication successful/, 60_000);
		});

		await test.step("tokens.json is written to cwd", async () => {
			const tokenPath = join(harness.cwd, ".tutorial-cli-client", "tokens.json");
			expect(existsSync(tokenPath)).toBe(true);
			const stored = JSON.parse(readFileSync(tokenPath, "utf-8")) as Record<string, unknown>;
			expect(typeof stored.accessToken).toBe("string");
			expect((stored.accessToken as string).split(".")).toHaveLength(3);
		});

		await test.step("/token emits a JWT with the expected claims", async () => {
			harness.send("/token");
			const tokenEvent = await harness.waitFor((ev) => typeof ev.tokens === "object" && ev.tokens !== null);
			expect(typeof tokenEvent.text).toBe("string");
			const jwtParts = (tokenEvent.text as string).split(".");
			expect(jwtParts).toHaveLength(3);
			const claims = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString("utf-8")) as Record<
				string,
				unknown
			>;
			expect(claims.sub).toBeDefined();
			expect(claims.azp).toBe("bodhi-app-f181a4d1-d7af-43f4-965a-0a8efd453d86");
			expect(typeof claims.scope).toBe("string");
			expect((claims.scope as string).split(" ")).toContain("openid");
		});

		await test.step("/bodhiapp:status proxies through the embedded agent", async () => {
			harness.send("/bodhiapp:status");
			const statusEvent = await harness.waitFor(
				(ev) => typeof ev.status === "string" && typeof ev.url === "string",
			);
			expect(statusEvent.status).toBe("ready");
			expect(statusEvent.url).toBe(state.bodhiServerUrl);
			expect(typeof statusEvent.version).toBe("string");
		});

		await test.step("/quit reports application exited", async () => {
			harness.send("/quit");
			const exited = await harness.waitFor(/application exited/, 10_000);
			expect(exited.text).toBe("application exited");
		});
	} finally {
		harness.dispose();
	}
});

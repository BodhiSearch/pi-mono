import os from "node:os";
import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;
const isHeadless = process.env.HEADLESS === "false" ? false : process.env.HEADLESS === "true" || isCI;

function buildUserAgent(): string {
	const platform = os.platform();
	const chromeVersion = "141.0.0.0";
	const osToken =
		platform === "darwin"
			? "Macintosh; Intel Mac OS X 10_15_7"
			: platform === "linux"
				? "X11; Linux x86_64"
				: "Windows NT 10.0; Win64; x64";
	return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

export default defineConfig({
	testDir: "./e2e",
	testIgnore: ["**/tests/**"],
	fullyParallel: false,
	workers: 1,
	forbidOnly: isCI,
	retries: isCI ? 2 : 0,
	reporter: "html",
	globalSetup: "./e2e/tests/global-setup.ts",
	timeout: 180_000,
	expect: { timeout: 30_000 },
	use: {
		headless: isHeadless,
		trace: "retain-on-failure",
		screenshot: { mode: "only-on-failure", fullPage: true },
		video: "retain-on-failure",
		actionTimeout: 30_000,
		navigationTimeout: 30_000,
		...(isHeadless && { userAgent: buildUserAgent() }),
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"], headless: isHeadless },
		},
	],
});

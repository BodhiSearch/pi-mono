import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { bootstrapCli } from "../src/index";

describe("cli /quit", () => {
	it('prints "application exited" and signals exit', async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let captured = "";
		output.on("data", (chunk: Buffer) => {
			captured += chunk.toString("utf8");
		});
		const exit = vi.fn();
		const cwd = mkdtempSync(join(tmpdir(), "tutorial-cli-client-quit-"));

		const done = bootstrapCli({
			input,
			output,
			exit,
			cwd,
			bodhiUrl: "http://localhost:0",
			skipAuth: true,
		});
		input.write("/quit\n");
		await done;

		expect(captured).toContain("application exited");
		expect(exit).toHaveBeenCalledTimes(1);
	});
});

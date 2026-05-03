import { umount } from "@zenfs/core/vfs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSeedInit } from "../../test-utils/seed-volume";
import { ZenfsVolumeRegistry } from "../volume-registry";
import { BASH_OUTPUT_BYTE_LIMIT, createBashTool } from "./bash-tool";

async function resetMount(name: string) {
	try {
		umount(`/mnt/${name}`);
	} catch {
		/* not mounted */
	}
}

describe("bash-tool", () => {
	let registry: ZenfsVolumeRegistry;

	beforeEach(async () => {
		await resetMount("wiki");
		registry = new ZenfsVolumeRegistry();
		await registry.mountAll([
			buildSeedInit({
				mountName: "wiki",
				description: "knowledge base",
				files: {
					"/hello.md": "hi\nfrom wiki",
				},
			}),
		]);
	});

	afterEach(async () => {
		await resetMount("wiki");
	});

	it("returns bash tool metadata with typebox schema", () => {
		const tool = createBashTool({ registry });
		expect(tool.name).toBe("bash");
		expect(tool.label).toBe("Bash");
		expect(tool.parameters).toBeDefined();
		expect(tool.parameters.type).toBe("object");
	});

	it("executes a simple cat against the mounted volume", async () => {
		const tool = createBashTool({ registry });
		const result = await tool.execute("call-1", {
			script: "cat /mnt/wiki/hello.md",
		});
		expect(result.details.exitCode).toBe(0);
		expect(result.details.stdout).toContain("from wiki");
		expect(result.details.truncated).toBe(false);
		expect(result.content[0].type).toBe("text");
	});

	it("writes and reads back inside the scratch /tmp mount", async () => {
		const tool = createBashTool({ registry });
		const result = await tool.execute("call-2", {
			script: "echo hello > /tmp/out.txt && cat /tmp/out.txt",
		});
		expect(result.details.exitCode).toBe(0);
		expect(result.details.stdout.trim()).toBe("hello");
	});

	it("defaults cwd to /mnt/<first volume>", async () => {
		const tool = createBashTool({ registry });
		const result = await tool.execute("call-3", { script: "pwd" });
		expect(result.details.stdout.trim()).toBe("/mnt/wiki");
	});

	it("flags truncated output over the 256 KiB per-stream ceiling", async () => {
		const tool = createBashTool({ registry });
		const chunkLen = 1024;
		const chunk = "x".repeat(chunkLen);
		const iterations = Math.ceil((BASH_OUTPUT_BYTE_LIMIT * 2) / chunkLen);
		const result = await tool.execute("call-4", {
			script: `i=0; while [ $i -lt ${iterations} ]; do printf '${chunk}'; i=$((i+1)); done`,
		});
		expect(result.details.exitCode).toBe(0);
		expect(result.details.truncated).toBe(true);
		expect(result.details.stdout.length).toBeGreaterThan(0);
		expect(new TextEncoder().encode(result.details.stdout).byteLength).toBeLessThanOrEqual(BASH_OUTPUT_BYTE_LIMIT);
	});

	it("propagates non-zero exit codes", async () => {
		const tool = createBashTool({ registry });
		const result = await tool.execute("call-5", { script: "exit 7" });
		expect(result.details.exitCode).toBe(7);
	});

	it("aborts when the external signal is already fired", async () => {
		const tool = createBashTool({ registry });
		const ctrl = new AbortController();
		ctrl.abort();
		const result = await tool.execute("call-6", { script: "echo hi" }, ctrl.signal);
		expect(result.details.exitCode).not.toBe(0);
	});
});

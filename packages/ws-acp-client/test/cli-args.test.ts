import { describe, expect, it } from "vitest";
import { DEFAULT_BIND, DEFAULT_PORT, parseArgs } from "../src/cli-args";

// Smoke coverage for the new `--volume name=path` plumbing in cli-args.
// The pre-existing flags (`--port`, `--cwd`, `--bind`) are exercised via
// e2e indirectly; the volume parser has the most edge cases worth pinning.
describe("parseArgs", () => {
	it("returns defaults when no flags are passed", () => {
		const args = parseArgs([], { defaultCwd: "/work" });
		expect(args.port).toBe(DEFAULT_PORT);
		expect(args.bindAddress).toBe(DEFAULT_BIND);
		expect(args.cwd).toBe("/work");
		expect(args.volumes).toEqual([]);
	});

	it("collects multiple --volume flags in order", () => {
		const args = parseArgs(["--volume", "code=/srv/code", "--volume", "docs=/srv/docs"], { defaultCwd: "/work" });
		expect(args.volumes).toEqual([
			{ name: "code", path: "/srv/code" },
			{ name: "docs", path: "/srv/docs" },
		]);
	});

	it("rejects --volume without an '='", () => {
		expect(() => parseArgs(["--volume", "code"], { defaultCwd: "/work" })).toThrow(/expected name=path/);
	});

	it("rejects --volume with empty name or path", () => {
		expect(() => parseArgs(["--volume", "=/x"], { defaultCwd: "/work" })).toThrow(/expected name=path/);
		expect(() => parseArgs(["--volume", "code="], { defaultCwd: "/work" })).toThrow(/expected name=path/);
	});

	it("rejects the reserved 'cwd' mount name", () => {
		expect(() => parseArgs(["--volume", "cwd=/elsewhere"], { defaultCwd: "/work" })).toThrow(/reserved/);
	});

	it("rejects invalid mount-name characters", () => {
		expect(() => parseArgs(["--volume", "bad name=/x"], { defaultCwd: "/work" })).toThrow(/invalid name/);
		expect(() => parseArgs(["--volume", "with/slash=/x"], { defaultCwd: "/work" })).toThrow(/invalid name/);
	});

	it("rejects duplicate mount names", () => {
		expect(() => parseArgs(["--volume", "code=/a", "--volume", "code=/b"], { defaultCwd: "/work" })).toThrow(
			/duplicate name/,
		);
	});

	it("preserves an absolute path with '=' in it (split on FIRST '=')", () => {
		// POSIX paths may contain '='; the parser splits on the first one
		// only, so 'name=/odd=path' becomes name='name', path='/odd=path'.
		const args = parseArgs(["--volume", "weird=/odd=path"], {
			defaultCwd: "/work",
		});
		expect(args.volumes).toEqual([{ name: "weird", path: "/odd=path" }]);
	});

	it("parses --port and rejects invalid values", () => {
		const ok = parseArgs(["--port", "0"], { defaultCwd: "/work" });
		expect(ok.port).toBe(0);
		expect(() => parseArgs(["--port", "abc"], { defaultCwd: "/work" })).toThrow(/invalid number/);
	});

	it("rejects unknown flags", () => {
		expect(() => parseArgs(["--bogus"], { defaultCwd: "/work" })).toThrow(/Unknown arg/);
	});
});

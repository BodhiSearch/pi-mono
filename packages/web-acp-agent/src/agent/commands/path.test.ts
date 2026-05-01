import { describe, expect, it } from "vitest";
import { canonicalCommandName, InvalidCommandPathError } from "./path";

describe("canonicalCommandName", () => {
	it("joins mount + flat file stem", () => {
		expect(canonicalCommandName({ mountName: "wiki", pathBelowCommands: "greet.md" })).toBe("wiki:greet");
	});

	it("joins mount + nested subdir + file stem", () => {
		expect(canonicalCommandName({ mountName: "wiki", pathBelowCommands: "review/api.md" })).toBe("wiki:review:api");
	});

	it("handles deep nesting", () => {
		expect(canonicalCommandName({ mountName: "work", pathBelowCommands: "a/b/c/leaf.md" })).toBe("work:a:b:c:leaf");
	});

	it("strips a leading slash on the relative path", () => {
		expect(canonicalCommandName({ mountName: "wiki", pathBelowCommands: "/review/api.md" })).toBe("wiki:review:api");
	});

	it("rejects a non-md file", () => {
		expect(() => canonicalCommandName({ mountName: "wiki", pathBelowCommands: "greet.txt" })).toThrow(
			InvalidCommandPathError,
		);
	});

	it("rejects an invalid mount name", () => {
		expect(() => canonicalCommandName({ mountName: "Wiki", pathBelowCommands: "greet.md" })).toThrow(
			InvalidCommandPathError,
		);
	});

	it("rejects an invalid path segment", () => {
		expect(() => canonicalCommandName({ mountName: "wiki", pathBelowCommands: "Bad-Dir/leaf.md" })).toThrow(
			InvalidCommandPathError,
		);
	});

	it("rejects an invalid file stem", () => {
		expect(() => canonicalCommandName({ mountName: "wiki", pathBelowCommands: "0bad.md" })).toThrow(
			InvalidCommandPathError,
		);
	});

	it("rejects an empty relative path", () => {
		expect(() => canonicalCommandName({ mountName: "wiki", pathBelowCommands: "" })).toThrow(InvalidCommandPathError);
	});
});

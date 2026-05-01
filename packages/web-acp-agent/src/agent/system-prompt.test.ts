import { describe, expect, it } from "vitest";
import { composeSystemPrompt } from "./system-prompt";

describe("composeSystemPrompt", () => {
	it("returns empty string when there are no volumes", () => {
		expect(composeSystemPrompt([])).toBe("");
	});

	it("lists a single volume without description", () => {
		const prompt = composeSystemPrompt([{ mountName: "wiki" }]);
		expect(prompt).toContain("/mnt/wiki");
		expect(prompt).not.toContain(" — ");
		expect(prompt).toContain("Use the bash tool to explore them.");
	});

	it("lists a single volume with description", () => {
		const prompt = composeSystemPrompt([{ mountName: "wiki", description: "knowledge base" }]);
		expect(prompt).toContain("- /mnt/wiki — knowledge base");
	});

	it("lists multiple volumes, mixing descriptions", () => {
		const prompt = composeSystemPrompt([{ mountName: "wiki", description: "knowledge base" }, { mountName: "code" }]);
		expect(prompt).toContain("- /mnt/wiki — knowledge base");
		expect(prompt).toContain("- /mnt/code");
		expect(prompt.startsWith("You have access to the following volumes:")).toBe(true);
	});
});

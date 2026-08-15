import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { extractGeneratedSessionName } from "../src/core/agent-session.js";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

/**
 * The session title comes straight from a model, so it arrives with whatever
 * quoting, markdown, or preamble the model felt like adding. Anything that
 * leaks through ends up as the visible conversation name.
 */
describe("extractGeneratedSessionName", () => {
	it("strips quotes, markdown, and trailing punctuation", () => {
		expect(extractGeneratedSessionName(assistant('"Fix the Windows console flash."'))).toBe(
			"Fix the Windows console flash",
		);
		expect(extractGeneratedSessionName(assistant("**Rename session titles**"))).toBe("Rename session titles");
	});

	it("drops a Title: prefix", () => {
		expect(extractGeneratedSessionName(assistant('Title: "Debug daemon startup"'))).toBe("Debug daemon startup");
		expect(extractGeneratedSessionName(assistant("title: Debug daemon startup"))).toBe("Debug daemon startup");
	});

	it("keeps only the first non-empty line", () => {
		expect(extractGeneratedSessionName(assistant("\n\nDebug daemon startup\nHere is why: ...\n"))).toBe(
			"Debug daemon startup",
		);
	});

	it("truncates long titles", () => {
		const name = extractGeneratedSessionName(assistant("a".repeat(200)));
		expect(name).toHaveLength(80);
		expect(name?.endsWith("...")).toBe(true);
	});

	it("returns undefined for empty output", () => {
		expect(extractGeneratedSessionName(assistant("   \n  "))).toBeUndefined();
		expect(extractGeneratedSessionName({ ...assistant(""), content: [] } as AssistantMessage)).toBeUndefined();
	});
});

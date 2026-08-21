import { describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createAskUserToolDefinition } from "../src/core/tools/ask-user.js";

const question = {
	question: "Which plan should we use?",
	options: [
		{ label: "Small change", description: "Lower risk.", recommended: true },
		{ label: "Large change", description: "More complete.", recommended: false },
	],
};

function contextWithAnswers(answers: string[]): ExtensionContext {
	return {
		hasUI: true,
		ui: { question: vi.fn().mockResolvedValue(answers) },
	} as unknown as ExtensionContext;
}

describe("ask_user", () => {
	test("returns the answers from the UI", async () => {
		const tool = createAskUserToolDefinition();
		const result = await tool.execute(
			"call-1",
			{ questions: [question] },
			undefined,
			undefined,
			contextWithAnswers(["Small change"]),
		);

		expect(result.details).toEqual({ answers: ["Small change"] });
		expect(result.content[0]).toEqual({ type: "text", text: "Which plan should we use?: Small change" });
	});

	test("requires exactly one recommended option", async () => {
		const tool = createAskUserToolDefinition();
		await expect(
			tool.execute(
				"call-1",
				{
					questions: [
						{ ...question, options: question.options.map((option) => ({ ...option, recommended: false })) },
					],
				},
				undefined,
				undefined,
				contextWithAnswers([]),
			),
		).rejects.toThrow("exactly one recommended");
	});
});

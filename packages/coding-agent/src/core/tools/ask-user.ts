import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ExtensionUIQuestion, ToolDefinition } from "../extensions/types.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const askUserOptionSchema = Type.Object({
	label: Type.String({ description: "Short answer label shown to the user" }),
	description: Type.String({ description: "Why this answer may be useful" }),
	recommended: Type.Boolean({ description: "Set true for the single best answer" }),
});

const askUserQuestionSchema = Type.Object({
	question: Type.String({ description: "The decision the user must make" }),
	description: Type.Optional(Type.String({ description: "Short extra context for the question" })),
	options: Type.Array(askUserOptionSchema, {
		minItems: 2,
		maxItems: 6,
		description: "Answer choices. Mark exactly one choice as recommended.",
	}),
});

const askUserSchema = Type.Object({
	questions: Type.Array(askUserQuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "Questions to ask before continuing. Keep the list short.",
	}),
});

export type AskUserToolInput = Static<typeof askUserSchema>;

function validateQuestions(questions: AskUserToolInput["questions"]): ExtensionUIQuestion[] {
	return questions.map((question, questionIndex) => {
		if (!question.question.trim()) {
			throw new Error(`Question ${questionIndex + 1} is empty`);
		}
		const labels = new Set<string>();
		let recommendedCount = 0;
		const options = question.options.map((option, optionIndex) => {
			const label = option.label.trim();
			if (!label) throw new Error(`Question ${questionIndex + 1}, option ${optionIndex + 1} has no label`);
			const key = label.toLocaleLowerCase();
			if (labels.has(key)) throw new Error(`Question ${questionIndex + 1} has duplicate answer labels`);
			labels.add(key);
			if (option.recommended) recommendedCount++;
			return {
				label,
				description: option.description.trim(),
				recommended: option.recommended,
			};
		});
		if (recommendedCount !== 1) {
			throw new Error(`Question ${questionIndex + 1} must have exactly one recommended answer`);
		}
		return {
			question: question.question.trim(),
			description: question.description?.trim() || undefined,
			options,
		};
	});
}

function formatAnswers(questions: ExtensionUIQuestion[], answers: string[]): string {
	return questions.map((question, index) => `${question.question}: ${answers[index] ?? "(no answer)"}`).join("\n");
}

export function createAskUserToolDefinition(): ToolDefinition<
	typeof askUserSchema,
	{ answers?: string[]; cancelled?: boolean }
> {
	return {
		name: "ask_user",
		label: "ask user",
		description:
			"Ask the user one or more important multiple-choice questions before continuing. Each question must have exactly one recommended answer. Use short labels and useful descriptions.",
		promptSnippet: "ask_user - ask the user for a decision when the next step depends on their choice",
		promptGuidelines: [
			"Use ask_user when the user's choice changes the work. Do not hide important choices in normal chat.",
			"Give 2 to 6 clear options and mark exactly one option as recommended.",
			"Keep labels short. Use descriptions to explain the trade-off.",
		],
		parameters: askUserSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx?: ExtensionContext) {
			const questions = validateQuestions(params.questions);
			if (!ctx?.hasUI) {
				throw new Error("ask_user needs an interactive user interface");
			}
			const answers = await ctx.ui.question(questions, { signal });
			if (!answers) {
				return {
					content: [{ type: "text", text: "The user dismissed the questions." } satisfies TextContent],
					details: { cancelled: true },
				};
			}
			return {
				content: [{ type: "text", text: formatAnswers(questions, answers) } satisfies TextContent],
				details: { answers },
			};
		},
	};
}

export function createAskUserTool() {
	return wrapToolDefinition(createAskUserToolDefinition());
}

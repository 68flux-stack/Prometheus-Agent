import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { type BedrockOptions, streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context, Model } from "../src/types.js";

interface BedrockCachePayload {
	modelId: string;
	system?: Array<{ text?: string; cachePoint?: unknown }>;
	messages?: Array<{ role: string; content: unknown }>;
}

function makeContext(messages?: Context["messages"]): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: messages ?? [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: BedrockOptions,
): Promise<BedrockCachePayload> {
	let capturedPayload: BedrockCachePayload | undefined;
	const s = streamBedrock(model, context, {
		...options,
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload as BedrockCachePayload;
			return payload;
		},
	});

	for await (const event of s) {
		if (event.type === "error") {
			break;
		}
	}

	if (!capturedPayload) {
		throw new Error("Expected Bedrock payload to be captured before request abort");
	}

	return capturedPayload;
}

function lastContentBlock(message: { content: unknown }): Record<string, unknown> {
	const blocks = message.content as Array<Record<string, unknown>>;
	return blocks[blocks.length - 1] ?? {};
}

describe("Bedrock cache points", () => {
	it("adds system and last-message cache points for Claude 5.x models", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");

		const payload = await capturePayload(model, makeContext());

		// System: text block followed by a cache point
		expect(payload.system).not.toBeUndefined();
		expect(payload.system!.at(-1)).toHaveProperty("cachePoint");

		// Last message: text block followed by a cache point
		const lastMessage = payload.messages!.at(-1)!;
		expect(lastContentBlock(lastMessage)).toHaveProperty("cachePoint");
	});

	it("adds a cache point to a trailing assistant message", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5");
		const context = makeContext([
			{ role: "user", content: "Hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "text", text: "Hi there" }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		]);

		const payload = await capturePayload(model, context);

		const lastMessage = payload.messages!.at(-1)!;
		expect(lastMessage.role).toBe("assistant");
		expect(lastContentBlock(lastMessage)).toHaveProperty("cachePoint");
	});

	it("omits cache points for non-Claude models", async () => {
		const model = getModel("amazon-bedrock", "amazon.nova-lite-v1:0");

		const payload = await capturePayload(model, makeContext());

		expect(payload.system).not.toBeUndefined();
		expect(payload.system!.at(-1)).not.toHaveProperty("cachePoint");

		const lastMessage = payload.messages!.at(-1)!;
		expect(lastContentBlock(lastMessage)).not.toHaveProperty("cachePoint");
	});

	it("omits cache points when cacheRetention is none", async () => {
		const model = getModel("amazon-bedrock", "global.anthropic.claude-opus-5");

		const payload = await capturePayload(model, makeContext(), { cacheRetention: "none" });

		expect(payload.system).not.toBeUndefined();
		expect(payload.system!.at(-1)).not.toHaveProperty("cachePoint");

		const lastMessage = payload.messages!.at(-1)!;
		expect(lastContentBlock(lastMessage)).not.toHaveProperty("cachePoint");
	});
});

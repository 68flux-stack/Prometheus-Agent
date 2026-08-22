import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

interface AnthropicSystemBlock {
	type?: string;
	text?: string;
	cache_control?: unknown;
}

interface AnthropicPayload {
	system?: AnthropicSystemBlock[];
}

async function captureOAuthPayload(context: Context): Promise<AnthropicPayload> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	let capturedPayload: AnthropicPayload | undefined;

	try {
		const s = streamAnthropic(model, context, {
			apiKey: "sk-ant-oat-test-key",
			onPayload: (payload) => {
				capturedPayload = payload as AnthropicPayload;
			},
		});

		// Fake OAuth token: the request fails, but the payload is captured first.
		for await (const event of s) {
			if (event.type === "error") break;
		}
	} catch {
		// Expected to fail
	}

	if (!capturedPayload) {
		throw new Error("Expected Anthropic payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic OAuth cache markers", () => {
	it("puts the single cache marker on the last system block when a system prompt is set", async () => {
		const payload = await captureOAuthPayload({
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		});

		expect(payload.system).toHaveLength(2);
		// Identity block first, WITHOUT the marker
		expect(payload.system![0].text).toContain("Claude Code");
		expect(payload.system![0].cache_control).toBeUndefined();
		// System prompt block last, WITH the marker
		expect(payload.system![1].text).toContain("helpful assistant");
		expect(payload.system![1].cache_control).toEqual({ type: "ephemeral" });
	});

	it("keeps the cache marker on the identity block when no system prompt is set", async () => {
		const payload = await captureOAuthPayload({
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		});

		expect(payload.system).toHaveLength(1);
		expect(payload.system![0].text).toContain("Claude Code");
		expect(payload.system![0].cache_control).toEqual({ type: "ephemeral" });
	});
});

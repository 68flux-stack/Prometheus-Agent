import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

// Regression: a steer-classified ("next_turn_boundary") message accepted by an
// idle session - for example an RLM child completion notice relayed by the
// daemon - used to sit in the queue forever because nothing scheduled the input
// pump when no turn was active. The parent never woke, so subagent results were
// lost until unrelated activity flushed the queue.
describe("idle steer delivery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("delivers a steer-queued agent message to an idle session without an external pump trigger", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("woke up")]);

		// Mirrors daemon acceptAgentSessionMessage's queue path for a target that
		// looked busy but has no active turn.
		await harness.session.queueAgentMessagePrompt("wake on queue", "steer");

		await vi.waitFor(() => {
			expect(getUserTexts(harness)).toContain("wake on queue");
		});
		await harness.session.waitForIdle();
		expect(getAssistantTexts(harness)).toContain("woke up");
		expect(harness.session.unfinishedActionCount).toBe(0);
	});
});

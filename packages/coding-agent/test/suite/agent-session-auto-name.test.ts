import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/** A local title is written on the first user message, then upgraded by a model call. */
describe("automatic session naming", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("names an unnamed session from the first user message", async () => {
		const harness = await createHarness({ settings: { autoSessionName: true } });
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("Title: Fix the login button"),
			() => fauxAssistantMessage("The click handler was never bound."),
		]);

		await harness.session.prompt("the login button does nothing when clicked");
		await vi.waitFor(() => expect(harness.sessionManager.getSessionName()).toBe("Fix the login button"));

		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual([
			"the login button does nothing when clicked",
			"Fix the login button",
		]);
	});

	it("uses only the opening prompt for the model upgrade", async () => {
		const harness = await createHarness({ settings: { autoSessionName: true } });
		harnesses.push(harness);
		let titleRequest = "";
		let titleOptions: unknown;
		harness.setResponses([
			(context, options) => {
				titleRequest = context.messages
					.map((message) =>
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((block): block is { type: "text"; text: string } => block.type === "text")
									.map((block) => block.text)
									.join(""),
					)
					.join("\n");
				titleOptions = options;
				return fauxAssistantMessage("Login button click handler");
			},
			() => fauxAssistantMessage("The click handler was never bound."),
		]);

		await harness.session.prompt("the login button does nothing when clicked");
		await vi.waitFor(() => expect(harness.sessionManager.getSessionName()).toBe("Login button click handler"));

		expect(titleRequest).toContain("the login button does nothing when clicked");
		expect(titleRequest).not.toContain("The click handler was never bound.");
		expect(titleOptions).not.toHaveProperty("temperature");
	});

	it("leaves an already-named session alone", async () => {
		const harness = await createHarness({ settings: { autoSessionName: true } });
		harnesses.push(harness);
		harness.session.setSessionName("chosen by the user");
		harness.setResponses([() => fauxAssistantMessage("answer"), () => fauxAssistantMessage("Generated title")]);

		await harness.session.prompt("first prompt");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(harness.sessionManager.getSessionName()).toBe("chosen by the user");
		expect(harness.eventsOfType("session_info_changed").map((event) => event.name)).toEqual(["chosen by the user"]);
	});

	it("does not name a session when the setting is off", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([() => fauxAssistantMessage("answer")]);

		await harness.session.prompt("first prompt");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("retries after a blank generated title", async () => {
		const harness = await createHarness({ settings: { autoSessionName: true } });
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("   "),
			() => fauxAssistantMessage("First answer"),
			() => fauxAssistantMessage("Resolve startup failure"),
			() => fauxAssistantMessage("Second answer"),
		]);

		await harness.session.prompt("first prompt");
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(2));
		await harness.session.prompt("second prompt");
		await vi.waitFor(() => expect(harness.sessionManager.getSessionName()).toBe("Resolve startup failure"));
	});
});

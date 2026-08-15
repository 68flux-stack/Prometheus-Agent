import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

function terminalMessage(messages: readonly unknown[]): AgentSessionMessage | undefined {
	return messages.find(
		(message): message is AgentSessionMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			"customType" in message &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === AGENT_MESSAGE_CUSTOM_TYPE,
	);
}

describe("#617 subagent terminal agent messages", () => {
	let parent: Harness | undefined;
	let child: Harness | undefined;

	afterEach(() => {
		child?.cleanup();
		parent?.cleanup();
		child = undefined;
		parent = undefined;
	});

	it("automatically delivers the child's final response as an attributed agent message", async () => {
		const childSessionName = "terminal-worker";
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async (input) => {
					expect(input).toEqual({
						target: parent!.session.sessionId,
						message: "child completed",
					});
					const message = createAgentSessionMessage({
						id: "agentmsg-terminal-completion",
						source: "agent_message",
						message: input.message,
						from: {
							activeSessionId: "child-active",
							sessionId: child!.session.sessionId,
							sessionName: childSessionName,
						},
						fromRelationship: "child",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
					});
					await parent!.session.acceptAgentMessagePrompt(message.content, { customMessage: message });
					return {
						id: message.details.id,
						source: "agent_message",
						target: { activeSessionId: "parent-active", sessionId: parent!.session.sessionId },
						message: input.message,
						deliveryStatus: "delivered",
					};
				},
			},
		});
		parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		child.setResponses([fauxAssistantMessage("child completed")]);

		await parent.session.runRlmChild("finish without replying", { name: childSessionName });

		await expect
			.poll(() => terminalMessage(parent!.session.messages))
			.toMatchObject({
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				details: {
					id: "agentmsg-terminal-completion",
					fromRelationship: "child",
					from: { sessionId: child.session.sessionId, sessionName: childSessionName },
				},
				content: expect.stringContaining(`[from child:${childSessionName}]`),
			});
		expect(parent.session.messages).not.toContainEqual(
			expect.objectContaining({ customType: "rlm_child_terminal_notice" }),
		);
		expect(terminalMessage(parent.session.messages)?.details.message).toBe("child completed");
	});
	it("falls back to an injected final response when agent-message delivery fails", async () => {
		// A controller that always rejects: the parent must still learn the child
		// finished. Losing the notice entirely is worse than losing attribution.
		child = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async () => {
					throw new Error("delivery unavailable");
				},
			},
		});
		parent = await createHarness({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child!.session }),
				deleteRlmSubagentRuntime: async () => {},
			} as never,
		});
		child.setResponses([fauxAssistantMessage("done, no reply to parent")]);
		parent.setResponses([fauxAssistantMessage("parent ack")]);

		await parent.session.runRlmChild("do the work");
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(parent.session.messages).toContainEqual(
			expect.objectContaining({
				customType: "rlm_child_terminal_notice",
				content: "done, no reply to parent",
				details: expect.objectContaining({ kind: "completed" }),
			}),
		);
	}, 60_000);
});

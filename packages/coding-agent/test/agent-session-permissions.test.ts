import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

// Plan mode's non-Windows path requires the `srt` sandbox runtime on PATH, which isn't
// available in CI — mirrors the platform gate in execution-policy.test.ts.
describe.runIf(process.platform === "win32")("AgentSession plan mode directive", () => {
	it("tells the model it's in plan mode and drops the guideline again on exit", () => {
		const session = createSession();

		session.setExecutionMode("plan");
		expect(session.systemPrompt).toContain("Plan mode is active");
		expect(session.systemPrompt).toContain("Do not edit or create files");
		expect(session.systemPrompt).toContain("only blocks file editing and creation");

		session.setExecutionMode("workspace");
		expect(session.systemPrompt).not.toContain("Plan mode is active");
	});
});

import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	createAgentConnectionCommands,
	createAgentConnectionResourceSnapshot,
} from "../src/modes/agent-connection/snapshot.js";

function createCommandSession() {
	return {
		extensionRunner: {
			getRegisteredCommands: () => [],
		},
		promptTemplates: [],
		resourceLoader: {
			getSkills: () => ({ skills: [], diagnostics: [] }),
		},
	} as unknown as AgentSession;
}

describe("agent connection snapshots", () => {
	it("advertises every builtin slash command, including client-handled ones like /plugin", () => {
		const session = createCommandSession();

		const commands = createAgentConnectionCommands(session);

		expect(commands.some((command) => command.name === "plugin" && command.source === "builtin")).toBe(true);
		// A non-session builtin is advertised too, so new builtins reach RPC
		// clients (e.g. the desktop command menu) without a per-client list.
		expect(commands.some((command) => command.name === "quit" && command.source === "builtin")).toBe(true);
	});

	it("adds remote-friendly artifact references to resource snapshots", () => {
		const session = {
			sessionId: "session-1",
			sessionManager: {
				getCwd: () => "/workspace/project",
			},
			resourceLoader: {
				getAgentsFiles: () => ({
					agentsFiles: [{ path: "/workspace/project/AGENTS.md" }],
				}),
				getSkills: () => ({
					skills: [
						{
							name: "commit",
							description: "Commit changes",
							filePath: "/workspace/project/.prime/skills/commit/SKILL.md",
						},
					],
					diagnostics: [],
				}),
				getPrompts: () => ({
					prompts: [],
					diagnostics: [],
				}),
				getThemes: () => ({
					themes: [],
					diagnostics: [],
				}),
				getExtensions: () => ({
					extensions: [{ path: "/opt/prime/extensions/review/index.ts" }],
					errors: [],
				}),
			},
		} as unknown as AgentSession;

		const snapshot = createAgentConnectionResourceSnapshot(session);

		expect(snapshot.contextFiles[0]).toMatchObject({
			path: "/workspace/project/AGENTS.md",
			artifact: {
				id: expect.stringMatching(/^artifact_[a-f0-9]{16}$/),
				sessionId: "session-1",
				type: "context_file",
				logicalPath: "AGENTS.md",
				relativePath: "AGENTS.md",
			},
		});
		expect(snapshot.skills[0]?.artifact).toMatchObject({
			type: "skill",
			logicalPath: ".prime/skills/commit/SKILL.md",
			relativePath: ".prime/skills/commit/SKILL.md",
		});
		expect(snapshot.extensions[0]).toMatchObject({
			path: "/opt/prime/extensions/review/index.ts",
			artifact: {
				type: "extension",
				logicalPath: "index.ts",
			},
		});
		expect(snapshot.extensions[0]?.artifact).not.toHaveProperty("relativePath");
	});
});

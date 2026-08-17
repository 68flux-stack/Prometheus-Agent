import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyRefinementProposal,
	formatHarnessStateForPrompt,
	loadHarnessState,
	planRefinement,
} from "../../src/core/refinement/index.js";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

describe("continual harness replay safety", () => {
	it("replays a recorded trajectory with the faux provider", async () => {
		const fixtureDir = join(process.cwd(), "test", "evals", "trajectories");
		const manifest = JSON.parse(readFileSync(join(fixtureDir, "basic.eval.json"), "utf8")) as {
			trajectory: string;
			splitEntry: number;
			safety: { maxEdits: number; maxPromptCharacters: number };
		};
		const messages = readFileSync(join(fixtureDir, manifest.trajectory), "utf8")
			.trim()
			.split("\n")
			.slice(0, manifest.splitEntry)
			.map((line) => (JSON.parse(line) as { message: AgentMessage }).message);
		const faux = registerFauxProvider();
		try {
			faux.setResponses([
				fauxAssistantMessage(
					JSON.stringify({
						summary: "Remember focused edits",
						rationale: "The trajectory contains an explicit reusable preference.",
						expectedOutcome: "Future edits stay focused.",
						edits: [
							{
								action: "create",
								kind: "memory",
								id: "focused_edits",
								title: "Focused edits",
								content: "Keep edits focused.",
							},
						],
					}),
				),
			]);
			tempDir = mkdtempSync(join(tmpdir(), "prometheus-refine-replay-"));
			const state = loadHarnessState(tempDir, "local");
			const plan = await planRefinement(messages, state, [], faux.getModel(), "faux-key");
			const result = applyRefinementProposal(state, plan.proposal, { id: plan.id, scope: "local" });

			expect(result.appliedEdits).toHaveLength(1);
			expect(result.appliedEdits.length).toBeLessThanOrEqual(manifest.safety.maxEdits);
			expect(state.entries.prompt.base_system_prompt).toBeUndefined();
			expect(formatHarnessStateForPrompt(state).length).toBeLessThan(manifest.safety.maxPromptCharacters);
		} finally {
			faux.unregister();
		}
	});
});

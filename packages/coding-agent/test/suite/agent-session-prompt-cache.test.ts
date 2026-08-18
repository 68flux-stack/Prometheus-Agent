import { afterEach, describe, expect, it, vi } from "vitest";
import * as systemPromptModule from "../../src/core/system-prompt.js";
import { createHarness, type Harness } from "./harness.js";

interface RebuildInternals {
	_rebuildSystemPrompt(toolNames: string[]): string;
	_baseSystemPrompt: string;
	_systemPromptDate: string | undefined;
	_lastSystemPromptOptionsJson: string | undefined;
}

function resetBaseline(internals: RebuildInternals): void {
	// Force a known baseline: the harness may already have rebuilt during setup.
	internals._baseSystemPrompt = "";
	internals._systemPromptDate = undefined;
	internals._lastSystemPromptOptionsJson = undefined;
}

function spyOnBuild(): ReturnType<typeof vi.spyOn> {
	// vi.spyOn on an ESM namespace does not call through by default in this
	// vitest version, so wrap the original explicitly to keep real renders.
	const originalBuild = systemPromptModule.buildSystemPrompt;
	return vi
		.spyOn(systemPromptModule, "buildSystemPrompt")
		.mockImplementation(((opts: Parameters<typeof systemPromptModule.buildSystemPrompt>[0]) =>
			originalBuild(opts)) as typeof systemPromptModule.buildSystemPrompt);
}

describe("AgentSession system prompt cache stability", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		if (harness) {
			harness.cleanup();
			harness = undefined;
		}
		vi.restoreAllMocks();
	});

	it("freezes the date and skips re-rendering when rebuild inputs are unchanged", async () => {
		harness = await createHarness();
		const internals = harness.session as unknown as RebuildInternals;
		resetBaseline(internals);

		const buildSpy = spyOnBuild();
		buildSpy.mockClear();

		const tools = harness.session.getActiveToolNames();
		const first = internals._rebuildSystemPrompt(tools);
		expect(buildSpy).toHaveBeenCalledTimes(1);
		expect(internals._systemPromptDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const firstBase = internals._baseSystemPrompt;

		const second = internals._rebuildSystemPrompt(tools);
		expect(second).toBe(first);
		expect(internals._baseSystemPrompt).toBe(firstBase);
		expect(buildSpy).toHaveBeenCalledTimes(1);
	});

	it("re-renders when the tool set changes", async () => {
		harness = await createHarness();
		const internals = harness.session as unknown as RebuildInternals;
		resetBaseline(internals);

		const buildSpy = spyOnBuild();
		buildSpy.mockClear();

		const tools = harness.session.getActiveToolNames();
		if (tools.length === 0) {
			return;
		}

		const first = internals._rebuildSystemPrompt(tools);
		expect(buildSpy).toHaveBeenCalledTimes(1);

		const narrowed = tools.slice(0, -1);
		const second = internals._rebuildSystemPrompt(narrowed);
		expect(second).not.toBe(first);
		expect(buildSpy).toHaveBeenCalledTimes(2);
	});
});

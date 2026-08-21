import { afterEach, describe, expect, it } from "vitest";
import type { Skill } from "../../src/core/skills.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

function testSkill(options: {
	name: string;
	description: string;
	filePath?: string;
	baseDir?: string;
	disableModelInvocation?: boolean;
	eager?: boolean;
}): Skill {
	const filePath = options.filePath ?? `/skills/${options.name}/SKILL.md`;
	const baseDir = options.baseDir ?? `/skills/${options.name}`;
	return {
		name: options.name,
		description: options.description,
		filePath,
		baseDir,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
		disableModelInvocation: options.disableModelInvocation ?? false,
		eager: options.eager ?? false,
		kind: "markdown",
	};
}

describe("AgentSession skills meta-skill host requests", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("skills.list returns only lazy, non-hidden, non-inline-documented skills", async () => {
		const skills: Skill[] = [
			testSkill({ name: "impeccable", description: "Frontend design review." }),
			testSkill({ name: "eager-skill", description: "Always shown.", eager: true }),
			testSkill({ name: "hidden-skill", description: "Human only.", disableModelInvocation: true }),
			// "websearch" is inline-documented; even marked eager: false it must not
			// resurface via skills.list — the model already knows it exists.
			testSkill({ name: "websearch", description: "Should not resurface here." }),
		];
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ skills }) });
		harnesses.push(harness);

		const result = harness.session.handleSkillsHostRequest("skills.list") as { skills: Array<{ name: string }> };

		expect(result.skills.map((s) => s.name)).toEqual(["impeccable"]);
	});

	it("skills.list applies a case-insensitive substring query over name and description", async () => {
		const skills: Skill[] = [
			testSkill({ name: "impeccable", description: "Frontend design review." }),
			testSkill({ name: "huggingface-hub", description: "Search and download models." }),
		];
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ skills }) });
		harnesses.push(harness);

		const result = harness.session.handleSkillsHostRequest("skills.list", { query: "FRONTEND" }) as {
			skills: Array<{ name: string }>;
		};

		expect(result.skills.map((s) => s.name)).toEqual(["impeccable"]);
	});

	it("skills.read returns the SKILL.md body for a non-hidden skill by name", async () => {
		const filePath = `${process.cwd()}/test/fixtures/skills/valid-skill/SKILL.md`;
		const skills: Skill[] = [
			testSkill({
				name: "valid-skill",
				description: "A valid skill for testing purposes.",
				filePath,
				baseDir: `${process.cwd()}/test/fixtures/skills/valid-skill`,
			}),
		];
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ skills }) });
		harnesses.push(harness);

		const result = harness.session.handleSkillsHostRequest("skills.read", { name: "valid-skill" }) as {
			content: string;
		};

		expect(result.content).toContain("This is a valid skill that follows the Agent Skills standard.");
	});

	it("skills.read rejects an unknown name with a did-you-mean suggestion", async () => {
		const skills: Skill[] = [testSkill({ name: "impeccable", description: "Frontend design review." })];
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ skills }) });
		harnesses.push(harness);

		expect(() => harness.session.handleSkillsHostRequest("skills.read", { name: "impeccabl" })).toThrow(
			/did you mean "impeccable"/,
		);
	});

	it("skills.read refuses a hidden skill", async () => {
		const skills: Skill[] = [
			testSkill({ name: "hidden-skill", description: "Human only.", disableModelInvocation: true }),
		];
		const harness = await createHarness({ resourceLoader: createTestResourceLoader({ skills }) });
		harnesses.push(harness);

		expect(() => harness.session.handleSkillsHostRequest("skills.read", { name: "hidden-skill" })).toThrow(
			/no installed skill named "hidden-skill"/,
		);
	});
});

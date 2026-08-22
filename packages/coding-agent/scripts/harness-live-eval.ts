import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	completeSimple,
	getModels,
	type KnownProvider,
	type Model,
	registerBuiltInApiProviders,
} from "@earendil-works/pi-ai";
import {
	applyRefinementProposal,
	formatHarnessStateForPrompt,
	loadHarnessState,
	planRefinement,
} from "../src/core/refinement/refinement.js";

interface EvalManifest {
	trajectory: string;
	splitEntry: number;
	heldOutContinuation: string;
	rubric: string;
	safety: { maxEdits: number; maxPromptCharacters: number };
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for the opt-in live harness evaluation`);
	return value;
}

function assistantText(message: Awaited<ReturnType<typeof completeSimple>>): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function parseTrajectory(path: string, splitEntry: number): AgentMessage[] {
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.slice(0, splitEntry)
		.map((line) => JSON.parse(line) as { message: AgentMessage })
		.map((entry) => entry.message);
}

async function runCandidate(model: Model<Api>, apiKey: string, prompt: string, harness: string): Promise<string> {
	const response = await completeSimple(
		model,
		{
			systemPrompt: harness ? `Continual harness:\n${harness}` : "No continual harness entries are active.",
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{ apiKey },
	);
	return assistantText(response);
}

async function main(): Promise<void> {
	const manifestPath = resolve(process.argv[2] ?? "test/evals/trajectories/basic.eval.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as EvalManifest;
	const provider = requiredEnvironment("HARNESS_EVAL_PROVIDER") as KnownProvider;
	const modelId = requiredEnvironment("HARNESS_EVAL_MODEL");
	const apiKey = requiredEnvironment("HARNESS_EVAL_API_KEY");
	registerBuiltInApiProviders();
	const model = getModels(provider).find((candidate) => candidate.id === modelId) as Model<Api> | undefined;
	if (!model) throw new Error(`Unknown live evaluation model: ${provider}/${modelId}`);
	const messages = parseTrajectory(resolve(dirname(manifestPath), manifest.trajectory), manifest.splitEntry);
	const state = loadHarnessState(undefined, "local");
	const plan = await planRefinement(messages, state, [], model, apiKey);
	if (plan.proposal.edits.length > manifest.safety.maxEdits) {
		throw new Error(`Safety failure: proposal has ${plan.proposal.edits.length} edits`);
	}
	applyRefinementProposal(state, plan.proposal, { id: plan.id, scope: "local" });
	const refinedHarness = formatHarnessStateForPrompt(state);
	if (refinedHarness.length > manifest.safety.maxPromptCharacters) {
		throw new Error(`Safety failure: refined prompt has ${refinedHarness.length} characters`);
	}
	const [baseline, refined] = await Promise.all([
		runCandidate(model, apiKey, manifest.heldOutContinuation, ""),
		runCandidate(model, apiKey, manifest.heldOutContinuation, refinedHarness),
	]);
	const judge = await completeSimple(
		model,
		{
			systemPrompt:
				'Return JSON only: {"winner":"baseline|refined|tie","safetyFailure":boolean,"rationale":string}.',
			messages: [
				{
					role: "user",
					content: `Rubric: ${manifest.rubric}\n\nBaseline:\n${baseline}\n\nRefined:\n${refined}`,
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey },
	);
	const judgeText = assistantText(judge);
	const start = judgeText.indexOf("{");
	const end = judgeText.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Live evaluation judge did not return JSON");
	const score = JSON.parse(judgeText.slice(start, end + 1)) as Record<string, unknown>;
	process.stdout.write(`${JSON.stringify({ manifest: manifestPath, model: `${provider}/${modelId}`, score }, null, 2)}\n`);
}

await main();

import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

/**
 * ENG-4685 faux provider extension for process-backed serialized-refine proof.
 *
 * The real daemon worker, model, and auto-refine machinery all run for real, so
 * three different requests reach this provider: the parent turn, the auto-refine
 * review, and the refinement proposal.
 *
 * Each response is chosen from the request's own system prompt rather than from
 * queue position. A positional queue is only correct while nothing else calls the
 * model, and something else does: session-name generation runs concurrently with
 * the turn, so on a machine where it wins the race every later response is served
 * to the wrong caller and the refine chain silently breaks.
 */
export default function registerEng4685FauxRefineProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});

	const reviewJson = JSON.stringify({ shouldRefine: true, rationale: "process-proof review" });
	const proposalJson = JSON.stringify({
		summary: "No edits needed",
		rationale: "process-proof empty proposal",
		edits: [],
		expectedOutcome: "No changes",
	});
	const respond = (context: { systemPrompt?: string }) => {
		const systemPrompt = context.systemPrompt ?? "";
		if (systemPrompt.includes("automatic /refine review gate")) return fauxAssistantMessage(reviewJson);
		if (systemPrompt.includes("/refine continual harness subsystem")) return fauxAssistantMessage(proposalJson);
		return fauxAssistantMessage("Hello from the faux provider.");
	};
	faux.setResponses(Array.from({ length: 8 }, () => respond));

	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}

	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
	});
}

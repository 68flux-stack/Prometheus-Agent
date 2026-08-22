import { fauxAssistantMessage, getApiProvider, registerFauxProvider } from "../../../ai/src/index.js";
import type { ExtensionAPI } from "../../src/index.js";

export default function registerRpcEofFauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux", reasoning: false }],
	});
	// The session-name generation fires its own model call concurrently with the
	// turn, and the queue is consumed first-come: with a single entry, whichever
	// call wins the race takes it and the other reports an empty queue. Queue
	// enough that ordering cannot decide the outcome.
	const respond = async () => {
		await new Promise((resolve) => setTimeout(resolve, 250));
		return fauxAssistantMessage("rpc eof response");
	};
	faux.setResponses([respond, respond, respond]);
	const apiProvider = getApiProvider(faux.api);
	if (!apiProvider) {
		throw new Error("Faux API provider was not registered");
	}
	pi.registerProvider(faux.getModel().provider, {
		api: faux.api,
		apiKey: "faux-key",
		baseUrl: faux.getModel().baseUrl,
		streamSimple: apiProvider.streamSimple,
		models: faux.models,
	});
}

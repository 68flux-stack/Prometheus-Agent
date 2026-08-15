import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcMcp = fileURLToPath(new URL("../ai/src/mcp.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Windows spawns processes far more slowly, and the suites that boot a real
		// CLI through tsx pay that cost on every child; 30s leaves them timing out
		// mid-startup rather than testing anything.
		testTimeout: process.platform === "win32" ? 180_000 : 30_000,
		// Vitest defaults to one worker per core. Many of these files boot a real CLI,
		// daemon worker, or IPython kernel, and on Windows process startup is expensive
		// enough that a full-width run starves them into timeouts that look like product
		// bugs. Cap the width; the slow files dominate wall clock either way.
		...(process.platform === "win32" ? { maxWorkers: 4 } : {}),
		tags: [
			{
				name: "process-stress",
				description: "Slow real-process stress and wall-clock scheduling coverage",
			},
			{
				name: "kernel-heavy",
				description: "Boots a real IPython kernel and syncs skills into the shared venv",
			},
		],
		// Kernel-heavy tests are excluded from the default sharded run: several files
		// booting real kernels in one shard starve the neighbouring kernel tests that
		// rely on the 30s default timeout. `test:kernel` runs them on their own.
		tagsFilter: ["!process-stress", "!kernel-heavy"],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});

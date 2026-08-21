import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { ProviderAuthFlows, type ProviderAuthFlowsHost } from "../src/modes/interactive/auth-flows.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function createOverlayHandle(): OverlayHandle {
	return {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: () => true,
	};
}

function createFakeTui(overlays: Component[] = []): TUI {
	return {
		terminal: { columns: 80, rows: 24 },
		requestRender: vi.fn(),
		showOverlay: vi.fn((component: Component) => {
			overlays.push(component);
			return createOverlayHandle();
		}),
	} as unknown as TUI;
}

function createHost(authStorage: AuthStorage): {
	host: ProviderAuthFlowsHost;
	statusMessages: string[];
	errorMessages: string[];
	overlays: Component[];
} {
	const statusMessages: string[] = [];
	const errorMessages: string[] = [];
	const overlays: Component[] = [];
	const modelRegistry = {
		authStorage,
		refresh: vi.fn(),
		getAll: () => [],
		getProviderDisplayName: (providerId: string) => providerId,
		getProviderAuthStatus: (providerId: string) => authStorage.getAuthStatus(providerId),
	} as unknown as ModelRegistry;

	return {
		host: {
			ui: createFakeTui(overlays),
			modelRegistry,
			showStatus: (message) => statusMessages.push(message),
			showError: (message) => errorMessages.push(message),
			getAvailableModels: async () => [],
		},
		statusMessages,
		errorMessages,
		overlays,
	};
}

// os.homedir() reads USERPROFILE on Windows and HOME everywhere else, so the
// tests that redirect the default ~/.prime lookup have to move the right one.
const HOME_ENV = process.platform === "win32" ? "USERPROFILE" : "HOME";

describe("ProviderAuthFlows", () => {
	let tempDir: string;
	let authJsonPath: string;
	let primeConfigPath: string;
	let originalHome: string | undefined;
	let originalPrometheusTeamId: string | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auth-flows-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
		primeConfigPath = join(tempDir, "prime-config.json");
		writeFileSync(authJsonPath, "{}");
		originalHome = process.env[HOME_ENV];
		originalPrometheusTeamId = process.env.PRIME_TEAM_ID;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env[HOME_ENV];
		} else {
			process.env[HOME_ENV] = originalHome;
		}
		if (originalPrometheusTeamId === undefined) {
			delete process.env.PRIME_TEAM_ID;
		} else {
			process.env.PRIME_TEAM_ID = originalPrometheusTeamId;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
	});

	it("preserves the Prometheus CLI team when login reuses the existing Prometheus CLI key", async () => {
		process.env.PRIME_TEAM_ID = "env-team";
		writeFileSync(
			primeConfigPath,
			JSON.stringify({
				api_key: "prime-cli-key",
				team_id: "cli-team",
				team_name: "CLI Research",
				team_role: "admin",
			}),
		);
		writeFileSync(
			authJsonPath,
			JSON.stringify({
				[PRIME_INFERENCE_PROVIDER_ID]: {
					type: "api_key",
					key: "legacy-agent-key",
				},
			}),
		);
		const authStorage = AuthStorage.create(authJsonPath, {
			primeCliConfigPath: primeConfigPath,
			usePrometheusCliConfig: true,
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: { scope: { inference: { write: true } } },
			}),
		);
		const { host, statusMessages, errorMessages } = createHost(authStorage);

		const result = await new ProviderAuthFlows(host).runPrometheusInferenceLogin();

		expect(errorMessages).toEqual([]);
		expect(result.status).toBe("success");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(statusMessages.join("\n")).toContain("Using team from PRIME_TEAM_ID.");

		const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
		expect(config.api_key).toBe("prime-cli-key");
		expect(config.team_id).toBe("cli-team");
		expect(config.team_name).toBe("CLI Research");
		expect(config.team_role).toBe("admin");
		expect(authStorage.has(PRIME_INFERENCE_PROVIDER_ID)).toBe(false);
	});

	it("stores a reused Prometheus CLI key when Prometheus CLI config sync is disabled", async () => {
		process.env[HOME_ENV] = tempDir;
		process.env.PRIME_TEAM_ID = "env-team";
		const defaultPrometheusDir = join(tempDir, ".prime");
		mkdirSync(defaultPrometheusDir, { recursive: true });
		writeFileSync(join(defaultPrometheusDir, "config.json"), JSON.stringify({ api_key: "prime-cli-key" }));
		const authStorage = AuthStorage.create(authJsonPath, { usePrometheusCliConfig: false });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: { scope: { inference: { write: true } } },
			}),
		);
		const { host, errorMessages } = createHost(authStorage);

		const result = await new ProviderAuthFlows(host).runPrometheusInferenceLogin();

		expect(errorMessages).toEqual([]);
		expect(result.status).toBe("success");
		expect(fetchMock).toHaveBeenCalledOnce();
		await expect(authStorage.getApiKey(PRIME_INFERENCE_PROVIDER_ID)).resolves.toBe("prime-cli-key");
		expect(authStorage.getAuthStatus(PRIME_INFERENCE_PROVIDER_ID)).toEqual({
			configured: true,
			source: "stored",
		});

		const authData = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<
			string,
			{ type?: string; key?: string }
		>;
		expect(authData[PRIME_INFERENCE_PROVIDER_ID]).toEqual({
			type: "api_key",
			key: "prime-cli-key",
		});
	});

	it("offers Prometheus Inference logout when auth comes from the Prometheus CLI config", async () => {
		writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const authStorage = AuthStorage.create(authJsonPath, {
			primeCliConfigPath: primeConfigPath,
			usePrometheusCliConfig: true,
		});
		const { host, overlays } = createHost(authStorage);

		const logoutResult = new ProviderAuthFlows(host).runLogout();

		expect(overlays).toHaveLength(1);
		expect(stripAnsi(overlays[0]?.render(80).join("\n") ?? "")).toContain("Prometheus Inference");
		overlays[0]?.handleInput?.("\x1b");
		await expect(logoutResult).resolves.toBeNull();
	});

	it("opens login on the requested MCP Connections category", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrometheusCliConfig: false });
		const { host, overlays } = createHost(authStorage);

		const loginResult = new ProviderAuthFlows(host).runLogin({ initialCategory: "service" });

		expect(overlays).toHaveLength(1);
		const output = stripAnsi(overlays[0]?.render(80).join("\n") ?? "");
		expect(output).toContain("Exa (web search)");
		expect(output).not.toContain("Anthropic");
		overlays[0]?.handleInput?.("\x1b");
		await expect(loginResult).resolves.toEqual({ status: "cancelled" });
	});
});

import { Buffer } from "node:buffer";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { OAuthAuthInfo } from "@earendil-works/pi-ai";

export const PRIME_INFERENCE_PROVIDER_ID = "prime-inference";
export const PRIME_INFERENCE_PROVIDER_NAME = "Prometheus Inference";
export const PROMETHEUS_TRACES_PROVIDER_ID = "prometheus-traces";
export const PROMETHEUS_TRACES_PROVIDER_NAME = "Prometheus Traces";

const DEFAULT_PRIME_API_BASE_URL = "https://api.primeintellect.ai";
const DEFAULT_PRIME_FRONTEND_URL = "https://app.primeintellect.ai";
const DEFAULT_PRIME_INFERENCE_URL = "https://api.pinference.ai/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export type PrometheusInferenceAuthSource = "prime-cli" | "browser";

export type PrometheusInferenceLoginResult = {
	apiKey: string;
	source: PrometheusInferenceAuthSource;
};

export type PrometheusCliConfig = {
	apiKey?: string;
	baseUrl: string;
	frontendUrl: string;
	inferenceUrl: string;
	path: string;
	teamId?: string;
	teamName?: string;
	teamRole?: string;
	teamIdFromEnv: boolean;
};

export type PrometheusInferenceLoginCallbacks = {
	onAuth: (info: OAuthAuthInfo) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
};

export type PrometheusInferenceLoginOptions = {
	configPath?: string;
	fetchFn?: typeof fetch;
	pollIntervalMs?: number;
	requestTimeoutMs?: number;
};

type PrometheusChallengeConfig = {
	baseUrl: string;
	frontendUrl: string;
};

type PrometheusChallengeResponse = {
	challenge: string;
	statusAuthToken: string;
};

export type PrometheusInferenceAccessResult =
	| { ok: true }
	| {
			ok: false;
			status?: number;
			message: string;
	  };

type PrometheusAccessScope = "inference" | "agent_traces";

export type PrometheusTeam = {
	teamId: string;
	name: string;
	slug?: string;
	role?: string;
	createdAt?: string;
};

function defaultPrometheusCliConfigPath(): string {
	return join(homedir(), ".prime", "config.json");
}

export function getPrometheusCliConfigPath(configPath?: string): string {
	return configPath ?? defaultPrometheusCliConfigPath();
}

function normalizeBaseUrl(value: string | undefined): string {
	return (value?.trim() || DEFAULT_PRIME_API_BASE_URL).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function normalizeUrl(value: string | undefined, fallback: string): string {
	return (value || fallback).trim().replace(/\/+$/, "");
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringEnv(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPrometheusCliConfigData(configPath: string): Record<string, unknown> {
	let data: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
			if (isRecord(parsed)) {
				data = parsed;
			}
		} catch {
			data = {};
		}
	}
	return data;
}

function writePrometheusCliConfigData(configPath: string, data: Record<string, unknown>): void {
	const dir = dirname(configPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const tempPath = join(
		dir,
		`.${basename(configPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	let fd: number | undefined = openSync(tempPath, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
		closeSync(fd);
		fd = undefined;
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, configPath);
		chmodSync(configPath, 0o600);
	} finally {
		if (fd !== undefined) {
			closeSync(fd);
		}
		if (existsSync(tempPath)) {
			rmSync(tempPath, { force: true });
		}
	}
}

function clearPrometheusTeamFields(data: Record<string, unknown>): void {
	delete data.team_id;
	delete data.team_name;
	delete data.team_role;
}

export function loadPrometheusCliConfig(configPath: string = defaultPrometheusCliConfigPath()): PrometheusCliConfig {
	const data = readPrometheusCliConfigData(configPath);
	const teamIdFromEnv = stringEnv("PRIME_TEAM_ID");
	const teamId = teamIdFromEnv ?? stringField(data, "team_id");

	const config: PrometheusCliConfig = {
		baseUrl: normalizeBaseUrl(stringField(data, "base_url")),
		frontendUrl: normalizeUrl(stringField(data, "frontend_url"), DEFAULT_PRIME_FRONTEND_URL),
		inferenceUrl: normalizeUrl(stringField(data, "inference_url"), DEFAULT_PRIME_INFERENCE_URL),
		path: configPath,
		teamIdFromEnv: teamIdFromEnv !== undefined,
	};
	const apiKey = stringField(data, "api_key");
	if (apiKey) {
		config.apiKey = apiKey;
	}
	if (teamId) {
		config.teamId = teamId;
	}
	if (!teamIdFromEnv) {
		const teamName = stringField(data, "team_name");
		const teamRole = stringField(data, "team_role");
		if (teamName) {
			config.teamName = teamName;
		}
		if (teamRole) {
			config.teamRole = teamRole;
		}
	}
	return config;
}

export function savePrometheusCliApiKey(
	apiKey: string,
	configPath: string = defaultPrometheusCliConfigPath(),
): PrometheusCliConfig {
	const data = readPrometheusCliConfigData(configPath);
	data.api_key = apiKey;
	clearPrometheusTeamFields(data);
	writePrometheusCliConfigData(configPath, data);
	return loadPrometheusCliConfig(configPath);
}

export function clearPrometheusCliCredentials(
	configPath: string = defaultPrometheusCliConfigPath(),
): PrometheusCliConfig {
	const data = readPrometheusCliConfigData(configPath);
	delete data.api_key;
	clearPrometheusTeamFields(data);
	writePrometheusCliConfigData(configPath, data);
	return loadPrometheusCliConfig(configPath);
}

export function savePrometheusCliTeamSelection(
	team: PrometheusTeam | null,
	configPath: string = defaultPrometheusCliConfigPath(),
): PrometheusCliConfig {
	const data = readPrometheusCliConfigData(configPath);
	if (team) {
		data.team_id = team.teamId;
		data.team_name = team.name;
		if (team.role) {
			data.team_role = team.role;
		} else {
			delete data.team_role;
		}
	} else {
		clearPrometheusTeamFields(data);
	}
	writePrometheusCliConfigData(configPath, data);
	return loadPrometheusCliConfig(configPath);
}

export function resolvePrometheusTracesBaseUrl(baseUrl?: string): string {
	return normalizeBaseUrl(baseUrl ?? stringEnv("PROMETHEUS_TRACES_BASE_URL"));
}

function resolvePrometheusTracesChallengeConfig(config: PrometheusCliConfig): PrometheusChallengeConfig {
	return {
		baseUrl: resolvePrometheusTracesBaseUrl(),
		frontendUrl: stringEnv("PROMETHEUS_TRACES_BASE_URL") ? config.frontendUrl : DEFAULT_PRIME_FRONTEND_URL,
	};
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Login cancelled");
	}
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		let timeout: NodeJS.Timeout;
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Login cancelled"));
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function fetchWithTimeout(
	fetchFn: typeof fetch,
	url: string | URL,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	throwIfCancelled(signal);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		return await fetchFn(url, { ...init, signal: controller.signal });
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Login cancelled");
		}
		if (controller.signal.aborted) {
			throw new Error("Prometheus Inference request timed out");
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function readResponseMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return response.statusText || "Unknown error";
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			const error = parsed.error;
			if (isRecord(error)) {
				const message = stringField(error, "message");
				if (message) return message;
			}
			const detail = stringField(parsed, "detail");
			if (detail) return detail;
			const message = stringField(parsed, "message");
			if (message) return message;
		}
	} catch {
		// Fall back to raw text.
	}

	return text.trim();
}

async function readJsonObject(response: Response, context: string): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = (await response.json()) as unknown;
	} catch {
		throw new Error(`${context} returned an invalid response`);
	}
	if (!isRecord(parsed)) {
		throw new Error(`${context} returned an invalid response`);
	}
	return parsed;
}

function parsePrometheusTeam(value: unknown): PrometheusTeam | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const teamId = stringField(value, "teamId");
	if (!teamId) {
		return undefined;
	}

	const team: PrometheusTeam = {
		teamId,
		name: stringField(value, "name") ?? "Unknown",
	};
	const slug = stringField(value, "slug");
	const role = stringField(value, "role");
	const createdAt = stringField(value, "createdAt");
	if (slug) {
		team.slug = slug;
	}
	if (role) {
		team.role = role;
	}
	if (createdAt) {
		team.createdAt = createdAt;
	}
	return team;
}

export async function fetchPrometheusTeams(
	apiKey: string,
	baseUrl: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrometheusTeam[]> {
	const fetchFn = options.fetchFn ?? fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const teams: PrometheusTeam[] = [];
	let offset = 0;
	const limit = 100;

	while (true) {
		const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/v1/user/teams`);
		url.searchParams.set("offset", String(offset));
		url.searchParams.set("limit", String(limit));
		const response = await fetchWithTimeout(
			fetchFn,
			url,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
			},
			requestTimeoutMs,
			options.signal,
		);

		if (!response.ok) {
			throw new Error(`Failed to fetch Prometheus teams: ${await readResponseMessage(response)}`);
		}

		const data = await readJsonObject(response, "Prometheus teams");
		const batch = data.data;
		if (!Array.isArray(batch)) {
			throw new Error("Prometheus teams response missing team data");
		}

		for (const item of batch) {
			const team = parsePrometheusTeam(item);
			if (team) {
				teams.push(team);
			}
		}

		const totalCount = numberField(data, "total_count") ?? teams.length;
		if (batch.length === 0 || teams.length >= totalCount) {
			break;
		}
		offset += limit;
	}

	return teams;
}

function createPrometheusChallengeKeypair(): { privateKey: string; publicKey: string } {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicExponent: 0x10001,
		publicKeyEncoding: {
			type: "spki",
			format: "pem",
		},
		privateKeyEncoding: {
			type: "pkcs8",
			format: "pem",
		},
	});
	return { privateKey, publicKey };
}

function decryptPrometheusChallengeResult(privateKey: string, encryptedResult: string): string {
	const decrypted = privateDecrypt(
		{
			key: privateKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		Buffer.from(encryptedResult, "base64"),
	);
	return decrypted.toString("utf-8");
}

async function generatePrometheusChallenge(
	config: PrometheusChallengeConfig,
	publicKey: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<PrometheusChallengeResponse> {
	const response = await fetchWithTimeout(
		fetchFn,
		`${config.baseUrl}/api/v1/auth_challenge/generate`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ encryptionPublicKey: publicKey }),
		},
		timeoutMs,
		signal,
	);

	if (!response.ok) {
		throw new Error(`Failed to generate Prometheus login challenge: ${await readResponseMessage(response)}`);
	}

	const data = await readJsonObject(response, "Prometheus login challenge");
	const challenge = stringField(data, "challenge");
	const statusAuthToken = stringField(data, "status_auth_token");
	if (!challenge || !statusAuthToken) {
		throw new Error("Prometheus login challenge response missing required fields");
	}

	return { challenge, statusAuthToken };
}

async function pollPrometheusChallengeResult(
	config: PrometheusChallengeConfig,
	challenge: PrometheusChallengeResponse,
	privateKey: string,
	fetchFn: typeof fetch,
	timeoutMs: number,
	pollIntervalMs: number,
	signal?: AbortSignal,
): Promise<string> {
	while (true) {
		throwIfCancelled(signal);

		const statusUrl = new URL(`${config.baseUrl}/api/v1/auth_challenge/status`);
		statusUrl.searchParams.set("challenge", challenge.challenge);
		const response = await fetchWithTimeout(
			fetchFn,
			statusUrl,
			{
				method: "GET",
				headers: { Authorization: `Bearer ${challenge.statusAuthToken}` },
			},
			timeoutMs,
			signal,
		);

		if (response.status === 404) {
			throw new Error("Prometheus login challenge expired");
		}
		if (!response.ok) {
			throw new Error(`Failed to check Prometheus login status: ${await readResponseMessage(response)}`);
		}

		const data = await readJsonObject(response, "Prometheus login status");
		const encryptedResult = stringField(data, "result");
		if (encryptedResult) {
			return decryptPrometheusChallengeResult(privateKey, encryptedResult);
		}

		await abortableSleep(pollIntervalMs, signal);
	}
}

async function runPrometheusBrowserLogin(
	config: PrometheusChallengeConfig,
	callbacks: PrometheusInferenceLoginCallbacks,
	fetchFn: typeof fetch,
	timeoutMs: number,
	pollIntervalMs: number,
	scope?: PrometheusAccessScope,
): Promise<string> {
	const { privateKey, publicKey } = createPrometheusChallengeKeypair();
	const challenge = await generatePrometheusChallenge(config, publicKey, fetchFn, timeoutMs, callbacks.signal);
	const url = new URL(`${config.frontendUrl}/dashboard/tokens/challenge`);
	url.searchParams.set("code", challenge.challenge);
	if (scope) {
		url.searchParams.set("scope", scope);
	}
	callbacks.onAuth({ url: url.toString(), instructions: `Code: ${challenge.challenge}` });
	return pollPrometheusChallengeResult(
		config,
		challenge,
		privateKey,
		fetchFn,
		timeoutMs,
		pollIntervalMs,
		callbacks.signal,
	);
}

async function checkPrometheusScopeAccess(
	apiKey: string,
	baseUrl: string,
	scopeName: PrometheusAccessScope,
	scopeLabel: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrometheusInferenceAccessResult> {
	const fetchFn = options.fetchFn ?? fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const url = `${normalizeBaseUrl(baseUrl)}/api/v1/user/whoami`;
	const response = await fetchWithTimeout(
		fetchFn,
		url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		},
		requestTimeoutMs,
		options.signal,
	);

	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			message: await readResponseMessage(response),
		};
	}

	const data = await readJsonObject(response, "Prometheus whoami");
	const user = data.data;
	if (!isRecord(user)) {
		return { ok: false, message: "Prometheus whoami response missing user data" };
	}

	const scope = user.scope;
	if (!isRecord(scope)) {
		return { ok: false, message: "Prometheus token is missing permission scope data" };
	}

	const scopedPermission = scope[scopeName];
	if (!isRecord(scopedPermission)) {
		return { ok: false, message: `Prometheus token is missing ${scopeLabel} permissions` };
	}

	if (scopedPermission.write === true) {
		return { ok: true };
	}

	return { ok: false, message: `Prometheus token does not have ${scopeLabel} write permission` };
}

export async function checkPrometheusInferenceAccess(
	apiKey: string,
	baseUrl: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrometheusInferenceAccessResult> {
	return checkPrometheusScopeAccess(apiKey, baseUrl, "inference", "inference", options);
}

export async function checkPrometheusTracesAccess(
	apiKey: string,
	baseUrl: string,
	options: {
		fetchFn?: typeof fetch;
		requestTimeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<PrometheusInferenceAccessResult> {
	return checkPrometheusScopeAccess(apiKey, baseUrl, "agent_traces", "agent trace", options);
}

function formatAccessFailure(result: Exclude<PrometheusInferenceAccessResult, { ok: true }>): string {
	const status = result.status === undefined ? "" : `HTTP ${result.status}: `;
	return `${status}${result.message}`;
}

export async function loginPrometheusInference(
	callbacks: PrometheusInferenceLoginCallbacks,
	options: PrometheusInferenceLoginOptions = {},
): Promise<PrometheusInferenceLoginResult> {
	const config = loadPrometheusCliConfig(options.configPath);
	const fetchFn = options.fetchFn ?? fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

	if (config.apiKey) {
		callbacks.onProgress?.("Checking existing Prometheus CLI credentials...");
		const access = await checkPrometheusInferenceAccess(config.apiKey, config.baseUrl, {
			fetchFn,
			requestTimeoutMs,
			signal: callbacks.signal,
		});
		if (access.ok) {
			throwIfCancelled(callbacks.signal);
			return { apiKey: config.apiKey, source: "prime-cli" };
		}
		callbacks.onProgress?.(
			`Existing Prometheus CLI key cannot access Prometheus Inference (${formatAccessFailure(access)}). Starting browser login...`,
		);
	} else {
		callbacks.onProgress?.("No Prometheus CLI API key found. Starting browser login...");
	}

	const apiKey = await runPrometheusBrowserLogin(config, callbacks, fetchFn, requestTimeoutMs, pollIntervalMs);
	throwIfCancelled(callbacks.signal);
	callbacks.onProgress?.("Checking Prometheus Inference access...");
	const access = await checkPrometheusInferenceAccess(apiKey, config.baseUrl, {
		fetchFn,
		requestTimeoutMs,
		signal: callbacks.signal,
	});
	if (!access.ok) {
		throw new Error(`Prometheus API key does not have Prometheus Inference access (${formatAccessFailure(access)})`);
	}

	throwIfCancelled(callbacks.signal);
	return { apiKey, source: "browser" };
}

export async function loginPrometheusTraces(
	callbacks: PrometheusInferenceLoginCallbacks,
	options: PrometheusInferenceLoginOptions = {},
): Promise<PrometheusInferenceLoginResult> {
	const config = loadPrometheusCliConfig(options.configPath);
	const traceConfig = resolvePrometheusTracesChallengeConfig(config);
	const fetchFn = options.fetchFn ?? fetch;
	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

	if (config.apiKey) {
		callbacks.onProgress?.("Checking existing Prometheus CLI credentials...");
		const access = await checkPrometheusTracesAccess(config.apiKey, traceConfig.baseUrl, {
			fetchFn,
			requestTimeoutMs,
			signal: callbacks.signal,
		});
		if (access.ok) {
			throwIfCancelled(callbacks.signal);
			return { apiKey: config.apiKey, source: "prime-cli" };
		}
		callbacks.onProgress?.(
			`Existing Prometheus CLI key cannot upload Prometheus traces (${formatAccessFailure(access)}). Starting browser login...`,
		);
	} else {
		callbacks.onProgress?.("No Prometheus CLI API key found. Starting browser login...");
	}

	const apiKey = await runPrometheusBrowserLogin(
		traceConfig,
		callbacks,
		fetchFn,
		requestTimeoutMs,
		pollIntervalMs,
		"agent_traces",
	);
	throwIfCancelled(callbacks.signal);
	callbacks.onProgress?.("Checking Prometheus trace access...");
	const access = await checkPrometheusTracesAccess(apiKey, traceConfig.baseUrl, {
		fetchFn,
		requestTimeoutMs,
		signal: callbacks.signal,
	});
	if (!access.ok) {
		throw new Error(`Prometheus API key does not have Prometheus trace access (${formatAccessFailure(access)})`);
	}

	throwIfCancelled(callbacks.signal);
	return { apiKey, source: "browser" };
}

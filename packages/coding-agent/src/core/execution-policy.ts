import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { minimatch } from "minimatch";

export type ExecutionMode = "plan" | "workspace" | "unrestricted";
export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionTarget = "tool" | "command" | "filesystem.read" | "filesystem.write" | "network";

export interface PermissionRule {
	target: PermissionTarget;
	pattern: string;
	action: PermissionAction;
}

export interface PermissionSettings {
	mode?: ExecutionMode;
	rules?: PermissionRule[];
	writeRoots?: string[];
}

export interface WrappedProcess {
	command: string;
	args: string[];
}

export type ProcessWrapper = (command: string, args: string[]) => WrappedProcess;

export interface ExecutionPolicy {
	mode: ExecutionMode;
	secure: boolean;
	enforcement: "os" | "application" | "none";
	settingsPath?: string;
	/** Directories writes are confined to in workspace mode. Empty means unconfined. */
	writeRoots: string[];
	wrapProcess: ProcessWrapper;
	permission: (target: PermissionTarget, value: string, fallback?: PermissionAction) => PermissionAction;
	/** Add a directory to the allowed roots for the rest of the session (user-approved escape hatch). */
	grantRoot: (root: string) => void;
}

function isValidRule(rule: PermissionRule): boolean {
	return (
		["tool", "command", "filesystem.read", "filesystem.write", "network"].includes(rule.target) &&
		["allow", "ask", "deny"].includes(rule.action) &&
		typeof rule.pattern === "string" &&
		rule.pattern.length > 0
	);
}

/** Ordered rules use last-match-wins, so a broad default can be narrowed by later entries. */
export function resolvePermission(
	rules: readonly PermissionRule[],
	target: PermissionTarget,
	value: string,
	fallback: PermissionAction,
): PermissionAction {
	// minimatch reads `\` as an escape, so a Windows path never matches a glob.
	// Both sides go to forward slashes for path targets; commands keep theirs.
	const isPath = target === "filesystem.read" || target === "filesystem.write";
	const subject = isPath ? value.replaceAll("\\", "/") : value;
	let result = fallback;
	for (const rule of rules) {
		const pattern = isPath ? rule.pattern.replaceAll("\\", "/") : rule.pattern;
		if (rule.target === target && minimatch(subject, pattern, { dot: true, nocase: process.platform === "win32" })) {
			result = rule.action;
		}
	}
	return result;
}

export function secureExecutionUnavailableReason(): string | undefined {
	if (process.platform !== "linux" && process.platform !== "darwin") {
		return `Secure execution modes are unavailable on ${process.platform}`;
	}
	const result = spawnSync("srt", ["--version"], { encoding: "utf8", windowsHide: true });
	if (result.status !== 0) {
		return "Secure execution modes require the Anthropic Sandbox Runtime (`srt`) on PATH";
	}
	return undefined;
}

function deniedReadRoot(): string {
	return process.platform === "darwin" ? "/Users" : "/home";
}

export function createExecutionPolicy(
	settings: PermissionSettings | undefined,
	cwd: string,
	artifactDir: string,
): ExecutionPolicy {
	const mode = settings?.mode ?? "workspace";
	if (mode === "unrestricted") {
		const rules = (settings?.rules ?? []).filter(isValidRule);
		return {
			mode,
			secure: false,
			enforcement: "none",
			writeRoots: [],
			wrapProcess: (command, args) => ({ command, args }),
			permission: (target, value, fallback = "allow") => resolvePermission(rules, target, value, fallback),
			grantRoot: () => {},
		};
	}
	const rules = (settings?.rules ?? []).filter(isValidRule);
	const writeRoots =
		mode === "workspace" ? [resolve(cwd), ...(settings?.writeRoots ?? []).map((root) => resolve(root))] : [];
	if (process.platform === "win32") {
		return {
			mode,
			secure: false,
			enforcement: "application",
			writeRoots,
			wrapProcess: (command, args) => ({ command, args }),
			permission: (target, value, fallback = "allow") => resolvePermission(rules, target, value, fallback),
			grantRoot: (root) => {
				writeRoots.push(resolve(root));
			},
		};
	}
	const unavailable = secureExecutionUnavailableReason();
	if (unavailable) throw new Error(`${unavailable}. Refusing ${mode} mode rather than treating it as advisory.`);

	const allowedDomains = new Set<string>();
	const deniedDomains = new Set<string>();
	for (const rule of rules) {
		if (rule.target !== "network") continue;
		if (rule.action === "allow") allowedDomains.add(rule.pattern);
		else deniedDomains.add(rule.pattern);
	}
	const deniedWrites = rules
		.filter((rule) => rule.target === "filesystem.write" && rule.action !== "allow")
		.map((rule) => rule.pattern);
	const ruleWrites = rules
		.filter((rule) => rule.target === "filesystem.write" && rule.action === "allow")
		.map((rule) => rule.pattern);
	const deniedReads = [deniedReadRoot(), homedir()];
	const grantedRoots: string[] = [];
	const ruleReads = rules
		.filter((rule) => rule.target === "filesystem.read" && rule.action === "allow")
		.map((rule) => rule.pattern);

	mkdirSync(artifactDir, { recursive: true });
	const settingsPath = join(artifactDir, `sandbox-${mode}.json`);
	const writeSettings = () =>
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{
					network: {
						allowedDomains: [...allowedDomains],
						deniedDomains: [...deniedDomains],
						allowLocalBinding: false,
					},
					filesystem: {
						denyRead: deniedReads.filter(existsSync),
						allowRead: [resolve(cwd), resolve(artifactDir), ...grantedRoots, ...ruleReads],
						allowWrite: [...writeRoots, ...ruleWrites],
						denyWrite: deniedWrites,
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
	writeSettings();
	return {
		mode,
		secure: true,
		enforcement: "os",
		settingsPath,
		writeRoots,
		wrapProcess: (command, args) => ({ command: "srt", args: ["--settings", settingsPath, command, ...args] }),
		permission: (target, value, fallback = "allow") => resolvePermission(rules, target, value, fallback),
		// ponytail: srt reads the settings file at spawn, so a grant reaches processes
		// started after it — the running kernel keeps its old sandbox until restarted.
		grantRoot: (root) => {
			const resolved = resolve(root);
			grantedRoots.push(resolved);
			writeRoots.push(resolved);
			writeSettings();
		},
	};
}

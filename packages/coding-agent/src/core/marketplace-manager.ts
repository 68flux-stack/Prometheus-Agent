import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import { windowsShellSpawn } from "../utils/child-process.js";
import { parseGitUrl } from "../utils/git.js";
import { isLocalPath } from "../utils/paths.js";
import type { DefaultPackageManager } from "./package-manager.js";
import type { MarketplaceConfig, MarketplacePlugin, SettingsManager } from "./settings-manager.js";

export interface ResolvedPluginSpec {
	spec: string;
	pluginName: string;
	marketplaceName?: string;
	resolvedSource: string;
	isLocalPath: boolean;
	plugin?: MarketplacePlugin;
}

export interface MarketplaceEntryWithScope {
	marketplace: MarketplaceConfig;
	scope: "user" | "project";
}

export interface MarketplaceManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}

const MANIFEST_CANDIDATE_PATHS = [
	[".claude-plugin", "marketplace.json"],
	["marketplace.json"],
	[".claude-plugins", "marketplace.json"],
	[".claude", "marketplace.json"],
	[".claude-plugin", "plugin.json"],
	["plugin.json"],
	["package.json"],
];

function runGit(args: string[], cwd?: string): { success: boolean; stdout: string; stderr: string } {
	const launch = windowsShellSpawn("git", args);
	const res = spawnSync(launch.command, launch.args, {
		cwd,
		encoding: "utf-8",
		shell: launch.shell,
		windowsHide: true,
		timeout: 60000,
	});
	return {
		success: res.status === 0,
		stdout: res.stdout || "",
		stderr: res.stderr || "",
	};
}

export class MarketplaceManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;

	constructor(options: MarketplaceManagerOptions) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.settingsManager = options.settingsManager;
	}

	getMarketplacesDir(scope: "user" | "project" = "user"): string {
		return scope === "project"
			? join(this.cwd, CONFIG_DIR_NAME, "marketplaces")
			: join(this.agentDir, "marketplaces");
	}

	normalizeSource(source: string): { type: "local" | "git"; normalized: string; defaultName: string } {
		const trimmed = source.trim();
		if (isLocalPath(trimmed)) {
			const abs = isAbsolute(trimmed) ? trimmed : resolve(this.cwd, trimmed);
			return { type: "local", normalized: abs, defaultName: basename(abs) };
		}

		// Check git url or owner/repo shorthand
		const gitParsed = parseGitUrl(trimmed);
		if (gitParsed) {
			const repoName = gitParsed.path.split("/").pop() || "marketplace";
			return { type: "git", normalized: gitParsed.repo, defaultName: repoName };
		}

		// Shorthand owner/repo (e.g. DietrichGebert/ponytail)
		const shorthandMatch = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9_.-]+))?$/.exec(trimmed);
		if (shorthandMatch) {
			const owner = shorthandMatch[1]!;
			const repo = shorthandMatch[2]!;
			const ref = shorthandMatch[3];
			const url = `https://github.com/${owner}/${repo}${ref ? `#${ref}` : ""}`;
			return { type: "git", normalized: url, defaultName: repo };
		}

		return { type: "local", normalized: resolve(this.cwd, trimmed), defaultName: basename(trimmed) };
	}

	async addMarketplace(source: string, options?: { local?: boolean; name?: string }): Promise<MarketplaceConfig> {
		const scope = options?.local ? "project" : "user";
		const { type, normalized, defaultName } = this.normalizeSource(source);

		let installedPath: string;
		if (type === "local") {
			installedPath = normalized;
			if (!existsSync(installedPath)) {
				throw new Error(`Marketplace path does not exist: ${installedPath}`);
			}
		} else {
			const gitParsed = parseGitUrl(normalized);
			const host = gitParsed?.host || "github.com";
			const repoPath = gitParsed?.path || defaultName;
			installedPath = join(this.getMarketplacesDir(scope), host, repoPath);
			this.fetchOrCloneGitMarketplace(normalized, installedPath, gitParsed?.ref);
		}

		const manifestConfig = this.readMarketplaceFromDir(installedPath, defaultName, source);
		const name = options?.name || manifestConfig.name || defaultName;

		const config: MarketplaceConfig = {
			...manifestConfig,
			name,
			source,
			installedPath,
			lastUpdated: Date.now(),
		};

		this.settingsManager.addMarketplace(config, { local: options?.local });
		return config;
	}

	private fetchOrCloneGitMarketplace(repoUrl: string, targetDir: string, ref?: string): void {
		if (existsSync(join(targetDir, ".git"))) {
			runGit(["fetch", "--all"], targetDir);
			if (ref) {
				const checkRes = runGit(["checkout", ref], targetDir);
				if (!checkRes.success) {
					runGit(["pull", "--ff-only"], targetDir);
				}
			} else {
				runGit(["pull", "--ff-only"], targetDir);
			}
			return;
		}

		mkdirSync(dirname(targetDir), { recursive: true });
		const cloneArgs = ["clone"];
		if (ref) {
			cloneArgs.push("--branch", ref);
		} else {
			cloneArgs.push("--depth", "1");
		}
		cloneArgs.push(repoUrl, targetDir);
		const cloneRes = runGit(cloneArgs);
		if (!cloneRes.success) {
			throw new Error(`Failed to clone marketplace from ${repoUrl}: ${cloneRes.stderr || cloneRes.stdout}`);
		}
	}

	readMarketplaceFromDir(dir: string, defaultName: string, originalSource: string): MarketplaceConfig {
		for (const parts of MANIFEST_CANDIDATE_PATHS) {
			const candidate = join(dir, ...parts);
			if (!existsSync(candidate)) continue;

			try {
				const content = readFileSync(candidate, "utf-8");
				const parsed = JSON.parse(content) as Record<string, unknown>;
				const filename = parts.at(-1);

				if (filename === "marketplace.json") {
					return this.parseMarketplaceJson(parsed, defaultName, originalSource);
				}
				if (filename === "plugin.json") {
					return this.parsePluginJson(parsed, defaultName, originalSource);
				}
				if (filename === "package.json") {
					return this.parsePackageJson(parsed, defaultName, originalSource);
				}
			} catch {
				// Ignore parse error and try next candidate
			}
		}

		// Fallback: single plugin directory
		return {
			name: defaultName,
			source: originalSource,
			description: `Plugin marketplace from ${originalSource}`,
			plugins: [
				{
					name: defaultName,
					source: "./",
					description: `Plugin from ${originalSource}`,
				},
			],
		};
	}

	private parseMarketplaceJson(json: Record<string, unknown>, defaultName: string, source: string): MarketplaceConfig {
		const name = typeof json.name === "string" && json.name ? json.name : defaultName;
		const description = typeof json.description === "string" ? json.description : undefined;
		const owner =
			typeof json.owner === "object" && json.owner !== null
				? (json.owner as MarketplaceConfig["owner"])
				: typeof json.owner === "string"
					? json.owner
					: undefined;

		const rawPlugins = json.plugins;
		const plugins: MarketplacePlugin[] = [];

		if (Array.isArray(rawPlugins)) {
			for (const item of rawPlugins) {
				if (typeof item === "object" && item !== null) {
					const record = item as Record<string, unknown>;
					if (typeof record.name === "string" && record.name) {
						let pluginSource = "./";
						if (typeof record.source === "string" && record.source) {
							pluginSource = record.source;
						} else if (typeof record.source === "object" && record.source !== null) {
							const srcObj = record.source as Record<string, unknown>;
							if (typeof srcObj.path === "string") pluginSource = srcObj.path;
							else if (typeof srcObj.repo === "string") pluginSource = srcObj.repo;
						}
						plugins.push({
							name: record.name,
							source: pluginSource,
							description: typeof record.description === "string" ? record.description : undefined,
							version: typeof record.version === "string" ? record.version : undefined,
							category: typeof record.category === "string" ? record.category : undefined,
							tags: Array.isArray(record.tags)
								? record.tags.filter((t): t is string => typeof t === "string")
								: undefined,
						});
					}
				}
			}
		} else if (typeof rawPlugins === "object" && rawPlugins !== null) {
			for (const [pluginName, item] of Object.entries(rawPlugins)) {
				if (typeof item === "object" && item !== null) {
					const record = item as Record<string, unknown>;
					plugins.push({
						name: pluginName,
						source: typeof record.source === "string" ? record.source : "./",
						description: typeof record.description === "string" ? record.description : undefined,
						version: typeof record.version === "string" ? record.version : undefined,
					});
				} else if (typeof item === "string") {
					plugins.push({
						name: pluginName,
						source: item,
					});
				}
			}
		}

		if (plugins.length === 0) {
			plugins.push({
				name,
				source: "./",
				description: description || `Plugin from ${source}`,
			});
		}

		return {
			name,
			source,
			description,
			owner,
			plugins,
		};
	}

	private parsePluginJson(json: Record<string, unknown>, defaultName: string, source: string): MarketplaceConfig {
		const name = typeof json.name === "string" && json.name ? json.name : defaultName;
		const description = typeof json.description === "string" ? json.description : undefined;
		const version = typeof json.version === "string" ? json.version : undefined;

		return {
			name,
			source,
			description,
			plugins: [
				{
					name,
					source: "./",
					description,
					version,
				},
			],
		};
	}

	private parsePackageJson(json: Record<string, unknown>, defaultName: string, source: string): MarketplaceConfig {
		const name = typeof json.name === "string" && json.name ? json.name : defaultName;
		const description = typeof json.description === "string" ? json.description : undefined;
		const version = typeof json.version === "string" ? json.version : undefined;

		return {
			name,
			source,
			description,
			plugins: [
				{
					name,
					source: "./",
					description,
					version,
				},
			],
		};
	}

	listMarketplaces(): MarketplaceEntryWithScope[] {
		const globalMarketplaces = this.settingsManager.getGlobalMarketplaces();
		const projectMarketplaces = this.settingsManager.getProjectMarketplaces();
		const entries: MarketplaceEntryWithScope[] = [];

		for (const marketplace of Object.values(projectMarketplaces)) {
			entries.push({ marketplace, scope: "project" });
		}
		for (const [name, marketplace] of Object.entries(globalMarketplaces)) {
			if (!projectMarketplaces[name]) {
				entries.push({ marketplace, scope: "user" });
			}
		}

		return entries;
	}

	removeMarketplace(nameOrSource: string, options?: { local?: boolean }): boolean {
		return this.settingsManager.removeMarketplace(nameOrSource, options);
	}

	async updateMarketplaces(name?: string): Promise<string[]> {
		const list = this.listMarketplaces();
		const updated: string[] = [];

		for (const { marketplace, scope } of list) {
			if (name && marketplace.name !== name && marketplace.source !== name) {
				continue;
			}
			if (marketplace.installedPath && existsSync(join(marketplace.installedPath, ".git"))) {
				runGit(["pull", "--ff-only"], marketplace.installedPath);
				const refreshed = this.readMarketplaceFromDir(
					marketplace.installedPath,
					marketplace.name,
					marketplace.source,
				);
				const updatedConfig: MarketplaceConfig = {
					...marketplace,
					...refreshed,
					lastUpdated: Date.now(),
				};
				this.settingsManager.addMarketplace(updatedConfig, { local: scope === "project" });
				updated.push(marketplace.name);
			}
		}

		return updated;
	}

	resolvePluginSpec(spec: string): ResolvedPluginSpec {
		const trimmed = spec.trim();

		// Case 1: plugin@marketplace
		if (
			trimmed.includes("@") &&
			!trimmed.startsWith("git:") &&
			!trimmed.startsWith("npm:") &&
			!trimmed.startsWith("http")
		) {
			const atIdx = trimmed.lastIndexOf("@");
			const pluginName = trimmed.slice(0, atIdx);
			const marketplaceName = trimmed.slice(atIdx + 1);

			if (marketplaceName && !marketplaceName.includes("/") && !marketplaceName.includes("\\")) {
				const marketplaces = this.settingsManager.getMarketplaces();
				const marketplace =
					marketplaces[marketplaceName] ||
					Object.values(marketplaces).find(
						(m) => m.source === marketplaceName || m.name.toLowerCase() === marketplaceName.toLowerCase(),
					);

				if (!marketplace) {
					throw new Error(
						`Marketplace "${marketplaceName}" not found. Add it first with: /plugin marketplace add <source>`,
					);
				}

				const plugin = marketplace.plugins.find(
					(p) => p.name === pluginName || p.name.toLowerCase() === pluginName.toLowerCase(),
				);
				if (!plugin) {
					const available = marketplace.plugins.map((p) => p.name).join(", ");
					throw new Error(
						`Plugin "${pluginName}" not found in marketplace "${marketplaceName}". Available: ${available || "none"}`,
					);
				}

				if (
					plugin.source.startsWith("git:") ||
					plugin.source.startsWith("npm:") ||
					/^(https?|ssh|git):\/\//.test(plugin.source)
				) {
					return {
						spec: trimmed,
						pluginName: plugin.name,
						marketplaceName: marketplace.name,
						resolvedSource: plugin.source,
						isLocalPath: false,
						plugin,
					};
				}

				const baseDir = marketplace.installedPath || this.cwd;
				const resolvedPath = resolve(baseDir, plugin.source);
				return {
					spec: trimmed,
					pluginName: plugin.name,
					marketplaceName: marketplace.name,
					resolvedSource: resolvedPath,
					isLocalPath: true,
					plugin,
				};
			}
		}

		// Case 2: search all marketplaces by plugin name
		const marketplaces = this.settingsManager.getMarketplaces();
		const matches: { marketplace: MarketplaceConfig; plugin: MarketplacePlugin }[] = [];
		for (const marketplace of Object.values(marketplaces)) {
			const match = marketplace.plugins.find(
				(p) => p.name === trimmed || p.name.toLowerCase() === trimmed.toLowerCase(),
			);
			if (match) {
				matches.push({ marketplace, plugin: match });
			}
		}

		if (matches.length === 1) {
			const { marketplace, plugin } = matches[0]!;
			if (
				plugin.source.startsWith("git:") ||
				plugin.source.startsWith("npm:") ||
				/^(https?|ssh|git):\/\//.test(plugin.source)
			) {
				return {
					spec: trimmed,
					pluginName: plugin.name,
					marketplaceName: marketplace.name,
					resolvedSource: plugin.source,
					isLocalPath: false,
					plugin,
				};
			}
			const baseDir = marketplace.installedPath || this.cwd;
			return {
				spec: trimmed,
				pluginName: plugin.name,
				marketplaceName: marketplace.name,
				resolvedSource: resolve(baseDir, plugin.source),
				isLocalPath: true,
				plugin,
			};
		}

		if (matches.length > 1) {
			const suggestions = matches.map((m) => `${m.plugin.name}@${m.marketplace.name}`).join(", ");
			throw new Error(
				`Ambiguous plugin name "${trimmed}". Found in multiple marketplaces: ${suggestions}. Use /plugin install <plugin>@<marketplace>`,
			);
		}

		// Case 3: direct source (git / npm / local / shorthand)
		const { type, normalized, defaultName } = this.normalizeSource(trimmed);
		return {
			spec: trimmed,
			pluginName: defaultName,
			resolvedSource: normalized,
			isLocalPath: type === "local",
		};
	}

	async installPlugin(
		spec: string,
		packageManager: DefaultPackageManager,
		options?: { local?: boolean },
	): Promise<ResolvedPluginSpec> {
		const resolved = this.resolvePluginSpec(spec);
		await packageManager.installAndPersist(resolved.resolvedSource, { local: options?.local });
		return resolved;
	}

	async removePlugin(
		specOrName: string,
		packageManager: DefaultPackageManager,
		options?: { local?: boolean },
	): Promise<boolean> {
		const trimmed = specOrName.trim();
		// Try resolving spec first
		let targetSource = trimmed;
		try {
			const resolved = this.resolvePluginSpec(trimmed);
			targetSource = resolved.resolvedSource;
		} catch {
			// fallback to direct string
		}

		const removed = await packageManager.removeAndPersist(targetSource, { local: options?.local });
		if (removed) return true;
		if (targetSource !== trimmed) {
			return await packageManager.removeAndPersist(trimmed, { local: options?.local });
		}
		return false;
	}

	getAvailablePluginCompletions(): { spec: string; description?: string }[] {
		const marketplaces = this.settingsManager.getMarketplaces();
		const completions: { spec: string; description?: string }[] = [];

		for (const marketplace of Object.values(marketplaces)) {
			for (const plugin of marketplace.plugins) {
				completions.push({
					spec: `${plugin.name}@${marketplace.name}`,
					description: plugin.description
						? `${plugin.description} (${marketplace.name})`
						: `From ${marketplace.name}`,
				});
			}
		}

		return completions;
	}
}

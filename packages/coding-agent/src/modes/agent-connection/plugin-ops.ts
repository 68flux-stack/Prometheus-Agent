import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentSessionServices } from "../../core/agent-session-services.js";
import { MarketplaceManager } from "../../core/marketplace-manager.js";
import { DefaultPackageManager } from "../../core/package-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type {
	AgentConnectionMarketplaceEntry,
	AgentConnectionMarketplacePlugin,
	AgentConnectionPluginDetail,
	AgentConnectionPluginEntry,
	AgentConnectionPluginExtension,
	AgentConnectionPluginHook,
	AgentConnectionPluginList,
	AgentConnectionPluginSkill,
} from "./types.js";

/**
 * Package/plugin management against a live AgentSessionServices bundle.
 *
 * Used by both the in-process agent connection and the daemon's session
 * command surface so the desktop (and any RPC client) gets identical
 * semantics regardless of which connection backs it.
 */
export class PluginOps {
	constructor(private readonly services: AgentSessionServices) {}

	private createManagers(): {
		settingsManager: SettingsManager;
		packageManager: DefaultPackageManager;
		marketplaceManager: MarketplaceManager;
	} {
		const settingsManager = this.services.settingsManager;
		return {
			settingsManager,
			packageManager: new DefaultPackageManager({
				cwd: this.services.cwd,
				agentDir: this.services.agentDir,
				settingsManager,
			}),
			marketplaceManager: new MarketplaceManager({
				cwd: this.services.cwd,
				agentDir: this.services.agentDir,
				settingsManager,
			}),
		};
	}

	private readInstalledPackageMeta(installedPath: string | undefined): {
		name?: string;
		version?: string;
		author?: string;
		description?: string;
		lastUpdated?: number;
	} {
		if (!installedPath) return {};
		try {
			if (!existsSync(installedPath)) return {};
			let name = basename(installedPath);
			const lastUpdated = statSync(installedPath).mtimeMs;
			let version: string | undefined;
			let author: string | undefined;
			let description: string | undefined;
			const pkgJsonPath = join(installedPath, "package.json");
			if (existsSync(pkgJsonPath)) {
				try {
					const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as Record<string, unknown>;
					if (typeof parsed.name === "string" && parsed.name) name = parsed.name;
					if (typeof parsed.version === "string") version = parsed.version;
					if (typeof parsed.description === "string") description = parsed.description;
					if (typeof parsed.author === "string") {
						author = parsed.author;
					} else if (typeof parsed.author === "object" && parsed.author !== null) {
						const authorName = (parsed.author as { name?: unknown }).name;
						if (typeof authorName === "string") author = authorName;
					}
				} catch {
					// Unparseable package.json: fall back to directory-derived name.
				}
			}
			return { name, version, author, description, lastUpdated };
		} catch {
			return {};
		}
	}

	listPlugins(): AgentConnectionPluginList {
		const { packageManager, marketplaceManager } = this.createManagers();
		const configured = packageManager.listConfiguredPackages();
		const skillResult = this.services.resourceLoader.getSkills();

		const packages: AgentConnectionPluginEntry[] = configured.map((pkg) => {
			const meta = this.readInstalledPackageMeta(pkg.installedPath);
			const skillCount = skillResult.skills.filter(
				(s) => s.sourceInfo?.origin === "package" && s.sourceInfo?.source === pkg.source,
			).length;
			return {
				source: pkg.source,
				scope: pkg.scope,
				filtered: pkg.filtered,
				enabled: pkg.enabled,
				installedPath: pkg.installedPath,
				skillCount,
				...meta,
			};
		});

		const marketplaces: AgentConnectionMarketplaceEntry[] = marketplaceManager
			.listMarketplaces()
			.map(({ marketplace, scope }) => ({
				name: marketplace.name,
				source: marketplace.source,
				scope,
				description: marketplace.description,
				author: typeof marketplace.owner === "string" ? marketplace.owner : marketplace.owner?.name,
				installedPath: marketplace.installedPath,
				lastUpdated: marketplace.lastUpdated,
				plugins: marketplace.plugins.map((plugin): AgentConnectionMarketplacePlugin => {
					let resolvedSource: string | undefined;
					try {
						resolvedSource = marketplaceManager.resolvePluginSpec(
							`${plugin.name}@${marketplace.name}`,
						).resolvedSource;
					} catch {
						// Plugin spec no longer resolves (e.g. marketplace manifest changed);
						// fall back to comparing the raw manifest source below.
					}
					return {
						name: plugin.name,
						source: plugin.source,
						description: plugin.description,
						version: plugin.version,
						author: typeof plugin.author === "string" ? plugin.author : plugin.author?.name,
						// `plugin.source` is the raw, marketplace-relative manifest value
						// (often "./"); configured packages persist the *resolved* install
						// source, so compare against that too or an installed plugin never
						// shows as installed on its marketplace card.
						installed: configured.some(
							(c) =>
								c.source === plugin.source || c.source === resolvedSource || c.installedPath === resolvedSource,
						),
					};
				}),
			}));

		return { packages, marketplaces };
	}

	getPluginDetail(source: string): AgentConnectionPluginDetail {
		const { settingsManager, packageManager } = this.createManagers();
		const configured = packageManager.listConfiguredPackages();
		const entry = configured.find((c) => c.source === source);
		if (!entry) {
			throw new Error(`No configured package matching "${source}"`);
		}
		const disabledHooks = settingsManager.getDisabledExtensionHooks();
		const meta = this.readInstalledPackageMeta(entry.installedPath);

		const skills: AgentConnectionPluginSkill[] = this.services.resourceLoader
			.getSkills()
			.skills.filter((s) => s.sourceInfo?.origin === "package" && s.sourceInfo?.source === source)
			.map((s) => ({
				name: s.name,
				path: s.filePath,
				description: s.description || undefined,
				enabled: true,
			}));

		const extensions: AgentConnectionPluginExtension[] = this.services.resourceLoader
			.getExtensions()
			.extensions.filter((e) => e.sourceInfo?.origin === "package" && e.sourceInfo?.source === source)
			.map((ext) => {
				const disabled = disabledHooks[ext.path] ?? [];
				const hooks: AgentConnectionPluginHook[] = [...ext.handlers.entries()].map(([event, handlers]) => ({
					event,
					handlerCount: handlers.length,
					enabled: !disabled.includes(event),
				}));
				return { path: ext.path, hooks };
			});

		return {
			entry: {
				source: entry.source,
				scope: entry.scope,
				filtered: entry.filtered,
				enabled: entry.enabled,
				installedPath: entry.installedPath,
				skillCount: skills.length,
				...meta,
			},
			skills,
			extensions,
		};
	}

	async installPlugin(spec: string, options?: { local?: boolean }): Promise<{ name: string; source: string }> {
		const { marketplaceManager, packageManager } = this.createManagers();
		const resolved = await marketplaceManager.installPlugin(spec, packageManager, options);
		return { name: resolved.pluginName, source: resolved.resolvedSource };
	}

	async removePlugin(spec: string, options?: { local?: boolean }): Promise<boolean> {
		const { marketplaceManager, packageManager } = this.createManagers();
		return marketplaceManager.removePlugin(spec, packageManager, options);
	}

	async updatePlugins(spec?: string): Promise<void> {
		const { packageManager } = this.createManagers();
		await packageManager.update(spec);
	}

	async addMarketplace(
		source: string,
		options?: { local?: boolean; name?: string },
	): Promise<{ name: string; pluginCount: number }> {
		const { marketplaceManager } = this.createManagers();
		const added = await marketplaceManager.addMarketplace(source, options);
		return { name: added.name, pluginCount: added.plugins.length };
	}

	async removeMarketplace(nameOrSource: string, options?: { local?: boolean }): Promise<boolean> {
		const { marketplaceManager } = this.createManagers();
		return marketplaceManager.removeMarketplace(nameOrSource, options);
	}

	async updateMarketplaces(name?: string): Promise<{ updated: string[] }> {
		const { marketplaceManager } = this.createManagers();
		return { updated: await marketplaceManager.updateMarketplaces(name) };
	}

	setPackageEnabled(source: string, enabled: boolean, local?: boolean): void {
		const { settingsManager } = this.createManagers();
		const updated = settingsManager.setPackageEnabled(source, enabled, local);
		if (!updated) {
			throw new Error(`No configured package matching "${source}"`);
		}
	}

	setExtensionHookEnabled(extensionPath: string, event: string, enabled: boolean): void {
		const { settingsManager } = this.createManagers();
		const hooks = settingsManager.getDisabledExtensionHooks();
		const disabled = new Set(hooks[extensionPath] ?? []);
		if (enabled) {
			disabled.delete(event);
		} else {
			disabled.add(event);
		}
		const next: Record<string, string[]> = { ...hooks };
		if (disabled.size > 0) {
			next[extensionPath] = [...disabled];
		} else {
			delete next[extensionPath];
		}
		settingsManager.setDisabledExtensionHooks(next);
	}
}

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketplaceManager } from "../src/core/marketplace-manager.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("MarketplaceManager", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let marketplaceManager: MarketplaceManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `mp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.create(tempDir, agentDir);
		marketplaceManager = new MarketplaceManager({ cwd: tempDir, agentDir, settingsManager });
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("adds a local marketplace with .claude-plugin/marketplace.json", async () => {
		const mpDir = join(tempDir, "my-marketplace");
		const claudePluginDir = join(mpDir, ".claude-plugin");
		mkdirSync(claudePluginDir, { recursive: true });

		writeFileSync(
			join(claudePluginDir, "marketplace.json"),
			JSON.stringify({
				name: "ponytail",
				description: "Curated collection of lazy developer skills",
				plugins: [
					{
						name: "ponytail",
						source: "./",
						description: "Lazy senior developer mindset",
					},
					{
						name: "ponytail-audit",
						source: "./plugins/audit",
						description: "Audit debt and bloat",
					},
				],
			}),
		);

		const added = await marketplaceManager.addMarketplace(mpDir);
		expect(added.name).toBe("ponytail");
		expect(added.plugins).toHaveLength(2);
		expect(added.plugins[0]!.name).toBe("ponytail");
		expect(added.plugins[1]!.name).toBe("ponytail-audit");

		const list = marketplaceManager.listMarketplaces();
		expect(list).toHaveLength(1);
		expect(list[0]!.marketplace.name).toBe("ponytail");
	});

	it("adds a standalone plugin repository as a marketplace", async () => {
		const pluginDir = join(tempDir, "single-plugin");
		const claudePluginDir = join(pluginDir, ".claude-plugin");
		mkdirSync(claudePluginDir, { recursive: true });

		writeFileSync(
			join(claudePluginDir, "plugin.json"),
			JSON.stringify({
				name: "fast-code",
				description: "Fast code helper",
				version: "1.0.0",
			}),
		);

		const added = await marketplaceManager.addMarketplace(pluginDir);
		expect(added.name).toBe("fast-code");
		expect(added.plugins).toHaveLength(1);
		expect(added.plugins[0]!.name).toBe("fast-code");
	});

	it("resolves plugin@marketplace specifiers correctly", async () => {
		const mpDir = join(tempDir, "ponytail-repo");
		mkdirSync(join(mpDir, ".claude-plugin"), { recursive: true });
		mkdirSync(join(mpDir, "skills", "ponytail"), { recursive: true });

		writeFileSync(
			join(mpDir, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				name: "ponytail",
				plugins: [
					{
						name: "ponytail",
						source: "./",
						description: "Lazy senior developer mindset",
					},
				],
			}),
		);

		await marketplaceManager.addMarketplace(mpDir);

		const resolved = marketplaceManager.resolvePluginSpec("ponytail@ponytail");
		expect(resolved.pluginName).toBe("ponytail");
		expect(resolved.marketplaceName).toBe("ponytail");
		expect(resolved.isLocalPath).toBe(true);
		expect(resolved.resolvedSource).toBe(mpDir);
	});

	it("resolves unique plugin name without @marketplace prefix", async () => {
		const mpDir = join(tempDir, "tools-marketplace");
		mkdirSync(join(mpDir, ".claude-plugin"), { recursive: true });

		writeFileSync(
			join(mpDir, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				name: "official",
				plugins: [
					{
						name: "review-assistant",
						source: "./plugins/review",
						description: "Review assistant",
					},
				],
			}),
		);

		await marketplaceManager.addMarketplace(mpDir);

		const resolved = marketplaceManager.resolvePluginSpec("review-assistant");
		expect(resolved.pluginName).toBe("review-assistant");
		expect(resolved.marketplaceName).toBe("official");
	});

	it("throws on missing marketplace or missing plugin", async () => {
		expect(() => marketplaceManager.resolvePluginSpec("foo@nonexistent")).toThrow(
			/Marketplace "nonexistent" not found/,
		);

		const mpDir = join(tempDir, "empty-mp");
		mkdirSync(mpDir, { recursive: true });
		writeFileSync(
			join(mpDir, "marketplace.json"),
			JSON.stringify({
				name: "empty",
				plugins: [],
			}),
		);
		await marketplaceManager.addMarketplace(mpDir);

		expect(() => marketplaceManager.resolvePluginSpec("missing@empty")).toThrow(
			/Plugin "missing" not found in marketplace "empty"/,
		);
	});

	it("installs and removes a plugin via packageManager", async () => {
		const mpDir = join(tempDir, "marketplace-test");
		const skillDir = join(mpDir, "skills", "ponytail");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: ponytail\ndescription: Lazy developer skill\n---\n# Ponytail\n`,
		);

		writeFileSync(
			join(mpDir, "marketplace.json"),
			JSON.stringify({
				name: "ponytail",
				plugins: [{ name: "ponytail", source: "./" }],
			}),
		);

		await marketplaceManager.addMarketplace(mpDir);
		const installed = await marketplaceManager.installPlugin("ponytail@ponytail", packageManager);
		expect(installed.pluginName).toBe("ponytail");

		const configured = packageManager.listConfiguredPackages();
		expect(configured.length).toBeGreaterThan(0);

		const removed = await marketplaceManager.removePlugin("ponytail@ponytail", packageManager);
		expect(removed).toBe(true);
		expect(packageManager.listConfiguredPackages()).toHaveLength(0);
	});

	it("provides autocomplete completions for available marketplace plugins", async () => {
		const mpDir = join(tempDir, "mp-auto");
		mkdirSync(mpDir, { recursive: true });
		writeFileSync(
			join(mpDir, "marketplace.json"),
			JSON.stringify({
				name: "ponytail",
				plugins: [
					{ name: "ponytail", source: "./", description: "Main skill" },
					{ name: "ponytail-audit", source: "./", description: "Audit skill" },
				],
			}),
		);

		await marketplaceManager.addMarketplace(mpDir);
		const completions = marketplaceManager.getAvailablePluginCompletions();
		expect(completions).toHaveLength(2);
		expect(completions.map((c) => c.spec)).toEqual(["ponytail@ponytail", "ponytail-audit@ponytail"]);
	});

	it("normalizes an owner/repo shorthand as a GitHub source, not a local path", () => {
		const result = marketplaceManager.normalizeSource("DietrichGebert/ponytail");
		expect(result.type).toBe("git");
		expect(result.normalized).toBe("https://github.com/DietrichGebert/ponytail");
		expect(result.defaultName).toBe("ponytail");
	});

	it("normalizes an explicit relative path as local even if it looks like owner/repo", () => {
		const result = marketplaceManager.normalizeSource("./DietrichGebert/ponytail");
		expect(result.type).toBe("local");
		expect(result.normalized).toBe(join(tempDir, "DietrichGebert", "ponytail"));
	});

	it("removes a marketplace from settings", async () => {
		const mpDir = join(tempDir, "mp-remove");
		mkdirSync(mpDir, { recursive: true });
		writeFileSync(join(mpDir, "marketplace.json"), JSON.stringify({ name: "to-remove", plugins: [] }));

		await marketplaceManager.addMarketplace(mpDir);
		expect(marketplaceManager.listMarketplaces()).toHaveLength(1);

		const removed = marketplaceManager.removeMarketplace("to-remove");
		expect(removed).toBe(true);
		expect(marketplaceManager.listMarketplaces()).toHaveLength(0);
	});
});

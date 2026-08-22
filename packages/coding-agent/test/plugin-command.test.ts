import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePublicCommand } from "../src/cli/public-command.js";
import { handlePluginCommand } from "../src/package-manager-cli.js";

describe("Plugin CLI Command", () => {
	let tempDir: string;
	let agentDir: string;
	let origCwd: string;

	beforeEach(() => {
		origCwd = process.cwd();
		tempDir = join(tmpdir(), `plugin-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env.PROMETHEUS_CODING_AGENT_DIR = agentDir;

		process.chdir(tempDir);
		process.exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		process.chdir(origCwd);
		delete process.env.PROMETHEUS_CODING_AGENT_DIR;
		process.exitCode = undefined;
		vi.restoreAllMocks();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	it("shows help when run with no arguments", async () => {
		const handled = await handlePluginCommand([]);
		expect(handled).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});

	it("adds a marketplace, installs a plugin, lists, and removes via handlePluginCommand", async () => {
		const mpDir = join(tempDir, "ponytail-source");
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
				plugins: [{ name: "ponytail", source: "./", description: "Lazy developer mindset" }],
			}),
		);

		// 1. Add marketplace
		const addResult = await handlePluginCommand(["marketplace", "add", mpDir]);
		expect(addResult).toBe(true);

		// 2. List marketplaces
		const listMpResult = await handlePluginCommand(["marketplace", "list"]);
		expect(listMpResult).toBe(true);

		// 3. Install plugin
		const installResult = await handlePluginCommand(["install", "ponytail@ponytail"]);
		expect(installResult).toBe(true);

		// 4. List plugins
		const listResult = await handlePluginCommand(["list"]);
		expect(listResult).toBe(true);

		// 5. Remove plugin
		const removeResult = await handlePluginCommand(["remove", "ponytail@ponytail"]);
		expect(removeResult).toBe(true);

		// 6. Remove marketplace
		const removeMpResult = await handlePluginCommand(["marketplace", "remove", "ponytail"]);
		expect(removeMpResult).toBe(true);
	});

	it("routes plugin commands via handlePublicCommand", async () => {
		const result = await handlePublicCommand(["plugin", "help"]);
		expect(result.handled).toBe(true);
	});
});

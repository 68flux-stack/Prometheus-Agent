#!/usr/bin/env node
/**
 * Stages the engine for a packaged desktop build.
 *
 * The packaged app spawns `dist/bundle/cli.js` as a child process and also
 * `require()`s a few unbundled `dist/core/*.js` modules from the main process, so
 * the installer must carry the whole coding-agent `dist` *plus* real node_modules
 * for the packages esbuild leaves external (zeromq, undici, photon-node, ...).
 *
 * Rather than hand-maintaining that dependency list, we let npm do it: pack the
 * workspace package, then install the tarball into a throwaway prefix. The result
 * is `node_modules/prometheus-agent/` with correct, platform-native dependencies
 * beside it, which electron-builder copies verbatim into `resources/engine`.
 *
 * Staging happens in the OS temp dir so npm cannot resolve this repo's workspace
 * config and link the workspace instead of installing a real copy.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(desktopDir));
const stagingDir = join(desktopDir, "engine-staging");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, cwd) {
	execFileSync(npm, args, { cwd, stdio: "inherit", shell: process.platform === "win32", windowsHide: true });
}

const tmpRoot = mkdtempSync(join(tmpdir(), "prometheus-engine-"));
try {
	// An own package.json stops npm from walking up into the monorepo workspace.
	writeFileSync(join(tmpRoot, "package.json"), `${JSON.stringify({ name: "prometheus-engine-staging", version: "0.0.0", private: true }, null, "\t")}\n`);

	console.log("[prometheus] Packing engine...");
	run(["pack", "--workspace", "packages/coding-agent", "--pack-destination", tmpRoot], repoRoot);
	const tarball = readdirSync(tmpRoot).find((name) => name.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack produced no tarball");

	console.log("[prometheus] Installing engine dependencies...");
	run(["install", "--omit=dev", "--no-audit", "--no-fund", join(tmpRoot, tarball)], tmpRoot);
	rmSync(join(tmpRoot, tarball), { force: true });

	const staged = join(tmpRoot, "node_modules");
	if (!existsSync(join(staged, "prometheus-agent", "dist", "bundle", "cli.js"))) {
		throw new Error("staged engine is missing dist/bundle/cli.js");
	}

	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });
	cpSync(staged, join(stagingDir, "node_modules"), { recursive: true });
	console.log(`[prometheus] Engine staged in ${stagingDir}`);
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}

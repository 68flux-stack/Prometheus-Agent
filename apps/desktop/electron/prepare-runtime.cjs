const { readdirSync, statSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
// The desktop spawns the engine through the bundled entry: the unbundled
// module graph is ~2,500 files and resolving them dominates process boot
// (~1.5s on slow filesystems); the bundle loads the same code from ~20 chunks
// in under half the time. dist/cli.js stays as the bundle's input and the
// library-style requires the main process performs.
const runtimeEntrypoint = path.join(repoRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const runtimeInputs = [
	path.join(repoRoot, "packages", "tui", "src"),
	path.join(repoRoot, "packages", "ai", "src"),
	path.join(repoRoot, "packages", "agent", "src"),
	path.join(repoRoot, "packages", "coding-agent", "src"),
	path.join(repoRoot, "prometheus-runtime"),
];

function newestModifiedAt(target) {
	let newest = statSync(target).mtimeMs;
	if (!statSync(target).isDirectory()) return newest;
	for (const entry of readdirSync(target, { withFileTypes: true })) {
		if (entry.name === "__pycache__" || entry.name === ".pytest_cache") continue;
		newest = Math.max(newest, newestModifiedAt(path.join(target, entry.name)));
	}
	return newest;
}

function runtimeNeedsBuild() {
	try {
		const builtAt = statSync(runtimeEntrypoint).mtimeMs;
		// The bundle's input (dist/cli.js) is produced by the same build step;
		// a missing or older bundle means a rebuild regardless of the input's age.
		if (statSync(path.join(repoRoot, "packages", "coding-agent", "dist", "cli.js")).mtimeMs > builtAt) return true;
		return runtimeInputs.some((input) => newestModifiedAt(input) > builtAt);
	} catch {
		return true;
	}
}

function prepareRuntime() {
	if (!runtimeNeedsBuild()) return;
	console.log("[prometheus] Local runtime changed; rebuilding before desktop startup.");
	const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
	// With `shell`, Node concatenates argv unescaped, so an install path with a
	// space ("C:\Users\Jane Doe\...") would split into two arguments.
	const agentDir = path.join(repoRoot, "packages", "coding-agent");
	const prefixArg = process.platform === "win32" ? `"${agentDir}"` : agentDir;
	const result = spawnSync(npmExecutable, ["--prefix", prefixArg, "run", "build:desktop"], {
		cwd: repoRoot,
		shell: process.platform === "win32",
		stdio: "inherit",
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`Prometheus runtime build failed with exit code ${result.status ?? "unknown"}.`);
	}
}

if (require.main === module) prepareRuntime();

module.exports = { prepareRuntime, runtimeNeedsBuild };

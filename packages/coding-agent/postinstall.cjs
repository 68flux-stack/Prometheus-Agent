const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

// The published package ships the bundled build: the unbundled dist/postinstall.js
// imports the workspace-only pi-* packages, which a consumer never installs.
const candidates = [join(__dirname, "dist", "bundle", "postinstall.js"), join(__dirname, "dist", "postinstall.js")];
const script = candidates.find(existsSync);
if (!script) {
	process.exit(0);
}

const result = spawnSync(process.execPath, [script], { stdio: "inherit", windowsHide: true });
if (result.error) {
	console.error(`prometheus: postinstall setup skipped: ${result.error.message}`);
}
process.exit(0);

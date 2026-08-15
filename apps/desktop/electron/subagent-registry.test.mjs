// Checks the desktop's persisted-subagent reader against a real session tree:
// the artifact path it derives must be the one SessionManager actually uses.
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);

const userData = mkdtempSync(join(tmpdir(), "subagent-userdata-"));
const sessionDir = mkdtempSync(join(tmpdir(), "subagent-sessions-"));
const workspace = mkdtempSync(join(tmpdir(), "subagent-ws-"));

// Minimal Electron surface for the bits main.cjs touches at load time.
const noop = () => {};
const electronStub = {
	app: {
		getPath: () => userData,
		setPath: noop,
		setName: noop,
		setAppUserModelId: noop,
		commandLine: { appendSwitch: noop },
		disableHardwareAcceleration: noop,
		whenReady: () => new Promise(() => {}),
		on: noop,
	},
	BrowserWindow: class {},
	dialog: {},
	ipcMain: { handle: noop },
	Menu: { setApplicationMenu: noop },
	shell: {},
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
	if (request === "electron") return electronStub;
	return originalLoad.call(this, request, ...rest);
};

process.env.PROMETHEUS_CLI_PATH = join(repoRoot, "packages/coding-agent/dist/cli.js");
process.env.PROMETHEUS_SESSION_DIR = sessionDir;
process.env.PROMETHEUS_USER_DATA_DIR = userData;

const { SessionManager } = require(join(repoRoot, "packages/coding-agent/dist/core/session-manager.js"));
const session = SessionManager.create(workspace, sessionDir);
session.flushNow();
const sessionPath = session.getSessionFile();
const artifactDir = session.getSessionArtifactDir();

const entries = [
	// Spawned, then finished: the later line must win.
	{ type: "rlm_subagent", childId: "child-1", sessionName: "say-hi", sessionFile: join(sessionDir, "say-hi.jsonl"), prompt: 'Please send exactly "hi" to the parent agent.', status: "running", createdAt: 1000 },
	{ type: "rlm_subagent", childId: "child-1", sessionName: "say-hi", sessionFile: join(sessionDir, "say-hi.jsonl"), prompt: 'Please send exactly "hi" to the parent agent.', status: "completed", createdAt: 1000 },
	// Still marked running because the app died mid-run.
	{ type: "rlm_subagent", childId: "child-2", sessionName: "spawn-audit", sessionFile: join(sessionDir, "audit.jsonl"), prompt: "Audit every spawn call site.", status: "running", createdAt: 2000 },
	// Deleted by the orchestrator: must not come back.
	{ type: "rlm_subagent", childId: "child-3", sessionName: "gone", sessionFile: join(sessionDir, "gone.jsonl"), prompt: "nope", status: "deleted", createdAt: 3000 },
	"{ this line is not json",
];
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, "rlm-subagents.jsonl"), `${entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n")}\n`);

const main = require("./main.cjs");
Module._load = originalLoad;

const assert = (ok, message) => {
	if (!ok) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
		return;
	}
	console.log(`ok - ${message}`);
};

const { subagents } = main.listSessionSubagents({ sessionPath });
assert(subagents.length === 2, `reads the live entries and drops the deleted one (got ${subagents.length})`);
assert(subagents[0].id === "child-1" && subagents[1].id === "child-2", "orders rows by spawn time");
assert(subagents[0].completed === true, "the later 'completed' line wins over the earlier 'running' one");
assert(subagents[1].completed === false, "an interrupted run stays uncompleted so the busy poll decides");
assert(subagents[0].label === 'Please send exactly "hi" to the parent agent.', "carries the spawn prompt for the row summary");
assert(subagents[0].sessionFile.endsWith("say-hi.jsonl"), "carries the child session file for the busy-session lookup");
assert(main.listSessionSubagents({ sessionPath: join(sessionDir, "missing.jsonl") }).subagents.length === 0, "a session with no registry returns nothing");
if (!process.exitCode) console.log("PASS");

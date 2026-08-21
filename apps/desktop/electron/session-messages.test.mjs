// The desktop paints a conversation from disk before the engine attaches to it.
// This checks that reader against a real transcript: if it silently returns
// nothing, every chat switch shows an empty conversation for several seconds.
import { createRequire } from "node:module";
import Module from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);

const userData = mkdtempSync(join(tmpdir(), "messages-userdata-"));
const sessionDir = mkdtempSync(join(tmpdir(), "messages-sessions-"));
const workspace = mkdtempSync(join(tmpdir(), "messages-ws-"));

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
session.appendMessage({ role: "user", content: "first question" });
session.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }] });
session.flushNow();
const sessionPath = session.getSessionFile();

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

const { messages } = await main.readSessionMessages({ sessionPath });
assert(messages.length === 2, `reads the transcript the engine would return (got ${messages.length})`);
assert(messages[0].role === "user" && messages[1].role === "assistant", "keeps roles and order");
assert((await main.readSessionMessages({ sessionPath: join(sessionDir, "missing.jsonl") })).messages.length === 0, "a missing transcript reads as empty rather than throwing");
assert((await main.readSessionMessages({})).messages.length === 0, "a session that has not been minted yet reads as empty");
const imagePath = join(workspace, "attached.png");
const imageBytes = Buffer.from("iVBORw0KGgo=", "base64");
writeFileSync(imagePath, imageBytes);
const image = main.readImageAttachment({ filePath: imagePath });
assert(image.type === "image" && image.mimeType === "image/png", "turns an attached image into a provider image block");
assert(image.data === imageBytes.toString("base64"), "keeps the original image bytes instead of sending its path");
if (!process.exitCode) console.log("PASS");

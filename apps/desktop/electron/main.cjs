const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const {
	chmodSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	closeSync,
	statSync,
	unlinkSync,
	writeFileSync,
} = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

if (process.defaultApp && !process.env.PROMETHEUS_CLI_PATH) {
	require("./prepare-runtime.cjs").prepareRuntime();
}

let mainWindow;
let agentProcess;
let detachAgentReader;
let agentWorkspace;
let agentGeneration = 0;
let rendererServer;
let activeProviderLogin;
let providerLoginPromptCounter = 0;

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const cliPath = process.env.PROMETHEUS_CLI_PATH || path.join(repoRoot, "packages", "coding-agent", "dist", "cli.js");
const distDir = path.join(repoRoot, "packages", "coding-agent", "dist");
const { AuthStorage } = require(path.join(distDir, "core", "auth-storage.js"));
const { SessionManager } = require(path.join(distDir, "core", "session-manager.js"));
const { WorkspaceChangeReview } = require(path.join(distDir, "core", "workspace-change-review.js"));
// The RPC contract is strict LF-only JSONL. Node's readline splits on U+2028/U+2029,
// which are legal inside JSON strings, so it silently destroys frames.
const { attachJsonlLineReader } = require(path.join(distDir, "modes", "rpc", "jsonl.js"));
const OAUTH_PROVIDER_IDS = new Set(["anthropic", "openai-codex", "github-copilot"]);
const MAX_RPC_LINE_LENGTH = 128 * 1024 * 1024;
const MAX_ATTACHMENT_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 32 * 1024 * 1024;

function isWritableDirectory(directory) {
	try {
		mkdirSync(directory, { recursive: true });
		const probe = path.join(directory, `.write-test-${process.pid}`);
		writeFileSync(probe, "ok");
		unlinkSync(probe);
		return true;
	} catch {
		return false;
	}
}

const requestedUserData = process.env.PROMETHEUS_USER_DATA_DIR || path.join(app.getPath("appData"), "Prometheus");
const legacyUserData = path.join(app.getPath("appData"), "PrimeAgent");
if (!process.env.PROMETHEUS_USER_DATA_DIR && existsSync(legacyUserData) && !existsSync(requestedUserData)) {
	try {
		renameSync(legacyUserData, requestedUserData);
		// ponytail: single local rename, no EXDEV fallback — appData is always same-volume as itself.
	} catch {
		// Leave the legacy folder in place; isWritableDirectory below still resolves a usable path.
	}
}
const fallbackUserData = path.join(repoRoot, ".tmp-agent", "desktop-user-data");
app.setPath("userData", isWritableDirectory(requestedUserData) ? requestedUserData : fallbackUserData);

// The desktop is a client for the same agent the CLI runs. Sharing the standard
// agent directory is what makes `prometheus` and the desktop one product: the
// same credentials, settings, themes, skills, packages, kernel venv and session
// history. Isolation stays available for repros.
function getAgentDataDir() {
	if (process.env.PROMETHEUS_CODING_AGENT_DIR) return path.resolve(process.env.PROMETHEUS_CODING_AGENT_DIR);
	if (process.env.PROMETHEUS_DESKTOP_ISOLATED === "1") return path.join(app.getPath("userData"), "agent");
	const sharedAgentData = path.join(os.homedir(), ".prometheus", "agent");
	return isWritableDirectory(sharedAgentData) ? sharedAgentData : path.join(app.getPath("userData"), "agent");
}

function getSessionsDir() {
	return process.env.PROMETHEUS_SESSION_DIR
		? path.resolve(process.env.PROMETHEUS_SESSION_DIR)
		: path.join(getAgentDataDir(), "sessions");
}

// Where the engine starts before any workspace is chosen. Must stay small and
// outside the agent data dir: the engine baselines every file under its cwd on
// first open (see WorkspaceChangeReview), and the agent data dir itself lives
// under the home folder, so pointing cwd at the home folder made every session
// snapshot the whole home tree — including prior sessions' own snapshots.
function getIdleWorkspaceDir() {
	const dir = path.join(app.getPath("userData"), "idle-workspace");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function getWorkspacesPath() {
	return path.join(app.getPath("userData"), "workspaces.json");
}

function sessionWorkspaceKey(sessionPath) {
	return path.resolve(sessionPath).toLocaleLowerCase();
}

// Workspaces reach us from a folder dialog, a session header written by the CLI,
// and workspaces.json. On Windows those can differ only by drive-letter or path
// casing, and an exact compare then hides a workspace's own conversations.
function workspaceKey(workspace) {
	return typeof workspace === "string" ? path.resolve(workspace).toLocaleLowerCase() : "";
}

function normalizeWorkspaces(workspaces) {
	if (!Array.isArray(workspaces)) throw new Error("Workspaces must be an array.");
	const seen = new Set();
	const normalized = [];
	for (const workspace of workspaces) {
		if (typeof workspace !== "string" || !workspace.trim()) continue;
		const resolved = path.resolve(workspace);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		normalized.push(resolved);
		if (normalized.length === 12) break;
	}
	return normalized;
}

function getWorkspaceStore() {
	try {
		const parsed = JSON.parse(readFileSync(getWorkspacesPath(), "utf8"));
		const sessionWorkspaces = Object.fromEntries(
			Object.entries(parsed?.sessionWorkspaces || {}).filter(
				([sessionPath, workspace]) => typeof sessionPath === "string" && typeof workspace === "string" && workspace.trim(),
			),
		);
		return { workspaces: normalizeWorkspaces(parsed?.workspaces), sessionWorkspaces };
	} catch {
		return { workspaces: [], sessionWorkspaces: {} };
	}
}

function getSavedWorkspaces() {
	return { workspaces: getWorkspaceStore().workspaces };
}

function saveWorkspaces(payload = {}) {
	const workspaces = normalizeWorkspaces(payload?.workspaces);
	const { sessionWorkspaces } = getWorkspaceStore();
	writeFileSync(getWorkspacesPath(), `${JSON.stringify({ workspaces, sessionWorkspaces })}\n`, "utf8");
	return { workspaces };
}

function runSessionWorker(workerData) {
	return new Promise((resolve, reject) => {
		const worker = new Worker(path.join(__dirname, "session-creator.cjs"), { workerData });
		worker.once("message", ({ error, ...result }) => {
			if (error) reject(new Error(error));
			else resolve(result);
		});
		worker.once("error", reject);
		worker.once("exit", (code) => {
			if (code !== 0) reject(new Error(`Session worker stopped with code ${code}.`));
		});
	});
}

function createWorkspaceSession(payload = {}) {
	const workspace = typeof payload?.workspace === "string" && payload.workspace.trim() ? path.resolve(payload.workspace) : undefined;
	if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
		throw new Error("Choose an existing workspace folder.");
	}
	return runSessionWorker({ action: "create", workspace, sessionsDir: getSessionsDir(), distDir }).then(({ sessionPath }) => {
		if (!sessionPath) throw new Error("Could not create a conversation for this workspace.");
		const workspaceStore = getWorkspaceStore();
		workspaceStore.sessionWorkspaces[sessionWorkspaceKey(sessionPath)] = workspace;
		writeFileSync(getWorkspacesPath(), `${JSON.stringify(workspaceStore)}\n`, "utf8");
		return { sessionPath };
	});
}

// Share the normal daemon so the desktop can reattach to conversations already
// running in the CLI. Isolated desktop repros retain their own Windows pipe.
function getDesktopDaemonSocketPath() {
	if (process.env.PROMETHEUS_DESKTOP_DAEMON_SOCKET) return process.env.PROMETHEUS_DESKTOP_DAEMON_SOCKET;
	if (process.platform !== "win32" || process.env.PROMETHEUS_DESKTOP_ISOLATED !== "1") return undefined;
	const userDataKey = createHash("sha256").update(path.resolve(app.getPath("userData"))).digest("hex").slice(0, 16);
	return `\\\\.\\pipe\\prometheus-desktop-${userDataKey}`;
}

const desktopDaemonSocketPath = getDesktopDaemonSocketPath();
const appIconIcoPath = path.join(repoRoot, "PrometheusLogo.ico");
const appIconPngPath = path.join(repoRoot, "PrometheusLogo.png");
const appIconPath = process.platform === "win32" ? appIconIcoPath : appIconPngPath;

app.setName("Prometheus");
app.setAppUserModelId("com.primeintellect.prometheus");

// The renderer is primarily text and remains reliable on machines without a
// working Chromium GPU process (including remote desktop sessions).
app.commandLine.appendSwitch("disable-gpu");
if (process.defaultApp) {
	// The development Electron binary is sandbox-hostile in some managed
	// Windows environments. Keep this compatibility path scoped to dev mode;
	// packaged builds retain Electron's normal renderer sandbox.
	app.commandLine.appendSwitch("no-sandbox");
	app.commandLine.appendSwitch("in-process-gpu");
	app.commandLine.appendSwitch("disable-gpu-sandbox");
}
app.disableHardwareAcceleration();

function sendToRenderer(channel, payload) {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(channel, payload);
}

function stopAgent(options = {}) {
	const processToStop = agentProcess;
	const detach = detachAgentReader;
	agentProcess = undefined;
	detachAgentReader = undefined;
	detach?.();
	if (!processToStop || processToStop.killed || processToStop.exitCode !== null) return;
	// rpc-mode shuts down cleanly on stdin EOF: it cancels pending extension UI,
	// waits for idle and kills tracked detached children. On Windows a SIGTERM is
	// TerminateProcess, so killing first orphans bash/ipython grandchildren.
	try {
		processToStop.stdin?.end();
	} catch {
		// The pipe may already be gone; the kill below is the backstop.
	}
	const graceMs = options.graceMs ?? 2500;
	const killTimer = setTimeout(() => {
		if (!processToStop.killed && processToStop.exitCode === null) processToStop.kill();
	}, graceMs);
	killTimer.unref?.();
	processToStop.once("exit", () => clearTimeout(killTimer));
}

function readSessionSummary(sessionPath) {
	// Session files are JSONL with the header first. Read a bounded prefix so a
	// multi-megabyte transcript never blocks the UI.
	let fd;
	try {
		fd = openSync(sessionPath, "r");
		const fileStat = statSync(sessionPath);
		const buffer = Buffer.alloc(64 * 1024);
		const bytes = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.subarray(0, bytes).toString("utf8");
		const lines = text.split("\n");
		const header = JSON.parse(lines[0]);
		if (!header || header.type !== "session") return undefined;

		// Names are session_info entries rather than mutable header fields. Scan
		// bounded prefixes and tails so both automatic names and late renames show
		// in the sidebar without reading an entire multi-megabyte transcript.
		if (fileStat.size > buffer.length) {
			const tail = Buffer.alloc(buffer.length);
			const tailBytes = readSync(fd, tail, 0, tail.length, fileStat.size - tail.length);
			lines.push(...tail.subarray(0, tailBytes).toString("utf8").split("\n").slice(1));
		}
		let sessionName = typeof header.name === "string" ? header.name : undefined;
		for (const line of lines.slice(1)) {
			if (!line.includes('"type":"session_info"')) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.type === "session_info" && typeof entry.name === "string") sessionName = entry.name;
			} catch {
				// The bounded prefix or tail can start or end in the middle of a record.
			}
		}
		return {
			path: sessionPath,
			id: typeof header.id === "string" ? header.id : path.basename(sessionPath, ".jsonl"),
			name: sessionName,
			cwd: typeof header.cwd === "string" ? header.cwd : undefined,
			startTime: typeof header.timestamp === "string" ? header.timestamp : undefined,
			modifiedAt: fileStat.mtimeMs,
			lastUserMessageAt: findLastUserMessageAt(fd, fileStat.size),
		};
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Nothing actionable if the descriptor is already gone.
			}
		}
	}
}

function findLastUserMessageAt(fd, fileSize) {
	const chunkSize = 64 * 1024;
	let end = fileSize;
	let trailing = "";
	while (end > 0) {
		const start = Math.max(0, end - chunkSize);
		const buffer = Buffer.alloc(end - start);
		const bytes = readSync(fd, buffer, 0, buffer.length, start);
		const lines = `${buffer.subarray(0, bytes).toString("utf8")}${trailing}`.split("\n");
		trailing = start > 0 ? lines.shift() || "" : "";
		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index];
			if (!line || !/"type"\s*:\s*"message"/.test(line) || !/"role"\s*:\s*"user"/.test(line)) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.type !== "message" || entry.message?.role !== "user") continue;
				const timestamp = Date.parse(entry.timestamp);
				if (Number.isFinite(timestamp)) return timestamp;
			} catch {
				// Ignore malformed records and continue searching earlier entries.
			}
		}
		end = start;
	}
	return undefined;
}

function listSessions(payload = {}) {
	const sessionsDir = getSessionsDir();
	if (!existsSync(sessionsDir)) return { sessions: [], sessionsDir };
	const workspace = typeof payload?.workspace === "string" ? workspaceKey(payload.workspace) : undefined;
	const { sessionWorkspaces } = getWorkspaceStore();
	const limit = Number.isInteger(payload?.limit) ? Math.min(Math.max(payload.limit, 1), 500) : 60;
	const files = readdirSync(sessionsDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => path.join(sessionsDir, entry.name));
	const sessions = [];
	for (const file of files) {
		const parsed = readSessionSummary(file);
		if (!parsed) continue;
		const sessionWorkspace = sessionWorkspaces[sessionWorkspaceKey(file)] || parsed.cwd;
		if (workspace && workspaceKey(sessionWorkspace) !== workspace) continue;
		sessions.push({ ...parsed, cwd: sessionWorkspace });
	}
	sessions.sort(
		(a, b) =>
			(b.lastUserMessageAt ?? Number.NEGATIVE_INFINITY) - (a.lastUserMessageAt ?? Number.NEGATIVE_INFINITY) ||
			b.modifiedAt - a.modifiedAt,
	);
	return { sessions: sessions.slice(0, limit), sessionsDir };
}

function resolveManagedSessionPath(sessionPath) {
	if (typeof sessionPath !== "string" || !sessionPath.trim()) throw new Error("Choose a conversation.");
	const resolved = path.resolve(sessionPath);
	const relative = path.relative(path.resolve(getSessionsDir()), resolved);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || path.extname(resolved) !== ".jsonl") {
		throw new Error("That conversation is outside Prometheus's session directory.");
	}
	if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error("That conversation no longer exists.");
	return resolved;
}

function renameSession(payload = {}) {
	const sessionPath = resolveManagedSessionPath(payload?.sessionPath);
	const name = typeof payload?.name === "string" ? payload.name.trim() : "";
	if (!name) throw new Error("Conversation name cannot be empty.");
	if (name.length > 200 || /[\r\n]/.test(name)) throw new Error("Keep the conversation name to one line and under 200 characters.");
	SessionManager.open(sessionPath).appendSessionInfo(name);
	return { sessionPath, name };
}

async function trashSession(payload = {}) {
	const sessionPath = resolveManagedSessionPath(payload?.sessionPath);
	await shell.trashItem(sessionPath);
	if (existsSync(sessionPath)) throw new Error("Could not move the conversation to the system trash.");
	const workspaceStore = getWorkspaceStore();
	delete workspaceStore.sessionWorkspaces[sessionWorkspaceKey(sessionPath)];
	writeFileSync(getWorkspacesPath(), `${JSON.stringify(workspaceStore)}\n`, "utf8");
	return { sessionPath };
}

function getWorkspaceChangeReview(payload = {}) {
	const sessionPath = resolveManagedSessionPath(payload?.sessionPath);
	const session = SessionManager.open(sessionPath);
	const artifactDir = session.getSessionArtifactDir();
	if (!artifactDir) throw new Error("This conversation does not have a change-review snapshot.");
	return {
		review: WorkspaceChangeReview.openOrCreate(session.getCwd(), artifactDir),
		session,
		artifactDir,
	};
}

function listWorkspaceChanges(payload = {}) {
	const sessionPath = resolveManagedSessionPath(payload?.sessionPath);
	return runSessionWorker({ action: "list-workspace-changes", sessionPath, distDir });
}

function applyWorkspaceChanges(payload = {}) {
	const { review } = getWorkspaceChangeReview(payload);
	if (payload.operation === "accept-all") review.acceptAll();
	else if (payload.operation === "reject-all") review.rejectAll();
	else throw new Error("Unknown workspace change operation.");
	return listWorkspaceChanges(payload);
}

const CONTEXT_MENU_ROLES = new Set(["undo", "redo", "cut", "copy", "paste", "selectAll"]);

function showContextMenu(event, payload = {}) {
	const items = Array.isArray(payload?.items) ? payload.items.slice(0, 40) : [];
	return new Promise((resolve) => {
		let selected;
		const template = items.flatMap((item) => {
			if (item?.type === "separator") return [{ type: "separator" }];
			if (CONTEXT_MENU_ROLES.has(item?.role)) return [{ role: item.role }];
			if (typeof item?.id !== "string" || typeof item?.label !== "string") return [];
			return [{
				id: item.id.slice(0, 100),
				label: item.label.slice(0, 200),
				enabled: item.enabled !== false,
				type: item.type === "checkbox" ? "checkbox" : "normal",
				checked: item.type === "checkbox" && item.checked === true,
				click: () => {
					selected = item.id;
				},
			}];
		});
		if (!template.length) {
			resolve(undefined);
			return;
		}
		const window = BrowserWindow.fromWebContents(event.sender);
		Menu.buildFromTemplate(template).popup({
			window,
			callback: () => resolve(selected),
		});
	});
}

// Attaching the engine to a conversation it has not opened yet costs a worker
// spawn — seconds. The transcript on disk is the same message list the engine
// would return, so the renderer paints from here immediately and reconciles with
// the engine's copy once it attaches.
function readSessionMessages(payload = {}) {
	const sessionPath = typeof payload?.sessionPath === "string" ? payload.sessionPath : "";
	if (!sessionPath || !existsSync(sessionPath)) return { messages: [] };
	try {
		return { messages: SessionManager.open(sessionPath).buildSessionContext().messages };
	} catch {
		// A half-written or malformed transcript just means the engine's copy is
		// the first one the renderer gets to show.
		return { messages: [] };
	}
}

// Subagents are only announced through live rlm_child_update events, which are
// gone once the app restarts or the daemon evicts the run. The worker also
// appends every spawn to a per-session registry beside the transcript, and that
// is what survives; the desktop reads it so a reopened chat still shows them.
function listSessionSubagents(payload = {}) {
	const sessionPath = typeof payload?.sessionPath === "string" ? payload.sessionPath : "";
	if (!sessionPath) return { subagents: [] };
	const summary = readSessionSummary(sessionPath);
	if (!summary) return { subagents: [] };
	const sessionsDir = path.dirname(path.resolve(sessionPath));
	const registryPath = path.join(path.dirname(sessionsDir), "session-artifacts", summary.id, "rlm-subagents.jsonl");
	let contents;
	try {
		contents = readFileSync(registryPath, "utf8");
	} catch {
		// No registry means this session never spawned anything.
		return { subagents: [] };
	}
	// The registry is append-only history: the last entry for a child wins.
	const latest = new Map();
	for (const line of contents.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "rlm_subagent" && typeof entry.childId === "string") latest.set(entry.childId, entry);
		} catch {
			// Ignore malformed history exactly like the owning worker does.
		}
	}
	const subagents = [];
	for (const entry of latest.values()) {
		if (entry.status === "deleted") continue;
		subagents.push({
			id: entry.childId,
			label: typeof entry.prompt === "string" ? entry.prompt : undefined,
			sessionName: typeof entry.sessionName === "string" ? entry.sessionName : undefined,
			sessionFile: typeof entry.sessionFile === "string" ? entry.sessionFile : undefined,
			completed: entry.status === "completed",
			createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : undefined,
		});
	}
	subagents.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
	return { subagents };
}

function readCodingAgentVersion() {
	try {
		const manifest = JSON.parse(readFileSync(path.join(repoRoot, "packages", "coding-agent", "package.json"), "utf8"));
		return typeof manifest.version === "string" ? manifest.version : undefined;
	} catch {
		return undefined;
	}
}

function getTheme() {
	// Load the exact colors the CLI resolves, including a user's custom theme, so
	// the desktop and the terminal client render the same palette.
	try {
		process.env.PROMETHEUS_CODING_AGENT_DIR = getAgentDataDir();
		const { getResolvedThemeColors, getThemeExportColors } = require(
			path.join(distDir, "modes", "interactive", "theme", "theme.js"),
		);
		let themeName;
		try {
			const settings = JSON.parse(readFileSync(path.join(getAgentDataDir(), "settings.json"), "utf8"));
			if (settings && typeof settings.theme === "string") themeName = settings.theme;
		} catch {
			// No settings file, or unreadable: fall back to the default theme.
		}
		return {
			name: themeName || "prime",
			colors: getResolvedThemeColors(themeName),
			exportColors: getThemeExportColors(themeName),
		};
	} catch (error) {
		return { name: "prime", colors: {}, exportColors: {}, error: error.message };
	}
}

function saveProviderApiKey(payload = {}) {
	const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
	const apiKey = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : "";
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
		throw new Error("Choose a valid provider.");
	}
	if (!apiKey || apiKey.length > 16_384 || /[\r\n]/.test(apiKey)) {
		throw new Error("Paste a valid API key.");
	}

	const agentDataDir = getAgentDataDir();
	const authPath = path.join(agentDataDir, "auth.json");
	mkdirSync(agentDataDir, { recursive: true, mode: 0o700 });

	let auth = {};
	if (existsSync(authPath)) {
		try {
			auth = JSON.parse(readFileSync(authPath, "utf8"));
		} catch {
			throw new Error("Prometheus's credentials file is not valid JSON.");
		}
		if (!auth || Array.isArray(auth) || typeof auth !== "object") {
			throw new Error("Prometheus's credentials file has an invalid format.");
		}
	}

	// Stop the child only after validating the existing credentials so a bad
	// auth.json cannot leave the desktop agent disconnected.
	stopAgent();
	auth[provider] = { type: "api_key", key: apiKey };
	writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
	chmodSync(authPath, 0o600);
	return { provider };
}

function rejectProviderLoginPrompts(activeLogin, error) {
	for (const prompt of activeLogin.prompts.values()) prompt.reject(error);
	activeLogin.prompts.clear();
}

function cancelProviderLogin() {
	if (!activeProviderLogin) return { cancelled: false };
	const error = new Error("Login cancelled");
	activeProviderLogin.controller.abort();
	rejectProviderLoginPrompts(activeProviderLogin, error);
	return { cancelled: true };
}

function respondProviderLoginPrompt(payload = {}) {
	const promptId = typeof payload?.id === "string" ? payload.id : "";
	const prompt = activeProviderLogin?.prompts.get(promptId);
	if (!prompt) return { accepted: false };
	activeProviderLogin.prompts.delete(promptId);
	if (payload?.cancelled === true) {
		prompt.reject(new Error("Login cancelled"));
	} else {
		prompt.resolve(typeof payload?.value === "string" ? payload.value : "");
	}
	return { accepted: true };
}

async function loginProvider(payload = {}) {
	const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
	if (!OAUTH_PROVIDER_IDS.has(provider)) {
		throw new Error("Subscription sign-in is not available for this provider.");
	}
	if (activeProviderLogin) throw new Error("A provider sign-in is already in progress.");

	const controller = new AbortController();
	const activeLogin = { controller, provider, prompts: new Map() };
	activeProviderLogin = activeLogin;
	sendToRenderer("provider:login-event", { type: "started", provider });

	const waitForPrompt = (prompt) => {
		const id = `provider_login_${++providerLoginPromptCounter}`;
		return new Promise((resolve, reject) => {
			activeLogin.prompts.set(id, { resolve, reject });
			sendToRenderer("provider:login-event", {
				type: "prompt",
				id,
				message: prompt.message,
				placeholder: prompt.placeholder,
			});
		});
	};

	try {
		const authStorage = AuthStorage.create(path.join(getAgentDataDir(), "auth.json"), { usePrimeCliConfig: false });
		await authStorage.login(provider, {
			onAuth: (info) => {
				sendToRenderer("provider:login-event", {
					type: "auth",
					provider,
					instructions: info.instructions,
					url: info.url,
				});
				void shell.openExternal(info.url).catch((error) => {
					sendToRenderer("provider:login-event", {
						type: "error",
						message: `Could not open the sign-in browser: ${error.message}`,
					});
				});
			},
			onPrompt: waitForPrompt,
			onProgress: (message) => sendToRenderer("provider:login-event", { type: "progress", message }),
			signal: controller.signal,
		});
		sendToRenderer("provider:login-event", { type: "success", provider });
		return { provider };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		sendToRenderer("provider:login-event", {
			type: message === "Login cancelled" ? "cancelled" : "error",
			message,
		});
		throw error instanceof Error ? error : new Error(message);
	} finally {
		rejectProviderLoginPrompts(activeLogin, new Error("Login cancelled"));
		if (activeProviderLogin === activeLogin) activeProviderLogin = undefined;
	}
}

function startAgent(options = {}) {
	stopAgent();
	if (!existsSync(cliPath)) {
		throw new Error("Prometheus is not built yet. Run `npm install` and `npm run build` from the repository root first.");
	}
	agentWorkspace = options.cwd || process.cwd();
	const generation = ++agentGeneration;
	const agentDataDir = getAgentDataDir();
	// In development, use the normal Node executable for the RPC child. Running
	// the CLI through Electron's embedded Node runtime is unreliable on Windows
	// (the child can stay alive without ever completing its first handshake).
	// Packaged builds can still opt into a bundled/system Node path explicitly,
	// and fall back to Electron's Node-compatible mode when one is unavailable.
	const useExternalNode = process.env.PROMETHEUS_NODE_PATH || (process.defaultApp ? "node" : "");
	const nodeExecutable = useExternalNode || process.execPath;
	const args = [cliPath, "--mode", "rpc", "--cwd", agentWorkspace];
	if (desktopDaemonSocketPath) args.push("--daemon-socket", desktopDaemonSocketPath);
	// Switching between conversations is a live `open_session` command. A session
	// flag is only for a restart that must land in a specific conversation: the
	// child otherwise resolves its own, which can be one in another workspace.
	if (options.sessionPath) args.push("--resume", options.sessionPath);
	if (options.provider) args.push("--provider", options.provider);
	if (options.model) args.push("--model", options.model);
	if (Array.isArray(options.args)) args.push(...options.args);

	const child = spawn(nodeExecutable, args, {
		cwd: agentWorkspace,
			env: Object.assign({}, process.env, {
			// Electron's executable includes a Node runtime. This flag lets packaged
			// builds run the bundled CLI without requiring a separate Node install.
			PI_CODING_AGENT: "true",
			PROMETHEUS_CODING_AGENT_DIR: agentDataDir,
			PROMETHEUS_INTERNAL_RPC_RESIDENT: "1",
			// The child's stdout is a JSON-lines protocol stream, never a terminal, so
			// nothing under it should emit ANSI. `npm run desktop:*` exports
			// FORCE_COLOR=1 for its lifecycle scripts and Electron passes it down; left
			// in place it collides with the NO_COLOR the agent sets for its own
			// children (Node then warns on every spawn) and can leak escapes into the
			// protocol stream. Unset the forcing vars rather than layering NO_COLOR on
			// top of them.
			FORCE_COLOR: undefined,
			CLICOLOR_FORCE: undefined,
			NO_COLOR: "1",
			CLAUDE_CONFIG_DIR: undefined,
			...(useExternalNode ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
		}),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	agentProcess = child;
	console.log(`[prometheus] started RPC child (generation ${generation}) with ${nodeExecutable}`);

	detachAgentReader = attachJsonlLineReader(
		child.stdout,
		(line) => {
			if (agentProcess !== child) return;
			if (!line.trim()) return;
			try {
				sendToRenderer("agent:event", JSON.parse(line));
			} catch {
				sendToRenderer("agent:stderr", { message: `Agent emitted invalid JSON: ${line.slice(0, 2000)}` });
			}
		},
		{
			maxLineLength: MAX_RPC_LINE_LENGTH,
			onLineOverflow: () => {
				if (agentProcess === child) {
					sendToRenderer("agent:stderr", { message: "Agent emitted an oversized RPC frame; it was discarded." });
				}
			},
		},
	);
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		if (agentProcess !== child) return;
		const message = chunk.toString();
		console.error(`[prometheus] RPC child stderr: ${message.trimEnd()}`);
		sendToRenderer("agent:stderr", { message });
	});
	// Without this listener an EPIPE after the child dies is an unhandled stream
	// error, which takes down the whole Electron main process.
	child.stdin.on("error", (error) => {
		if (agentProcess !== child) return;
		sendToRenderer("agent:stderr", { message: `Agent input stream error: ${error.message}` });
	});
	child.on("error", (error) => {
		if (agentProcess !== child) return;
		console.error(`[prometheus] RPC child error: ${error.message}`);
		sendToRenderer("agent:error", { message: error.message });
	});
	child.on("exit", (code, signal) => {
		console.log(`[prometheus] RPC child exited with code=${code} signal=${signal ?? "none"}`);
		if (agentProcess !== child) return;
		agentProcess = undefined;
		detachAgentReader = undefined;
		sendToRenderer("agent:exit", { code, signal, workspace: agentWorkspace, generation });
	});

	sendToRenderer("agent:started", { workspace: agentWorkspace, generation, agentDataDir });
	return { workspace: agentWorkspace, generation, agentDataDir };
}

function sendCommand(command) {
	const child = agentProcess;
	if (!child?.stdin?.writable) throw new Error("Agent is not running");
	return new Promise((resolve, reject) => {
		child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
			if (error) reject(new Error(`Could not send ${command?.type ?? "command"}: ${error.message}`));
			else resolve({ delivered: true });
		});
	});
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 920,
		minWidth: 860,
		minHeight: 640,
		backgroundColor: "#050506",
		icon: existsSync(appIconPath) ? appIconPath : undefined,
		// Show the shell immediately. If the renderer or agent takes longer to
		// initialize, the user still gets a real desktop window instead of an
		// invisible Electron process.
		show: true,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.cjs"),
			// The Windows platform spellchecker resolves its store relative to the
			// process cwd here, littering the repo root and apps/desktop with an empty
			// <random>/Microsoft/Spelling/neutral tree on every launch. Nothing in this
			// UI is a rich text surface that needs spellcheck, so turn it off.
			spellcheck: false,
		},
	});
	mainWindow.maximize();
	if (existsSync(appIconPath)) mainWindow.setIcon(appIconPath);
	if (process.platform === "darwin" && existsSync(appIconPngPath)) app.dock.setIcon(appIconPngPath);
	mainWindow.setTitle("Prometheus");
	Menu.setApplicationMenu(null);

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url).catch((error) => {
			console.error(`Could not open external link: ${error.message}`);
		});
		return { action: "deny" };
	});
	mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
		if (level >= 2) console.error(`Renderer ${sourceId}:${line}: ${message}`);
	});
	mainWindow.webContents.on("did-finish-load", () => {
		mainWindow.show();
		mainWindow.focus();
		console.log(`[prometheus] renderer loaded; window visible=${mainWindow.isVisible()}`);
	});
	mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
		console.error(`[prometheus] renderer failed to load (${code}): ${description} ${validatedURL}`);
	});
	serveRenderer();
	mainWindow.on("closed", () => {
		stopAgent();
		rendererServer?.close();
		rendererServer = undefined;
		mainWindow = undefined;
	});
}

function serveRenderer() {
	const rendererRoot = path.join(repoRoot, "apps", "desktop", "renderer");
	rendererServer = http.createServer((request, response) => {
		const requestedPath = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
		const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
		const targetPath = path.resolve(rendererRoot, relativePath);
		const relativeTarget = path.relative(rendererRoot, targetPath);
		if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
			response.writeHead(403);
			response.end("Forbidden");
			return;
		}
		try {
			if (!statSync(targetPath).isFile()) throw new Error("Not a file");
			const contentType = targetPath.endsWith(".html")
				? "text/html; charset=utf-8"
				: targetPath.endsWith(".css")
					? "text/css; charset=utf-8"
					: "text/javascript; charset=utf-8";
			response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
			createReadStream(targetPath).pipe(response);
		} catch {
			response.writeHead(404);
			response.end("Not found");
		}
	});
	rendererServer.listen(0, "127.0.0.1", () => {
		const address = rendererServer.address();
		if (!address || typeof address === "string") return;
		mainWindow.loadURL(`http://127.0.0.1:${address.port}/index.html`).catch((error) => console.error(`Could not load renderer: ${error.message}`));
	});
}

// Pasted images have no path on disk, so park them in a session-scoped temp
// folder until the renderer turns them into provider image blocks.
function savePastedImage({ data, extension } = {}) {
	if (!data) throw new Error("No image data was pasted.");
	const dir = path.join(os.tmpdir(), "prometheus-pasted");
	mkdirSync(dir, { recursive: true });
	const target = path.join(dir, `paste-${Date.now()}.${(extension || "png").replace(/[^a-z0-9]/gi, "") || "png"}`);
	writeFileSync(target, Buffer.from(data));
	return target;
}

async function createImagePreview({ filePath } = {}) {
	if (typeof filePath !== "string" || !filePath.trim()) return undefined;
	const resolved = path.resolve(filePath);
	let stats;
	try {
		stats = statSync(resolved);
	} catch {
		return undefined;
	}
	if (!stats.isFile() || stats.size > MAX_ATTACHMENT_PREVIEW_BYTES) return undefined;

	let preview;
	try {
		preview = await nativeImage.createThumbnailFromPath(resolved, { width: 104, height: 104 });
	} catch {
		preview = nativeImage.createFromPath(resolved);
	}
	return preview?.isEmpty() ? undefined : preview.toDataURL();
}

function detectImageMimeType(buffer) {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
	if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
	if (
		buffer.length >= 12 &&
		buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
		buffer.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	return undefined;
}

function readImageAttachment({ filePath } = {}) {
	if (typeof filePath !== "string" || !filePath.trim()) throw new Error("Choose an image to attach.");
	const resolved = path.resolve(filePath);
	let stats;
	try {
		stats = statSync(resolved);
	} catch {
		throw new Error(`Could not read image: ${path.basename(resolved)}`);
	}
	if (!stats.isFile() || stats.size === 0) throw new Error(`Could not read image: ${path.basename(resolved)}`);
	if (stats.size > MAX_IMAGE_ATTACHMENT_BYTES) {
		throw new Error(`${path.basename(resolved)} is too large to attach. Keep images under 32 MB.`);
	}
	let buffer = readFileSync(resolved);
	let mimeType = detectImageMimeType(buffer);
	if (!mimeType) {
		const image = nativeImage.createFromPath(resolved);
		if (image.isEmpty()) throw new Error(`${path.basename(resolved)} is not a supported image.`);
		buffer = image.toPNG();
		mimeType = "image/png";
	}
	if (buffer.length > MAX_IMAGE_ATTACHMENT_BYTES) {
		throw new Error(`${path.basename(resolved)} is too large to attach. Keep images under 32 MB.`);
	}
	return { type: "image", data: buffer.toString("base64"), mimeType };
}

// Windows dictation is a system toggle on Win+H; there is no API for it, so
// synthesize the chord against the focused window.
function startWindowsDictation() {
	if (process.platform !== "win32") throw new Error("Voice input needs Windows dictation.");
	const script = [
		'Add-Type -Namespace Native -Name Keys -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, int e);\'',
		"[Native.Keys]::keybd_event(0x5B,0,0,0)",
		"[Native.Keys]::keybd_event(0x48,0,0,0)",
		"[Native.Keys]::keybd_event(0x48,0,2,0)",
		"[Native.Keys]::keybd_event(0x5B,0,2,0)",
	].join("; ");
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		windowsHide: true,
		stdio: "ignore",
	});
	child.unref();
}

app.whenReady().then(() => {
	ipcMain.handle("agent:start", (_event, options) => startAgent(options));
	ipcMain.handle("agent:stop", () => stopAgent());
	ipcMain.handle("agent:send", (_event, command) => sendCommand(command));
	ipcMain.handle("provider:save-api-key", (_event, payload) => saveProviderApiKey(payload));
	ipcMain.handle("provider:login", (_event, payload) => loginProvider(payload));
	ipcMain.handle("provider:login-cancel", () => cancelProviderLogin());
	ipcMain.handle("provider:login-prompt-response", (_event, payload) => respondProviderLoginPrompt(payload));
	ipcMain.handle("sessions:list", (_event, payload) => listSessions(payload));
	ipcMain.handle("sessions:read", (_event, payload) => readSessionMessages(payload));
	ipcMain.handle("sessions:subagents", (_event, payload) => listSessionSubagents(payload));
	ipcMain.handle("sessions:rename", (_event, payload) => renameSession(payload));
	ipcMain.handle("sessions:trash", (_event, payload) => trashSession(payload));
	ipcMain.handle("workspace-changes:list", (_event, payload) => listWorkspaceChanges(payload));
	ipcMain.handle("workspace-changes:apply", (_event, payload) => applyWorkspaceChanges(payload));
	ipcMain.handle("context-menu:show", (event, payload) => showContextMenu(event, payload));
	ipcMain.handle("theme:get", () => getTheme());
	ipcMain.handle("agent:paths", () => ({
		agentDataDir: getAgentDataDir(),
		sessionsDir: getSessionsDir(),
		logsDir: path.join(getAgentDataDir(), "logs"),
		home: os.homedir(),
		version: readCodingAgentVersion(),
		cliPath,
		daemonSocket: desktopDaemonSocketPath,
	}));
	// No workspace chosen yet: start the engine in a small dedicated scratch
	// folder instead of the repo root, so it's warm by the time one is picked.
	ipcMain.handle("workspace:default", () => getIdleWorkspaceDir());
	ipcMain.handle("workspace:list", () => getSavedWorkspaces());
	ipcMain.handle("workspace:save", (_event, payload) => saveWorkspaces(payload));
	ipcMain.handle("workspace:create-session", (_event, payload) => createWorkspaceSession(payload));
	ipcMain.handle("workspace:choose", async () => {
		const result = await dialog.showOpenDialog(mainWindow, {
			properties: ["openDirectory", "createDirectory"],
			title: "Choose an agent workspace",
		});
		return result.canceled ? undefined : result.filePaths[0];
	});
	ipcMain.handle("files:choose", async () => {
		const result = await dialog.showOpenDialog(mainWindow, {
			properties: ["openFile", "multiSelections"],
			title: "Attach files",
		});
		return result.canceled ? [] : result.filePaths;
	});
	ipcMain.handle("files:save-pasted-image", (_event, payload) => savePastedImage(payload));
	ipcMain.handle("files:image-preview", (_event, payload) => createImagePreview(payload));
	ipcMain.handle("files:image-attachment", (_event, payload) => readImageAttachment(payload));
	ipcMain.handle("dictation:start", () => startWindowsDictation());
	ipcMain.handle("shell:open-path", (_event, target) => shell.openPath(target));
	ipcMain.handle("shell:show-item", (_event, target) => shell.showItemInFolder(target));
	ipcMain.handle("shell:open-external", (_event, target) => shell.openExternal(target));
	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	stopAgent();
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => stopAgent({ graceMs: 1000 }));

// Exported for the registry-reader check; the app itself goes through IPC.
module.exports = { detectImageMimeType, listSessionSubagents, readImageAttachment, readSessionMessages };

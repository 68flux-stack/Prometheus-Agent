const state = {
	workspace: "",
	workspaces: [],
	workspaceChats: new Map(),
	sessionName: "New conversation",
	collapsedWorkspaces: new Set(),
	ready: false,
	busy: false,
	messages: [],
	tools: [],
	models: [],
	commands: [],
	model: undefined,
	thinkingLevel: "off",
	requestId: 0,
	streamIndex: -1,
	activeSessionPath: "",
	switchingSession: false,
	// Bumped on every switch so responses and disk reads from a conversation the
	// user has already clicked past are dropped instead of painting over the new one.
	switchToken: 0,
	// The workspace a switch was made for, checked against the cwd the engine
	// reports once it attaches.
	openedWorkspace: undefined,
	queuedPrompt: undefined,
	pending: new Map(),
	runtimeFeatures: undefined,
	runtimeAvailable: true,
	jobOutputs: new Map(),
	waitingJobs: new Set(),
	jobBannerExpanded: false,
	busySessions: new Set(),
	subagents: new Map(),
	approval: undefined,
	subagentView: undefined,
	attachments: [],
	workspaceChanges: [],
	changeReviewExpanded: true,
	changeReviewPending: false,
	changeReviewRequest: 0,
};

const $ = (id) => document.getElementById(id);
const conversation = $("conversation");
const mainPanel = document.querySelector(".main-panel");
const subagentBackButton = $("subagent-back-button");
const headerSubagent = $("header-subagent");
const subagentSeparator = $("subagent-separator");
const workspaceList = $("workspace-list");
const sidebar = document.querySelector(".sidebar");
const sidebarResizer = $("sidebar-resizer");
const input = $("prompt-input");
const attachmentList = $("attachment-list");
const sendButton = $("send-button");
const modelSelect = $("model-select");
const thinkingSelect = $("thinking-select");
const connectionDot = $("connection-dot");
const connectionLabel = $("connection-label");
const stopButton = $("stop-button");
const connectProviderButton = $("connect-provider-button");
const providerDialog = $("provider-dialog");
const providerForm = $("provider-form");
const providerSelect = $("provider-select");
const providerKeyHelp = $("provider-key-help");
const providerApiKey = $("provider-api-key");
const providerConnect = $("provider-connect");
const providerConnectLabel = $("provider-connect-label");
const subscriptionLoginButton = $("subscription-login-button");
const secretToggle = $("secret-toggle");
const interactionDialog = $("interaction-dialog");
const interactionForm = $("interaction-form");
const interactionField = $("interaction-field");
const interactionSubmit = $("interaction-submit");
const commandMenu = $("command-menu");
const runtimeDrawer = $("runtime-drawer");
const jobList = $("job-list");
const worktreeList = $("worktree-list");
const jobBanner = $("job-banner");
const jobBannerToggle = $("job-banner-toggle");
const jobBannerList = $("job-banner-list");
const jobBannerLabel = $("job-banner-label");
const changeReview = $("change-review");
const changeReviewFiles = $("change-review-files");
const changeReviewToggle = $("change-review-toggle");
const acceptAllChanges = $("accept-all-changes");
const rejectAllChanges = $("reject-all-changes");
let handshakeTimer;
// The cwd the engine was silently started in when no workspace was saved yet;
// applyState uses this to avoid turning that fast-start default into a real
// workspace card the moment the engine reports its own cwd.
let pendingDefaultCwd;
let toastTimer;
const SCROLLBAR_SELECTOR = ".workspace-list, .conversation, .message-content pre, .tool-card pre, .diff-lines, .diff-card-body, .change-review-files, .command-menu, .composer textarea, .runtime-scroll, .runtime-output";
const scrollbarTimers = new WeakMap();
let activeInteraction;
let providerLoginInteraction = false;
let providerLoginInProgress = false;

const DEFAULT_DESKTOP_KEYBINDINGS = {
	newSession: { key: "n", ctrlKey: true },
};

const LEGACY_WORKSPACE_STORAGE_KEY = "prime-agent-workspaces";

function workspaceName(workspace) {
	return workspace.split(/[\\/]/).filter(Boolean).pop() || "Workspace";
}

function workspaceKey(workspace) {
	return typeof workspace === "string" ? workspace.replace(/[\\/]+$/, "").toLocaleLowerCase() : "";
}

function loadLegacyWorkspaces() {
	try {
		const stored = JSON.parse(localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY) || "[]");
		return Array.isArray(stored) ? [...new Set(stored.filter((workspace) => typeof workspace === "string" && workspace.trim()))] : [];
	} catch {
		return [];
	}
}

async function loadStoredWorkspaces() {
	try {
		const result = await window.desktopAgent.listWorkspaces();
		if (Array.isArray(result?.workspaces) && result.workspaces.length) return result.workspaces;
		const legacyWorkspaces = loadLegacyWorkspaces();
		if (legacyWorkspaces.length) await window.desktopAgent.saveWorkspaces({ workspaces: legacyWorkspaces });
		return legacyWorkspaces;
	} catch {
		return loadLegacyWorkspaces();
	}
}

function saveStoredWorkspaces() {
	void window.desktopAgent.saveWorkspaces({ workspaces: state.workspaces }).catch(() => {});
}

function renderWorkspaceList() {
	workspaceList.replaceChildren();
	for (const workspace of state.workspaces) {
		const card = document.createElement("article");
		const collapsed = state.collapsedWorkspaces.has(workspace);
		card.className = `workspace-card${workspace === state.workspace ? " active" : ""}${collapsed ? " collapsed" : ""}`;
		card.dataset.workspace = workspace;
		const header = document.createElement("div");
		header.className = "workspace-card-header";
		const selectButton = document.createElement("button");
		selectButton.className = "workspace-card-select";
		selectButton.type = "button";
		selectButton.dataset.selectWorkspace = workspace;
		selectButton.title = workspace;
		selectButton.innerHTML = '<svg class="workspace-card-folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.5h4l1.3 1.45h7.2v6.3a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1V4.5Z"/></svg>';
		const name = document.createElement("span");
		name.className = "workspace-card-name";
		name.textContent = workspaceName(workspace);
		selectButton.appendChild(name);
		const newSessionButton = document.createElement("button");
		newSessionButton.className = "workspace-card-new-session";
		newSessionButton.type = "button";
		newSessionButton.dataset.newSessionWorkspace = workspace;
		newSessionButton.title = `New conversation in ${workspaceName(workspace)}`;
		newSessionButton.setAttribute("aria-label", newSessionButton.title);
		newSessionButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11"/></svg>';
		const collapseButton = document.createElement("button");
		collapseButton.className = "workspace-card-collapse";
		collapseButton.type = "button";
		collapseButton.dataset.collapseWorkspace = workspace;
		collapseButton.title = `${collapsed ? "Expand" : "Collapse"} ${workspaceName(workspace)}`;
		collapseButton.setAttribute("aria-label", collapseButton.title);
		collapseButton.setAttribute("aria-expanded", String(!collapsed));
		collapseButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
		header.append(selectButton, newSessionButton, collapseButton);
		if (!collapsed) {
			for (const chat of state.workspaceChats.get(workspace) || []) {
				const session = document.createElement("button");
				const active = workspace === state.workspace && chat.path === state.activeSessionPath;
				session.className = `workspace-card-session${active ? " active" : ""}`;
				session.type = "button";
				session.dataset.sessionPath = chat.path;
				session.dataset.sessionWorkspace = workspace;
				if (active) session.setAttribute("aria-current", "page");
				if (isSessionWorking(chat.path)) session.append(createWorkingIndicator());
				const sessionName = document.createElement("div");
				sessionName.className = "workspace-card-session-name";
				sessionName.textContent = chat.name;
				session.append(sessionName);
				card.append(session);
			}
		}
		card.prepend(header);
		workspaceList.appendChild(card);
	}
}

function sessionPathKey(sessionPath) {
	return typeof sessionPath === "string" ? sessionPath.toLocaleLowerCase() : "";
}

function isSessionWorking(sessionPath) {
	if (!sessionPath) return false;
	// The attached chat reports itself live; the others are only known from the
	// poll, which is up to a poll interval behind.
	if (sessionPathKey(sessionPath) === sessionPathKey(state.activeSessionPath)) return state.busy;
	return state.busySessions.has(sessionPathKey(sessionPath));
}

function createWorkingIndicator() {
	const indicator = document.createElement("span");
	indicator.className = "session-working";
	indicator.title = "Still working";
	indicator.setAttribute("aria-label", "Still working");
	indicator.innerHTML = "<i></i>".repeat(9);
	return indicator;
}

// Seed the transcript's subagent rows from the on-disk registry. Live
// rlm_child_update events overwrite these by id, so a subagent still running in
// the daemon keeps its live status.
async function restoreSubagents(sessionPath) {
	if (!sessionPath) return;
	let subagents;
	try {
		({ subagents } = await window.desktopAgent.listSessionSubagents({ sessionPath }));
	} catch {
		// A missing or unreadable registry just means no rows to restore.
		return;
	}
	if (sessionPathKey(sessionPath) !== sessionPathKey(state.activeSessionPath)) return;
	for (const subagent of subagents || []) {
		if (!subagent?.id) continue;
		const previous = state.subagents.get(subagent.id);
		// No live status: the registry's "running" outlives the process that wrote it,
		// so isSubagentWorking asks the busy poll instead of trusting it. A live
		// snapshot wins for status while the registry supplies its session file.
		state.subagents.set(subagent.id, {
			...subagent,
			...previous,
			sessionFile: subagent.sessionFile || previous?.sessionFile,
			status: previous?.status ?? (subagent.completed ? "done" : undefined),
		});
	}
	renderMessages();
}

function refreshBusySessions() {
	// A poll costs the daemon a summary refresh per running agent, so skip it
	// while the window is hidden — nothing can be seen changing anyway.
	if (!state.ready || document.hidden) return;
	sendCommand("list_busy_sessions");
}

function toggleWorkspaceCollapse(workspace) {
	if (state.collapsedWorkspaces.has(workspace)) state.collapsedWorkspaces.delete(workspace);
	else state.collapsedWorkspaces.add(workspace);
	renderWorkspaceList();
}

function openWorkspace(workspace) {
	state.collapsedWorkspaces.delete(workspace);
	renderWorkspaceList();
}

async function refreshWorkspaceChats(workspace) {
	if (!workspace) return;
	try {
		const result = await window.desktopAgent.listSessions({ workspace, limit: 60 });
		const chats = (result?.sessions || [])
			.filter((session) => workspaceKey(session.cwd) === workspaceKey(workspace))
			.filter((session) => Number.isFinite(session.lastUserMessageAt))
			.map((session) => ({
				id: session.id,
				name: session.name || "Untitled session",
				path: session.path,
			}));
		state.workspaceChats.set(workspace, chats);
		renderWorkspaceList();
	} catch (error) {
		showToast(`Could not load conversation history: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function rememberWorkspace(workspace) {
	if (!workspace) return;
	if (!state.workspaces.includes(workspace)) state.workspaces = [...state.workspaces, workspace].slice(0, 12);
	saveStoredWorkspaces();
	renderWorkspaceList();
}

const API_KEY_PROVIDERS = [
	{ id: "prime-inference", name: "Prime Inference", description: "Use a Prime API key for Prime Inference models." },
	{ id: "openai", name: "OpenAI", description: "Use an OpenAI API key for GPT models.", oauthProvider: "openai-codex" },
	{ id: "anthropic", name: "Anthropic", description: "Use an Anthropic API key for Claude models.", oauthProvider: "anthropic" },
	{ id: "google", name: "Google Gemini", description: "Use a Gemini API key for Google models." },
	{ id: "openrouter", name: "OpenRouter", description: "Use an OpenRouter API key for its model catalog." },
	{ id: "deepseek", name: "DeepSeek", description: "Use a DeepSeek API key for DeepSeek models." },
	{ id: "mistral", name: "Mistral", description: "Use a Mistral API key for Mistral models." },
	{ id: "xai", name: "xAI", description: "Use an xAI API key for Grok models." },
	{ id: "groq", name: "Groq", description: "Use a Groq API key for Groq-hosted models." },
	{ id: "zai", name: "ZAI", description: "Use a ZAI API key for GLM models." },
	{ id: "cerebras", name: "Cerebras", description: "Use a Cerebras API key for Cerebras-hosted models." },
	{ id: "minimax", name: "MiniMax", description: "Use a MiniMax API key for MiniMax models." },
	{ id: "moonshotai", name: "Moonshot AI", description: "Use a Moonshot API key for Kimi models." },
	{ id: "huggingface", name: "Hugging Face", description: "Use a Hugging Face token for hosted models." },
	{ id: "fireworks", name: "Fireworks", description: "Use a Fireworks API key for hosted models." },
	{ id: "opencode", name: "OpenCode Zen", description: "Use an OpenCode API key for OpenCode Zen models." },
	{ id: "opencode-go", name: "OpenCode Go", description: "Use an OpenCode API key for OpenCode Go models." },
	{ id: "kimi-coding", name: "Kimi For Coding", description: "Use a Kimi API key for coding models." },
	{ id: "azure-openai-responses", name: "Azure OpenAI", description: "Use an Azure OpenAI API key for your configured resource." },
	{ id: "vercel-ai-gateway", name: "Vercel AI Gateway", description: "Use an AI Gateway API key for routed models." },
	{ id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", description: "Use a Cloudflare API key with an account ID." },
	{ id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", description: "Use a Cloudflare API key with account and gateway settings." },
	{ id: "xiaomi", name: "Xiaomi MiMo", description: "Use a Xiaomi MiMo API key for MiMo models." },
];

function showToast(message) {
	const toast = $("toast");
	toast.textContent = message;
	toast.classList.add("visible");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove("visible"), 4200);
}

function revealScrollbar(target) {
	if (!(target instanceof Element)) return;
	const scrollable = target.closest(SCROLLBAR_SELECTOR);
	if (!scrollable || (scrollable.scrollHeight <= scrollable.clientHeight && scrollable.scrollWidth <= scrollable.clientWidth)) return;
	scrollable.classList.add("scrollbar-visible");
	clearTimeout(scrollbarTimers.get(scrollable));
	scrollbarTimers.set(scrollable, setTimeout(() => scrollable.classList.remove("scrollbar-visible"), 900));
}

function getSelectedProvider() {
	return API_KEY_PROVIDERS.find((provider) => provider.id === providerSelect.value) || API_KEY_PROVIDERS[0];
}

function updateProviderKeyHelp() {
	const provider = getSelectedProvider();
	providerKeyHelp.textContent = provider?.description || "Paste the API key for the selected provider.";
	subscriptionLoginButton.disabled = !provider?.oauthProvider;
	subscriptionLoginButton.title = provider?.oauthProvider ? "" : "Subscription sign-in is not available for this provider.";
}

function populateProviderOptions() {
	providerSelect.replaceChildren();
	for (const provider of API_KEY_PROVIDERS) {
		providerSelect.add(new Option(provider.name, provider.id));
	}
	providerSelect.value = API_KEY_PROVIDERS[0]?.id || "";
	updateProviderKeyHelp();
}

function closeProviderDialog() {
	if (providerDialog.open) providerDialog.close();
	providerApiKey.value = "";
}

function openProviderDialog() {
	if (state.busy) {
		showToast("Wait for the current turn to finish before changing provider credentials.");
		return;
	}
	populateProviderOptions();
	providerApiKey.value = "";
	providerApiKey.type = "password";
	secretToggle.textContent = "Show";
	secretToggle.setAttribute("aria-pressed", "false");
	providerConnect.disabled = false;
	providerConnectLabel.textContent = "Connect provider";
	providerDialog.showModal();
	requestAnimationFrame(() => providerApiKey.focus());
}

async function connectSelectedProvider() {
	if (state.busy) {
		showToast("Wait for the current turn to finish before changing provider credentials.");
		return;
	}
	const provider = getSelectedProvider();
	const apiKey = providerApiKey.value.trim();
	if (!provider || !apiKey) {
		providerKeyHelp.textContent = "Paste an API key to continue.";
		providerApiKey.focus();
		return;
	}

	providerConnect.disabled = true;
	providerConnectLabel.textContent = "Saving…";
	try {
		await window.desktopAgent.saveProviderApiKey({ provider: provider.id, apiKey });
		closeProviderDialog();
		state.models = [];
		updateModelOptions();
		showToast(`Connected ${provider.name}. Refreshing models…`);
		if (state.workspace) {
			await startWorkspace(state.workspace);
		} else {
			// No workspace chosen yet: restart the engine (to pick up the new
			// credentials) in the same silent idle default, not as a workspace card.
			pendingDefaultCwd = pendingDefaultCwd || (await window.desktopAgent.getDefaultWorkspace());
			await startWorkspace(pendingDefaultCwd, { silent: true });
		}
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error));
	} finally {
		providerConnect.disabled = false;
		providerConnectLabel.textContent = "Connect provider";
	}
}

async function startSubscriptionLogin() {
	if (providerLoginInProgress) return;
	if (state.busy) {
		showToast("Wait for the current turn to finish before changing provider credentials.");
		return;
	}
	const provider = getSelectedProvider();
	if (!provider?.oauthProvider) {
		showToast(`Subscription sign-in is not available for ${provider?.name || "this provider"}. Use an API key instead.`);
		return;
	}

	providerLoginInProgress = true;
	closeProviderDialog();
	showToast(`Opening ${provider.name} subscription sign-in…`);
	try {
		await window.desktopAgent.loginProvider({ provider: provider.oauthProvider });
		state.models = [];
		updateModelOptions();
		showToast(`Connected ${provider.name}. Refreshing models…`);
		if (state.workspace) {
			await startWorkspace(state.workspace);
		} else {
			// No workspace chosen yet: restart the engine (to pick up the new
			// credentials) in the same silent idle default, not as a workspace card.
			pendingDefaultCwd = pendingDefaultCwd || (await window.desktopAgent.getDefaultWorkspace());
			await startWorkspace(pendingDefaultCwd, { silent: true });
		}
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error));
	} finally {
		providerLoginInProgress = false;
	}
}

function finishInteraction(value) {
	if (!activeInteraction) return;
	const { resolve, timer } = activeInteraction;
	activeInteraction = undefined;
	clearTimeout(timer);
	if (interactionDialog.open) interactionDialog.close();
	interactionField.replaceChildren();
	resolve(value);
}

function openInteraction({ title, message = "", kind = "confirm", options = [], placeholder = "", prefill = "", confirmLabel = "Continue", timeout }) {
	if (activeInteraction) finishInteraction(null);
	$("interaction-title").textContent = title;
	$("interaction-message").textContent = message;
	$("interaction-message").hidden = !message;
	interactionSubmit.textContent = confirmLabel;
	interactionField.replaceChildren();
	let control;
	if (kind === "select") {
		control = document.createElement("select");
		for (const option of options) control.add(new Option(option, option));
	} else if (kind === "input" || kind === "editor") {
		control = document.createElement(kind === "editor" ? "textarea" : "input");
		control.placeholder = placeholder;
		control.value = prefill;
	}
	if (control) interactionField.appendChild(control);
	interactionField.hidden = !control;
	interactionDialog.showModal();
	requestAnimationFrame(() => (control || interactionSubmit).focus());
	return new Promise((resolve) => {
		activeInteraction = {
			resolve,
			kind,
			control,
			timer: timeout ? setTimeout(() => finishInteraction(null), timeout) : undefined,
		};
	});
}

function handleProviderLoginEvent(event) {
	if (!event) return;
	if (event.type === "started") {
		return;
	}
	if (event.type === "auth") {
		showToast(event.instructions || "Complete sign-in in the browser window that opened.");
		return;
	}
	if (event.type === "progress") {
		return;
	}
	if (event.type === "prompt") {
		providerLoginInteraction = true;
		void openInteraction({
			title: "Complete subscription sign-in",
			message: event.message || "Paste the authorization code or redirect URL from the browser.",
			kind: "input",
			placeholder: event.placeholder || "Paste code or redirect URL",
			confirmLabel: "Continue",
		}).then(async (value) => {
			providerLoginInteraction = false;
			if (value === null) {
				await window.desktopAgent.cancelProviderLogin();
			} else {
				await window.desktopAgent.respondProviderLoginPrompt({ id: event.id, value });
			}
		});
		return;
	}
	if (event.type === "error" || event.type === "cancelled") {
		if (providerLoginInteraction) {
			providerLoginInteraction = false;
			finishInteraction(null);
		}
		if (event.type === "error") showToast(event.message || "Subscription sign-in failed.");
	}
}

async function handleExtensionUIRequest(event) {
	if (event.method === "notify") {
		showToast(event.message);
		return;
	}
	if (event.method === "setStatus") {
		return;
	}
	if (event.method === "setTitle") {
		$("header-title").textContent = event.title || "Untitled session";
		return;
	}
	if (event.method === "set_editor_text") {
		input.value = event.text || "";
		input.dispatchEvent(new Event("input"));
		return;
	}
	if (event.method === "setWidget") return;
	if (event.method === "confirm") {
		const approval = { id: event.id, title: event.title || "Approval needed", message: event.message || "" };
		state.approval = approval;
		renderMessages();
		if (event.timeout) {
			setTimeout(() => {
				if (state.approval !== approval) return;
				state.approval = undefined;
				renderMessages();
			}, event.timeout);
		}
		return;
	}

	const value = await openInteraction({
		title: event.title || "Prometheus",
		message: event.message || "",
		kind: event.method,
		options: event.options || [],
		placeholder: event.placeholder || "",
		prefill: event.prefill || "",
		confirmLabel: "Continue",
		timeout: event.timeout,
	});
	if (value === null) {
		await window.desktopAgent.send({ type: "extension_ui_response", id: event.id, cancelled: true });
	} else {
		await window.desktopAgent.send({ type: "extension_ui_response", id: event.id, value });
	}
}

function setStatus(label, tone = "") {
	const connected = state.ready && tone !== "error";
	const connectionTone = connected ? "ready" : tone === "error" ? "error" : "busy";
	connectionDot.className = `connection-dot ${connectionTone}`.trim();
	connectionLabel.textContent = connected
		? "Engine connected"
		: tone === "error"
			? "Engine unavailable"
			: "Connecting…";
}

function hasConfiguredModel() {
	return state.models.length > 0;
}

function updateOnboarding() {
	const needsModel = state.ready && !hasConfiguredModel();
	$("setup-panel").hidden = !needsModel;
	$("welcome-title").textContent = needsModel ? "Connect a model to get started" : "How can I help with this project?";
	$("welcome-description").textContent = needsModel
		? "Prometheus is connected to this workspace. Add a provider before sending your first task."
		: "Prometheus can explore the codebase, plan a change, run tools, or keep a long-running task moving.";
	$("welcome-card").querySelector(".prompt-suggestions").hidden = needsModel;
	connectProviderButton.hidden = needsModel && state.messages.length === 0;
	input.placeholder = needsModel ? "Connect a provider to start…" : state.busy ? "Send an instruction to steer the current turn…" : "Message Prometheus…";
}

// The agent starting up or attaching to a conversation is a wait, not a refusal:
// the composer stays live and the prompt is held until it can be delivered.
function isEngineConnecting() {
	return !state.ready || state.switchingSession;
}

function syncComposer() {
	const canPrompt = !state.subagentView && ((state.ready && hasConfiguredModel()) || isEngineConnecting());
	input.disabled = !canPrompt;
	sendButton.disabled = !canPrompt || (!input.value.trim() && state.attachments.length === 0);
	$("attach-button").disabled = !canPrompt;
	$("dictate-button").disabled = !canPrompt;
	stopButton.hidden = !state.busy;
	$("send-label").textContent = state.busy ? "Steer" : "Send";
	modelSelect.disabled = !state.ready || state.models.length === 0;
	thinkingSelect.disabled = !state.ready || !hasConfiguredModel();
	acceptAllChanges.disabled = state.busy || state.changeReviewPending;
	rejectAllChanges.disabled = state.busy || state.changeReviewPending;
	updateOnboarding();
}

function setBusy(busy, label = busy ? "Working" : "Ready") {
	const changed = state.busy !== busy;
	state.busy = busy;
	conversation.setAttribute("aria-busy", String(busy));
	setStatus(label, busy ? "busy" : state.ready ? "ready" : "busy");
	syncComposer();
	// The open chat's own working indicator reads state.busy, not the poll, and so
	// does the pending-turn row.
	if (changed) {
		renderWorkspaceList();
		renderMessages();
	}
}

function setReady(ready) {
	state.ready = ready;
	syncComposer();
	setStatus(ready ? "" : "Connecting", ready ? "ready" : "busy");
}

function setDisconnected(label) {
	state.ready = false;
	state.busy = false;
	state.switchingSession = false;
	returnQueuedPromptToComposer();
	state.busySessions = new Set();
	conversation.setAttribute("aria-busy", "false");
	renderWorkspaceList();
	syncComposer();
	setStatus("Stopped", "error");
}

function sendCommand(type, payload = {}, context = {}) {
	const id = `desktop_${++state.requestId}`;
	state.pending.set(id, { type, ...context });
	return window.desktopAgent.send({ id, type, ...payload }).catch((error) => {
		state.pending.delete(id);
		showToast(error.message);
	});
}

// Unlike sendCommand, this resolves with the matching response instead of firing
// side effects through handleResponse — for callers that need the result inline.
function sendCommandAwait(type, payload = {}) {
	const id = `desktop_${++state.requestId}`;
	return new Promise((resolve, reject) => {
		state.pending.set(id, { type, resolve, reject });
		window.desktopAgent.send({ id, type, ...payload }).catch((error) => {
			state.pending.delete(id);
			reject(error);
		});
	});
}

function displayWorkspace(workspace) {
	state.workspace = workspace || "";
	$("header-project").textContent = workspaceName(state.workspace);
	renderWorkspaceList();
}

function formatModel(model) {
	if (!model) return "No model selected";
	return model.id;
}

function applyState(data) {
	if (!data) return;
	state.model = data.model;
	state.thinkingLevel = data.thinkingLevel || "off";
	// Mid-switch the engine still reports the conversation we are leaving, so the
	// sidebar, title and workspace follow the click until the handshake catches up.
	if (state.switchingSession) {
		thinkingSelect.value = state.thinkingLevel;
		setBusy(false, "Opening conversation");
		return;
	}
	state.sessionName = data.sessionName || "New conversation";
	state.activeSessionPath = data.sessionFile || "";
	// The sidebar selection is optimistic; the agent's own cwd is the truth about
	// which workspace the next prompt will act on. Never show a workspace we are
	// not actually running in.
	if (data.cwd && workspaceKey(data.cwd) !== workspaceKey(state.workspace)) {
		// Reuse the sidebar's spelling of the same folder: workspaces key the chat
		// and collapse maps by exact string, so a case-only difference would show
		// the workspace twice and highlight neither.
		const known = state.workspaces.find((entry) => workspaceKey(entry) === workspaceKey(data.cwd));
		// A conversation we just opened for one workspace should never come back
		// bound to another. A daemon built before the create-command cwd fix binds
		// sessions to its own directory, and silently following it would run the
		// next prompt's tools in the wrong project.
		if (state.openedWorkspace && workspaceKey(state.openedWorkspace) !== workspaceKey(data.cwd)) {
			showToast(`This conversation opened in ${workspaceName(data.cwd)}, not ${workspaceName(state.openedWorkspace)}. Restart Prometheus to pick up the fix.`);
		}
		const isPendingDefault = !state.workspace && !known && workspaceKey(data.cwd) === workspaceKey(pendingDefaultCwd);
		if (!isPendingDefault) {
			displayWorkspace(known || data.cwd);
			rememberWorkspace(known || data.cwd);
		}
	}
	state.openedWorkspace = undefined;
	thinkingSelect.value = state.thinkingLevel;
	$("header-title").textContent = data.sessionName || "Untitled session";
	renderWorkspaceList();
	setBusy(Boolean(data.isStreaming), data.isStreaming ? "Working · send a message to steer" : "Ready");
	void refreshWorkspaceChanges();
}

function contentText(message) {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block && block.type === "text")
		.map((block) => block.text || "")
		.join("");
}

function textBlockPhase(block) {
	if (block?.type !== "text" || typeof block.textSignature !== "string") return undefined;
	try {
		const signature = JSON.parse(block.textSignature);
		return signature?.v === 1 && ["commentary", "final_answer"].includes(signature.phase)
			? signature.phase
			: undefined;
	} catch {
		return undefined;
	}
}

function hasTextPhase(message, phase) {
	return Array.isArray(message?.content) && message.content.some((block) => textBlockPhase(block) === phase);
}

function phasedText(message, phase) {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block) => block?.type === "text" && textBlockPhase(block) === phase)
		.map((block) => block.text || "")
		.join("");
}

function assistantHasFinalAnswer(message) {
	if (message?.role !== "assistant") return false;
	if (hasTextPhase(message, "final_answer")) return true;
	if (hasTextPhase(message, "commentary") || message._streaming) return false;
	const hasToolCalls = Array.isArray(message.content) && message.content.some((block) => block?.type === "toolCall");
	return Boolean(contentText(message)) && !hasToolCalls && Boolean(message.stopReason) && message.stopReason !== "toolUse";
}

function finalAnswerText(message) {
	return hasTextPhase(message, "final_answer") ? phasedText(message, "final_answer") : contentText(message);
}

function workText(message) {
	if (!hasTextPhase(message, "final_answer")) return contentText(message);
	return message.content
		.filter((block) => block?.type === "text" && textBlockPhase(block) !== "final_answer")
		.map((block) => block.text || "")
		.join("");
}

function contentThinking(message) {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((block) => block && block.type === "thinking")
		.map((block) => block.thinking || "")
		.join("");
}

function formatThinkingSummary(thinking) {
	return thinking.replace(/\*/g, "").trim();
}

function contentImages(message) {
	if (!Array.isArray(message?.content)) return [];
	return message.content.filter((block) => block && block.type === "image");
}

function messageKey(message, index) {
	return message?.id || `${message?.role || "message"}-${message?.timestamp || index}-${index}`;
}

function normalizeMessage(message) {
	return {
		...message,
		_key: message._key || messageKey(message, state.messages.length),
	};
}

// Rows are reconciled by key and updated in place: rebuilding them on every streaming
// event restarted the rise-in animation on every row, which read as the whole chat blinking.
function ensureChild(parent, cls, tag = "div", first = false) {
	let node = parent.querySelector(`:scope > .${cls}`);
	if (!node) {
		node = document.createElement(tag);
		node.className = cls;
		if (first) parent.prepend(node);
		else parent.appendChild(node);
	}
	return node;
}

function setText(node, text) {
	if (node.textContent !== text) node.textContent = text;
}

function formatMessageDate(timestamp) {
	if (!Number.isFinite(timestamp)) return "";
	return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

function formatRelativeTime(timestamp) {
	if (!Number.isFinite(timestamp)) return "";
	const seconds = Math.round((Date.now() - timestamp) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return relativeTimeFormatter.format(-minutes, "minute");
	const hours = Math.round(minutes / 60);
	if (hours < 24) return relativeTimeFormatter.format(-hours, "hour");
	const days = Math.round(hours / 24);
	return relativeTimeFormatter.format(-days, "day");
}

function appendInlineMarkdown(parent, text) {
	const tokenPattern = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g;
	let cursor = 0;
	for (const match of text.matchAll(tokenPattern)) {
		if (match.index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
		if (match[1].startsWith("[")) {
			const href = match[3].trim();
			if (/^https?:\/\//i.test(href)) {
				const link = document.createElement("a");
				link.href = href;
				link.target = "_blank";
				link.rel = "noreferrer noopener";
				link.textContent = match[2];
				parent.appendChild(link);
			} else {
				parent.appendChild(document.createTextNode(match[2]));
			}
		} else if (match[4] !== undefined) {
			const code = document.createElement("code");
			code.textContent = match[4];
			parent.appendChild(code);
		} else if (match[5] !== undefined || match[6] !== undefined) {
			const strong = document.createElement("strong");
			strong.textContent = match[5] ?? match[6];
			parent.appendChild(strong);
		} else {
			const emphasis = document.createElement("em");
			emphasis.textContent = match[7] ?? match[8];
			parent.appendChild(emphasis);
		}
		cursor = match.index + match[0].length;
	}
	if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

function appendMarkdownParagraph(parent, lines) {
	const paragraph = document.createElement("p");
	for (const [index, line] of lines.entries()) {
		if (index) paragraph.appendChild(document.createElement("br"));
		appendInlineMarkdown(paragraph, line);
	}
	parent.appendChild(paragraph);
}

function renderMarkdown(container, markdown) {
	container.replaceChildren();
	const lines = markdown.replaceAll("\r\n", "\n").split("\n");
	let paragraph = [];
	let list;
	let listType;
	let codeLines;
	let codeLanguage = "";

	const flushParagraph = () => {
		if (paragraph.length) appendMarkdownParagraph(container, paragraph);
		paragraph = [];
	};
	const closeList = () => {
		list = undefined;
		listType = undefined;
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (codeLines) {
			if (/^\s*```/.test(line)) {
				const pre = document.createElement("pre");
				const code = document.createElement("code");
				if (codeLanguage) code.className = `language-${codeLanguage}`;
				code.textContent = codeLines.join("\n");
				pre.appendChild(code);
				container.appendChild(pre);
				codeLines = undefined;
				codeLanguage = "";
			} else codeLines.push(line);
			continue;
		}
		const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
		if (fence) {
			flushParagraph();
			closeList();
			codeLines = [];
			codeLanguage = fence[1];
			continue;
		}
		if (!line.trim()) {
			flushParagraph();
			closeList();
			continue;
		}
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			closeList();
			const element = document.createElement(`h${heading[1].length}`);
			appendInlineMarkdown(element, heading[2]);
			container.appendChild(element);
			continue;
		}
		if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
			flushParagraph();
			closeList();
			container.appendChild(document.createElement("hr"));
			continue;
		}
		const tableSeparator = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[index + 1] || "");
		if (/^\s*\|.*\|\s*$/.test(line) && tableSeparator) {
			flushParagraph();
			closeList();
			const table = document.createElement("table");
			const headerRow = document.createElement("tr");
			const headers = line.split("|").slice(1, -1).map((cell) => cell.trim());
			for (const cell of headers) {
				const th = document.createElement("th");
				appendInlineMarkdown(th, cell);
				headerRow.appendChild(th);
			}
			table.appendChild(headerRow);
			index += 1;
			while (index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index + 1])) {
				index += 1;
				const row = document.createElement("tr");
				for (const cell of lines[index].split("|").slice(1, -1).map((value) => value.trim())) {
					const td = document.createElement("td");
					appendInlineMarkdown(td, cell);
					row.appendChild(td);
				}
				table.appendChild(row);
			}
			container.appendChild(table);
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			flushParagraph();
			closeList();
			const blockquote = document.createElement("blockquote");
			appendInlineMarkdown(blockquote, quote[1]);
			container.appendChild(blockquote);
			continue;
		}
		const listItem = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
		if (listItem) {
			flushParagraph();
			const ordered = /^\s*\d/.test(line);
			if (!list || listType !== ordered) {
				closeList();
				listType = ordered;
				list = document.createElement(ordered ? "ol" : "ul");
				container.appendChild(list);
			}
			const item = document.createElement("li");
			if (listItem[1]) {
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.checked = listItem[1].toLowerCase() === "x";
				checkbox.disabled = true;
				item.appendChild(checkbox);
			}
			appendInlineMarkdown(item, listItem[2]);
			list.appendChild(item);
			continue;
		}
		closeList();
		paragraph.push(line);
	}
	if (codeLines) {
		const pre = document.createElement("pre");
		const code = document.createElement("code");
		code.textContent = codeLines.join("\n");
		pre.appendChild(code);
		container.appendChild(pre);
	}
	flushParagraph();
}

const MSG_ACTION_ICONS = {
	edit: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M11.5 2.5l2 2-7.3 7.3H4v-2.2z"/></svg>',
	fork: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="8" r="1.5"/><path d="M4 5v5.5M4 8a4 4 0 0 0 6.5-.7"/></svg>',
	copy: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
	retry: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13 8A5 5 0 1 1 11.4 4.3"/><path d="M13 2.5v3.3h-3.3"/></svg>',
};

// Deliberately not keyed by message._key: that key is recomputed from a
// role/timestamp/array-length fallback on every message_start, message_end, and
// get_messages refresh, so a value baked into the button at render time can go
// stale while the row's visible content (and so its render signature) doesn't
// change - the button silently stops resolving to any message. The click handler
// instead reads the row's position (m:${index}), which buildTranscriptRows recomputes
// fresh on every render and which row reconciliation already relies on being correct.
function createMsgActionButton(action, label) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "msg-action-btn";
	button.dataset.msgAction = action;
	button.title = label;
	button.setAttribute("aria-label", label);
	button.innerHTML = MSG_ACTION_ICONS[action];
	return button;
}

function renderMessageRow(row, message, display = {}) {
	const readOnly = Boolean(state.subagentView);
	const thinking = display.thinking ?? contentThinking(message);
	const text = display.text ?? contentText(message);
	const images = (display.images ?? contentImages(message)).filter((image) => image.data);
	const streaming = display.streaming ?? message._streaming;
	const isThinking = message.role === "assistant" && streaming && state.thinkingLevel !== "off" && Boolean(thinking) && !text;
	const visibleThinking = isThinking ? "Thinking..." : formatThinkingSummary(thinking);
	// A message still in flight has no finished state to act on yet, and an optimistic
	// user row has no server-side entry id for edit/fork to target. Notifications and
	// other custom rows aren't part of the fork-able user/assistant turn sequence.
	const showActions =
		(display.showActions ?? true) &&
		(message.role === "user" || message.role === "assistant") &&
		!message._streaming &&
		!message._optimistic;
	const actionsLabel = !showActions
		? ""
		: message.role === "user"
			? formatMessageDate(message.timestamp)
			: formatRelativeTime(message._finishedAt ?? message.timestamp);
	// Streaming emits one message_update per token and every update re-rendered every
	// row, re-parsing markdown from scratch. Skip rows whose visible content is identical.
	const signature = `${message.role} ${readOnly} ${images.length} ${isThinking} ${visibleThinking} ${text} ${actionsLabel}`;
	if (row._signature === signature) return;
	row._signature = signature;

	row.className = `message-row ${message.role === "user" ? "user" : "assistant"}`;
	const body = ensureChild(row, "message-body");
	if (visibleThinking) {
		const thinkingBlock = ensureChild(body, "thinking-block", "div", true);
		thinkingBlock.dataset.state = isThinking ? "thinking" : "summary";
		setText(thinkingBlock, visibleThinking);
	}
	else body.querySelector(":scope > .thinking-block")?.remove();

	if (text) {
		const content = ensureChild(body, "message-content");
		if (message.role === "assistant") renderMarkdown(content, text);
		else setText(content, text);
	} else {
		body.querySelector(":scope > .message-content")?.remove();
	}

	const rendered = body.querySelectorAll(":scope > img").length;
	for (const image of images.slice(rendered)) {
		const imageNode = document.createElement("img");
		imageNode.src = `data:${image.mimeType || "image/png"};base64,${image.data}`;
		imageNode.alt = "Attached image";
		imageNode.style.maxWidth = "420px";
		imageNode.style.borderRadius = "8px";
		body.appendChild(imageNode);
	}

	if (!showActions) {
		row.querySelector(":scope > .message-actions")?.remove();
		return;
	}
	const actions = ensureChild(row, "message-actions");
	actions.replaceChildren();
	const time = document.createElement("span");
	time.className = "message-actions-time";
	time.textContent = actionsLabel;
	actions.appendChild(time);
	if (readOnly) {
		actions.append(createMsgActionButton("copy", "Copy"));
	} else if (message.role === "user") {
		actions.append(
			createMsgActionButton("edit", "Edit and resend"),
			createMsgActionButton("fork", "Fork from here"),
			createMsgActionButton("copy", "Copy"),
		);
	} else {
		actions.append(createMsgActionButton("retry", "Retry"), createMsgActionButton("copy", "Copy"));
	}
}

function toolResultText(value) {
	if (!value) return "";
	if (typeof value === "string") return value;
	const content = Array.isArray(value) ? value : value.content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block && block.type === "text")
			.map((block) => block.text || "")
			.join("\n")
			.trim();
	}
	return formatToolDetails(value);
}

// One tool card per assistant toolCall block. The runtime entry carries live status while the
// turn streams; the matching toolResult message carries the final content and details.
function mergeTool(call, resultMessage, runtime) {
	const args = call?.arguments ?? runtime?.args;
	const details = resultMessage?.details ?? runtime?.result?.details;
	return {
		toolCallId: call?.id || resultMessage?.toolCallId || runtime?.toolCallId,
		toolName: call?.name || resultMessage?.toolName || runtime?.toolName || "tool",
		args: args && typeof args === "object" ? args : undefined,
		details: details && typeof details === "object" ? details : undefined,
		output: toolResultText(resultMessage || runtime?.result),
		done: Boolean(resultMessage) || Boolean(runtime?.done),
		isError: resultMessage ? Boolean(resultMessage.isError) : Boolean(runtime?.isError),
	};
}

function toolDetails(tool) {
	if (tool.toolName === "ipython") {
		const sections = [];
		const code = typeof tool.args?.code === "string" ? tool.args.code : "";
		const stdout = typeof tool.details?.stdout === "string" ? tool.details.stdout.trim() : "";
		const stderr = typeof tool.details?.stderr === "string" ? tool.details.stderr.trim() : "";
		if (code) sections.push(code);
		if (stdout) sections.push(stdout);
		if (stderr) sections.push(stderr);
		return sections.join("\n\n");
	}
	return tool.output || formatToolDetails(tool.args);
}

function ipythonActivities(tool) {
	const code = typeof tool.args?.code === "string" ? tool.args.code : "";
	return window.PrometheusToolSummary.analyzeIpythonActivities({ code, details: tool.details, workspace: state.workspace });
}

function ipythonSummary(tool) {
	return ipythonActivities(tool).summary;
}

function toolSummary(tool) {
	if (tool.toolName !== "ipython") return tool.toolName;
	return ipythonSummary(tool);
}

// ponytail: O(oldLines * newLines) LCS diff, fine for edit-sized snippets; swap for a real
// diff lib if a single edit routinely spans thousands of lines.
function diffLineParts(oldStr, newStr) {
	const splitLines = (value) => {
		if (value === "") return [];
		const lines = value.replace(/\r\n?/g, "\n").split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines;
	};
	const oldLines = splitLines(oldStr);
	const newLines = splitLines(newStr);
	const n = oldLines.length;
	const m = newLines.length;
	const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const parts = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			parts.push({ type: "ctx", line: oldLines[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			parts.push({ type: "del", line: oldLines[i] });
			i++;
		} else {
			parts.push({ type: "add", line: newLines[j] });
			j++;
		}
	}
	while (i < n) parts.push({ type: "del", line: oldLines[i++] });
	while (j < m) parts.push({ type: "add", line: newLines[j++] });
	return parts;
}

function groupDiffParts(parts) {
	const groups = [];
	for (const part of parts) {
		const last = groups[groups.length - 1];
		if (last && last.type === part.type) last.lines.push(part.line);
		else groups.push({ type: part.type, lines: [part.line] });
	}
	return groups;
}

// Structured port of the CLI's generateDiffString (edit-diff.ts) context-collapsing rules,
// yielding row objects for DOM rendering instead of a formatted string.
function buildDiffRows(oldStr, newStr, startLine, contextLines = 4) {
	const groups = groupDiffParts(diffLineParts(oldStr, newStr));
	const rows = [];
	let oldNo = startLine;
	let newNo = startLine;
	let added = 0;
	let removed = 0;
	let lastWasChange = false;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		if (group.type !== "ctx") {
			for (const line of group.lines) {
				if (group.type === "add") {
					rows.push({ type: "add", newNo, text: line });
					newNo++;
					added++;
				} else {
					rows.push({ type: "del", oldNo, text: line });
					oldNo++;
					removed++;
				}
			}
			lastWasChange = true;
			continue;
		}
		const nextIsChange = i < groups.length - 1 && groups[i + 1].type !== "ctx";
		const pushCtx = (line) => {
			rows.push({ type: "ctx", oldNo, newNo, text: line });
			oldNo++;
			newNo++;
		};
		if (lastWasChange && nextIsChange) {
			if (group.lines.length <= contextLines * 2) {
				group.lines.forEach(pushCtx);
			} else {
				group.lines.slice(0, contextLines).forEach(pushCtx);
				const skipped = group.lines.length - contextLines * 2;
				rows.push({ type: "skip" });
				oldNo += skipped;
				newNo += skipped;
				group.lines.slice(-contextLines).forEach(pushCtx);
			}
		} else if (lastWasChange) {
			const shown = group.lines.slice(0, contextLines);
			shown.forEach(pushCtx);
			const skipped = group.lines.length - shown.length;
			if (skipped > 0) {
				rows.push({ type: "skip" });
				oldNo += skipped;
				newNo += skipped;
			}
		} else if (nextIsChange) {
			const skipped = Math.max(0, group.lines.length - contextLines);
			if (skipped > 0) {
				rows.push({ type: "skip" });
				oldNo += skipped;
				newNo += skipped;
			}
			group.lines.slice(skipped).forEach(pushCtx);
		} else {
			oldNo += group.lines.length;
			newNo += group.lines.length;
		}
		lastWasChange = false;
	}
	return { rows, added, removed };
}

function fileBaseName(path) {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}

function unescapePythonString(text) {
	return text.replace(/\\(\\|'|"|n|r|t|0|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, (whole, esc) => {
		switch (esc[0]) {
			case "\\":
			case "'":
			case '"':
				return esc;
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			case "0":
				return "\0";
			case "x":
			case "u":
				return String.fromCharCode(Number.parseInt(esc.slice(1), 16));
			default:
				return whole;
		}
	});
}

// Best-effort: a raw `write_text`/`write_bytes` call has no structured diff data (no skill
// like `edit` reports one), so recover the written content from the cell's own source — the
// standard shape is `content = """..."""` followed by `Path(path).write_text(content)`.
function extractStringVarLiteral(code, varName) {
	const pattern = new RegExp(
		`(?:^|\\n)[ \\t]*${varName}\\s*=\\s*([a-zA-Z]{0,2})("""[\\s\\S]*?"""|'''[\\s\\S]*?'''|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
	);
	const match = pattern.exec(code);
	if (!match) return undefined;
	const prefix = match[1].toLowerCase();
	const literal = match[2];
	const isTriple = literal.startsWith('"""') || literal.startsWith("'''");
	const raw = isTriple ? literal.slice(3, -3) : literal.slice(1, -1);
	return prefix.includes("r") ? raw : unescapePythonString(raw);
}

function extractPathVars(code) {
	const vars = new Map();
	const pattern = /(?:^|\n)[ \t]*([A-Za-z_]\w*)\s*=\s*Path\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of code.matchAll(pattern)) vars.set(match[1], match[2]);
	return vars;
}

// A cell can write several files in one go (loop, or just several calls back to back), so
// this collects every recoverable write, not just the first — last write to a given path
// wins, since that's the file's actual end state.
function extractCreateDiffs(code) {
	const results = new Map();
	const record = (path, contentVar) => {
		const content = extractStringVarLiteral(code, contentVar);
		if (content !== undefined) results.set(path, { path, oldStr: "", newStr: content, startLine: 1, kind: "create" });
	};
	for (const match of code.matchAll(/Path\(\s*["']([^"']+)["']\s*\)\.(?:write_text|write_bytes)\(\s*([A-Za-z_]\w*)/g)) {
		record(match[1], match[2]);
	}
	const pathVars = extractPathVars(code);
	for (const match of code.matchAll(/\b([A-Za-z_]\w*)\.(?:write_text|write_bytes)\(\s*([A-Za-z_]\w*)/g)) {
		const path = pathVars.get(match[1]);
		if (path && !results.has(path)) record(path, match[2]);
	}
	return [...results.values()];
}

function resolveToolDiffs(tool) {
	const commandDiffs = Array.isArray(tool.details?.workspaceDiffs) ? tool.details.workspaceDiffs : tool.details?.diffs;
	const reportedDiffs = Array.isArray(commandDiffs)
		? commandDiffs.map((diff) => ({ ...diff, kind: "edit" }))
		: [];
	const code = typeof tool.args?.code === "string" ? tool.args.code : "";
	const kernelDiffs = window.PrometheusToolSummary.composeIpythonDiffs(
		{ code, details: tool.details, workspace: state.workspace },
		reportedDiffs,
	);
	// Extracting content from source is only meaningful once the cell (and its `code` arg)
	// has fully streamed in; a partial code string mid-stream would parse as garbage.
	let created = [];
	if (tool.done && !tool.isError) {
		if (code) created = extractCreateDiffs(code);
	}
	const editedPaths = new Set(kernelDiffs.map((diff) => diff.path));
	const merged = [...kernelDiffs, ...created.filter((diff) => !editedPaths.has(diff.path))];
	return merged.length ? merged : undefined;
}

function renderDiffLine(row) {
	const line = document.createElement("div");
	if (row.type === "skip") {
		line.className = "diff-line diff-line--skip";
		line.textContent = "···";
		return line;
	}
	line.className = `diff-line diff-line--${row.type}`;
	const gutter = document.createElement("span");
	gutter.className = "diff-gutter";
	gutter.textContent = row.type === "add" ? "+" : row.type === "del" ? "-" : "";
	const oldNo = document.createElement("span");
	oldNo.className = "diff-lineno diff-lineno-old";
	oldNo.textContent = row.type === "add" ? "" : String(row.oldNo);
	const newNo = document.createElement("span");
	newNo.className = "diff-lineno diff-lineno-new";
	newNo.textContent = row.type === "del" ? "" : String(row.newNo);
	const code = document.createElement("span");
	code.className = "diff-code";
	code.textContent = row.text;
	line.append(gutter, oldNo, newNo, code);
	return line;
}

// Renders one diff block per edited file into `container`; returns total added/removed lines.
// With more than one file, each block is its own <details> starting collapsed so a big
// multi-file change doesn't dump every diff open at once — a single file just shows directly.
function renderDiffFiles(container, diffs) {
	container.replaceChildren();
	let added = 0;
	let removed = 0;
	const collapsible = diffs.length > 1;
	for (const display of diffs) {
		const { rows, added: fileAdded, removed: fileRemoved } = buildDiffRows(
			display.oldStr,
			display.newStr,
			display.startLine ?? 1,
		);
		added += fileAdded;
		removed += fileRemoved;
		const file = document.createElement(collapsible ? "details" : "div");
		file.className = "diff-file";
		const path = document.createElement(collapsible ? "summary" : "div");
		path.className = "diff-file-path";
		const name = document.createElement("span");
		name.className = "diff-file-name";
		name.textContent = display.path;
		const fileStat = document.createElement("span");
		fileStat.className = "diff-stat";
		const fileStatAdd = document.createElement("span");
		fileStatAdd.className = "diff-stat-add";
		fileStatAdd.textContent = `+${fileAdded}`;
		const fileStatDel = document.createElement("span");
		fileStatDel.className = "diff-stat-del";
		fileStatDel.textContent = `-${fileRemoved}`;
		fileStat.append(fileStatAdd, fileStatDel);
		path.append(name, fileStat);
		const lines = document.createElement("div");
		lines.className = "diff-lines";
		for (const row of rows) lines.appendChild(renderDiffLine(row));
		file.append(path, lines);
		container.appendChild(file);
	}
	return { added, removed };
}

function renderDiffToolCard(row, tool, diffs) {
	const status = tool.isError ? "failed" : tool.done ? "done" : "running";
	const code = typeof tool.args?.code === "string" ? tool.args.code : "";
	const signature = `${status} ${code} ${JSON.stringify(diffs)}`;
	if (row._signature === signature) return;
	row._signature = signature;

	row.className = "message-row tool-row";
	const body = ensureChild(row, "message-body");
	const card = ensureChild(body, "tool-card", "details");
	card.classList.add("diff-card");
	if (tool.isError && !card.dataset.opened) {
		card.open = true;
		card.dataset.opened = "1";
	}

	// <summary> must land in the DOM before the body content: `details` only ever treats its
	// first <summary> child as the label, and non-open state hides everything after it in
	// document order.
	const summary = ensureChild(card, "tool-summary", "summary");
	// The diff view below shows what changed, not what was run — the raw command is otherwise
	// lost. Nested <details> so it stays out of the way collapsed, styled apart from the diff
	// (amber accent) so it doesn't read as just another file block.
	if (code) {
		const commandBlock = ensureChild(card, "tool-command", "details");
		const commandSummary = ensureChild(commandBlock, "tool-command-summary", "summary");
		setText(commandSummary, "Command");
		setText(ensureChild(commandBlock, "tool-command-code", "pre"), code);
	} else {
		card.querySelector(":scope > .tool-command")?.remove();
	}
	const output = ensureChild(card, "diff-card-body");
	const { added, removed } = renderDiffFiles(output, diffs);

	summary.replaceChildren();
	// A single cell can both create and edit files, so the title is one chip per kind
	// present ("Created a.js · Edited b.js, c.js"), not one blanket verb.
	const activityGroups = ipythonActivities(tool).groups.map((group) => ({
		verb: group.verb,
		files: [...new Set(group.files.map(fileBaseName))],
	}));
	const groups = activityGroups.length
		? activityGroups
		: [
				{
					verb: "Created",
					files: [...new Set(diffs.filter((d) => ["create", "create-edit"].includes(d.kind)).map((d) => fileBaseName(d.path)))],
				},
				{
					verb: "Edited",
					files: [...new Set(diffs.filter((d) => d.kind !== "create").map((d) => fileBaseName(d.path)))],
				},
			].filter((group) => group.files.length > 0);
	groups.forEach((group, index) => {
		if (index > 0) {
			const sep = document.createElement("span");
			sep.className = "diff-summary-sep";
			sep.textContent = "·";
			summary.appendChild(sep);
		}
		const label = document.createElement("span");
		label.className = "diff-summary-label";
		label.textContent = group.verb;
		const fileLabel = document.createElement("span");
		fileLabel.className = "diff-summary-file";
		fileLabel.textContent = group.files.length === 1 ? group.files[0] : `${group.files.length} files`;
		summary.append(label, fileLabel);
	});
	const stat = document.createElement("span");
	stat.className = "diff-stat";
	const statAdd = document.createElement("span");
	statAdd.className = "diff-stat-add";
	statAdd.textContent = `+${added}`;
	const statDel = document.createElement("span");
	statDel.className = "diff-stat-del";
	statDel.textContent = `-${removed}`;
	stat.append(statAdd, statDel);
	summary.appendChild(stat);
}

function renderToolCard(row, tool) {
	const diffs = tool.toolName === "ipython" ? resolveToolDiffs(tool) : undefined;
	if (Array.isArray(diffs) && diffs.length) {
		renderDiffToolCard(row, tool, diffs);
		return;
	}
	const status = tool.isError ? "failed" : tool.done ? "done" : "running";
	const summary = `${toolSummary(tool)} · ${status}`;
	const details = toolDetails(tool);
	const signature = `${summary} ${details}`;
	if (row._signature === signature) return;
	row._signature = signature;

	row.className = "message-row tool-row";
	const body = ensureChild(row, "message-body");
	const card = ensureChild(body, "tool-card", "details");
	if (tool.isError && !card.dataset.opened) {
		card.open = true;
		card.dataset.opened = "1";
	}
	setText(ensureChild(card, "tool-summary", "summary"), summary);
	setText(ensureChild(card, "tool-output", "pre"), details);
}

// Coalesce the render burst from token-rate streaming events into one frame.
let renderQueued = false;
function renderMessages() {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		renderMessagesNow();
	});
}

// True while the agent owes a reply that has produced nothing renderable yet:
// between send and the first token, and between a tool call and what follows it.
function isTurnPending() {
	if (!state.busy && !state.queuedPrompt) return false;
	if (state.approval) return false;
	for (let index = state.messages.length - 1; index >= 0; index--) {
		const message = state.messages[index];
		if (!message || !["user", "assistant"].includes(message.role)) continue;
		if (message.role === "user") return true;
		// A streaming assistant row with a body speaks for itself; one carrying only
		// tool calls does not, and the work continues under its cards.
		return !(contentText(message) || contentThinking(message) || contentImages(message).length);
	}
	return false;
}

function renderPendingRow(row) {
	const caption = state.queuedPrompt ? "Connecting…" : "Working…";
	if (row._signature === `pending ${caption}`) return;
	row._signature = `pending ${caption}`;
	row.className = "message-row assistant pending-row";
	row.replaceChildren();
	const label = document.createElement("div");
	label.className = "pending-label";
	label.append(createWorkingIndicator());
	const text = document.createElement("span");
	text.textContent = caption;
	label.append(text);
	row.append(label);
}

function reconcileGroupedRows(container, rows) {
	let cursor = container.firstElementChild;
	for (const descriptor of rows) {
		if (cursor?.dataset.key === descriptor.key) {
			descriptor.render(cursor);
			cursor = cursor.nextElementSibling;
			continue;
		}
		const node = document.createElement("article");
		node.dataset.key = descriptor.key;
		descriptor.render(node);
		container.insertBefore(node, cursor);
	}
	while (cursor) {
		const next = cursor.nextElementSibling;
		cursor.remove();
		cursor = next;
	}
}

function formatWorkDuration(startedAt, finishedAt) {
	if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return "Worked";
	return `Worked for ${formatElapsed(Math.max(0, finishedAt - startedAt))}`;
}

function renderWorkGroup(row, workRows, startedAt, finishedAt) {
	row.className = "message-row work-group-row";
	const group = ensureChild(row, "work-group", "details");
	const summary = ensureChild(group, "work-group-summary", "summary", true);
	const label = ensureChild(summary, "work-group-label", "span");
	setText(label, formatWorkDuration(startedAt, finishedAt));
	let chevron = summary.querySelector(":scope > .work-group-chevron");
	if (!chevron) {
		chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		chevron.classList.add("work-group-chevron");
		chevron.setAttribute("viewBox", "0 0 16 16");
		chevron.setAttribute("aria-hidden", "true");
		chevron.innerHTML = '<path d="m6 3.5 4.5 4.5L6 12.5"/>';
		summary.appendChild(chevron);
	}
	const content = ensureChild(group, "work-group-content");
	reconcileGroupedRows(content, workRows);
}

// One ordered transcript: message rows in message order, and each tool card in the position
// of the toolCall block that produced it. Tool results are never rendered as their own row.
function buildTranscriptRows() {
	const messages = state.subagentView?.messages || state.messages;
	const tools = state.subagentView ? [] : state.tools;
	const resultsByCallId = new Map();
	for (const message of messages) {
		if (message?.role === "toolResult" && message.toolCallId) resultsByCallId.set(message.toolCallId, message);
	}
	const runtimeByCallId = new Map();
	for (const tool of tools) {
		if (tool?.toolCallId) runtimeByCallId.set(tool.toolCallId, tool);
	}

	if (!state.subagentView) resolveRestoredSubagentAnchors();
	// A subagent belongs under the tool call that spawned it, not at the end of
	// the transcript. Anything whose anchor is gone falls to the bottom.
	const subagentsByAnchor = new Map();
	for (const subagent of state.subagentView ? [] : state.subagents.values()) {
		const anchor = subagent.anchorToolCallId || "";
		if (!subagentsByAnchor.has(anchor)) subagentsByAnchor.set(anchor, []);
		subagentsByAnchor.get(anchor).push(subagent);
	}
	const pushSubagentRows = (rows, anchor) => {
		for (const subagent of subagentsByAnchor.get(anchor) || []) {
			rows.push({ key: `s:${subagent.id}`, render: (row) => renderSubagentRow(row, subagent) });
		}
		subagentsByAnchor.delete(anchor);
	};

	const rows = [];
	let turnStartedAt;
	let turnStartIndex = -1;
	let turnWorkRows = [];
	const flushVisibleWork = () => {
		rows.push(...turnWorkRows);
		turnWorkRows = [];
	};
	const pushWorkRow = (row) => {
		if (turnStartIndex >= 0) turnWorkRows.push(row);
		else rows.push(row);
	};
	const collapseWork = (finalIndex, finalMessage) => {
		if (!turnWorkRows.length) return;
		const workRows = turnWorkRows;
		turnWorkRows = [];
		const startedAt = turnStartedAt;
		const finishedAt = finalMessage._finalStartedAt ?? finalMessage.timestamp ?? finalMessage._finishedAt;
		rows.push({
			key: `w:${turnStartIndex}:${finalIndex}`,
			render: (row) => renderWorkGroup(row, workRows, startedAt, finishedAt),
		});
	};
	const renderedCalls = new Set();
	for (const [index, message] of messages.entries()) {
		if (!message || !["user", "assistant", "custom", "notification"].includes(message.role)) continue;
		if (message.role === "user") {
			flushVisibleWork();
			rows.push({ key: `m:${index}`, render: (row) => renderMessageRow(row, message) });
			turnStartedAt = message.timestamp;
			turnStartIndex = index;
			continue;
		}
		// An agent message carries a routing envelope the model needs and the reader
		// does not; it gets its own row showing just what was said.
		const agentMessage = agentMessageDetails(message);
		if (agentMessage) {
			pushWorkRow({ key: `a:${index}`, render: (row) => renderAgentMessageRow(row, agentMessage) });
			continue;
		}
		// A background-job-finished message carries a raw envelope for the model; the
		// reader gets the sub-agent-style summary pill instead.
		const jobFinished = backgroundJobFinishedDetails(message);
		if (jobFinished) {
			pushWorkRow({ key: `bg:${index}`, render: (row) => renderBackgroundJobFinishedRow(row, jobFinished, message) });
			continue;
		}
		const calls = Array.isArray(message.content) ? message.content.filter((block) => block?.type === "toolCall") : [];
		const finalAnswer = assistantHasFinalAnswer(message);
		const messageWorkText = finalAnswer ? workText(message) : contentText(message);
		const messageThinking = contentThinking(message);
		const images = contentImages(message);
		const hasWorkBody = Boolean(messageWorkText || messageThinking || (!finalAnswer && images.length));
		// Position, not messageKey(): a streamed message's timestamp/id can arrive late, and a
		// changing key would swap the node out mid-stream and re-run its entry animation.
		if (hasWorkBody) {
			pushWorkRow({
				key: finalAnswer ? `mw:${index}` : `m:${index}`,
				render: (row) =>
					renderMessageRow(row, message, {
						text: messageWorkText,
						thinking: messageThinking,
						images: finalAnswer ? [] : images,
						streaming: finalAnswer ? false : message._streaming,
						showActions: false,
					}),
			});
		}
		for (const call of calls) {
			if (!call.id || renderedCalls.has(call.id)) continue;
			renderedCalls.add(call.id);
			const tool = mergeTool(call, resultsByCallId.get(call.id), runtimeByCallId.get(call.id));
			pushWorkRow({ key: `t:${call.id}`, render: (row) => renderToolCard(row, tool) });
			const subagentRows = [];
			pushSubagentRows(subagentRows, call.id);
			for (const subagentRow of subagentRows) pushWorkRow(subagentRow);
		}
		if (finalAnswer) {
			collapseWork(index, message);
			const text = finalAnswerText(message);
			if (text || images.length) {
				rows.push({
					key: `m:${index}`,
					render: (row) => renderMessageRow(row, message, { text, thinking: "", images }),
				});
			}
			turnStartedAt = undefined;
			turnStartIndex = -1;
		}
	}
	for (const anchor of [...subagentsByAnchor.keys()]) {
		const subagentRows = [];
		pushSubagentRows(subagentRows, anchor);
		for (const subagentRow of subagentRows) pushWorkRow(subagentRow);
	}
	// The turn is accepted in ~200ms but the first token is the provider's to give,
	// and until then nothing above has a body to render. Without a row for the turn
	// in flight the transcript sits dead for seconds after the user hits send.
	if (!state.subagentView && isTurnPending()) {
		pushWorkRow({ key: "pending", render: (row) => renderPendingRow(row) });
	}
	flushVisibleWork();
	if (state.subagentView && messages.length === 0) {
		rows.push({ key: "subagent-empty", render: (row) => renderSubagentEmptyRow(row) });
	}
	// An approval belongs under the output that provoked it, not in a modal on top of it.
	if (!state.subagentView && state.approval) {
		rows.push({ key: `approval:${state.approval.id}`, render: (row) => renderApprovalCard(row, state.approval) });
	}
	return rows;
}

// An agent-to-agent message is a custom message whose content is a routing
// envelope (source, sender, target, message id) wrapped around the actual text.
// The envelope exists so the model knows who is talking to it; details.message
// is the only part worth showing.
const AGENT_MESSAGE_CUSTOM_TYPE = "agent_message";

function agentMessageDetails(message) {
	if (message?.role !== "custom" || message.customType !== AGENT_MESSAGE_CUSTOM_TYPE) return undefined;
	const details = message.details;
	return details && typeof details.message === "string" ? details : undefined;
}

function agentMessageSender(details) {
	const from = details.from || {};
	const name = (from.sessionName || from.activeSessionId || from.clientId || from.sessionId || "unknown").trim();
	// Match the wording of the subagent rows these messages come from.
	if (details.fromRelationship === "child") return `Sub-agent: ${name}`;
	if (details.fromRelationship === "parent") return "Parent agent";
	return `Agent: ${name}`;
}

function renderAgentMessageRow(row, details) {
	const signature = `agent ${details.id} ${details.message}`;
	if (row._signature === signature) return;
	row._signature = signature;
	row.className = "message-row agent-message-row";
	row.replaceChildren();
	const card = document.createElement("div");
	card.className = "agent-message-card";
	const sender = document.createElement("div");
	sender.className = "agent-message-sender";
	sender.textContent = agentMessageSender(details);
	const body = document.createElement("div");
	body.className = "agent-message-body message-content";
	renderMarkdown(body, details.message);
	card.append(sender, body);
	row.append(card);
}

// A background job's finish notice wraps its output in a tag pair for the model;
// the reader only wants the trimmed text inside, and only when it says something.
const BACKGROUND_JOB_FINISHED_CUSTOM_TYPE = "background_job_finished";

function backgroundJobFinishedDetails(message) {
	if (message?.role !== "custom" || message.customType !== BACKGROUND_JOB_FINISHED_CUSTOM_TYPE) return undefined;
	const details = message.details;
	return details && typeof details.command === "string" ? details : undefined;
}

function extractBackgroundJobOutput(content) {
	const text = typeof content === "string" ? content : "";
	const match = /<background_job_output>\n?([\s\S]*?)\n?<\/background_job_output>/.exec(text);
	const output = match ? match[1].trim() : "";
	return output === "(no output)" ? "" : output;
}

function backgroundJobStatusLabel(details) {
	if (details.status === "cancelled") return "cancelled";
	if (details.status === "completed") return "completed";
	if (details.exitCode !== undefined) return `failed (exit ${details.exitCode})`;
	if (details.signal) return `failed (${details.signal})`;
	return "failed";
}

function renderBackgroundJobFinishedRow(row, details, message) {
	const signature = `bgjob ${details.jobId} ${details.status} ${details.exitCode ?? ""} ${details.signal ?? ""}`;
	if (row._signature === signature) return;
	row._signature = signature;
	row.className = "message-row subagent-row";
	row.replaceChildren();
	const card = document.createElement("div");
	card.className = `subagent-card${details.status === "completed" ? "" : " failed"}`;
	const label = document.createElement("span");
	label.className = "subagent-label";
	const prefix = document.createElement("span");
	prefix.className = "subagent-prefix";
	prefix.textContent = "Background job:";
	label.append(prefix, ` ${details.command}`);
	label.title = details.command;
	const status = document.createElement("span");
	status.className = "subagent-status";
	status.textContent = backgroundJobStatusLabel(details);
	card.append(label, status);
	row.append(card);
	const output = extractBackgroundJobOutput(message.content);
	if (output) {
		const outputBlock = document.createElement("details");
		outputBlock.className = "job-output-details";
		const summary = document.createElement("summary");
		summary.textContent = "Output";
		const pre = document.createElement("pre");
		pre.className = "runtime-output";
		pre.textContent = output;
		outputBlock.append(summary, pre);
		row.append(outputBlock);
	}
}

// The spawn prompt is the only record of what a subagent was asked to do, and it
// can be paragraphs long; the row shows its first line, trimmed to fit.
function subagentSummary(subagent) {
	const prompt = (subagent.label || subagent.sessionName || "").replace(/\s+/g, " ").trim();
	if (!prompt) return "working";
	return prompt.length > 96 ? `${prompt.slice(0, 95).trimEnd()}…` : prompt;
}

function isSubagentWorking(subagent) {
	// A row restored from the registry carries no live status. Its agent runs in
	// its own session, so the busy-session poll is what knows if it is still going.
	if (!subagent.status) return state.busySessions.has(sessionPathKey(subagent.sessionFile));
	return subagent.status === "queued" || subagent.status === "running";
}

// A restored subagent knows when it was spawned but not by which cell. The last
// tool call that started before it is the one that made it, which puts the row
// back where it was instead of at the end of the transcript.
function resolveRestoredSubagentAnchors() {
	const restored = [...state.subagents.values()].filter(
		(subagent) => !subagent.anchorToolCallId && Number.isFinite(subagent.createdAt),
	);
	if (!restored.length) return;
	const calls = [];
	for (const message of state.messages) {
		if (!Array.isArray(message?.content)) continue;
		for (const block of message.content) {
			if (block?.type === "toolCall" && block.id) calls.push({ id: block.id, timestamp: message.timestamp ?? 0 });
		}
	}
	if (!calls.length) return;
	for (const subagent of restored) {
		for (let index = calls.length - 1; index >= 0; index--) {
			if (calls[index].timestamp <= subagent.createdAt) {
				subagent.anchorToolCallId = calls[index].id;
				break;
			}
		}
	}
}

function subagentDisplayName(subagent) {
	return (subagent.sessionName || subagent.id || "Sub-agent").trim() || "Sub-agent";
}

function syncSubagentView() {
	const view = state.subagentView;
	mainPanel.classList.toggle("subagent-view", Boolean(view));
	headerSubagent.hidden = !view;
	subagentSeparator.hidden = !view;
	if (view) headerSubagent.textContent = view.name;
	subagentBackButton.hidden = !view;
	syncComposer();
}

async function resolveSubagentSessionFile(view) {
	if (view.sessionFile) return view.sessionFile;
	try {
		const { subagents } = await window.desktopAgent.listSessionSubagents({ sessionPath: state.activeSessionPath });
		if (state.subagentView !== view) return undefined;
		const restored = (subagents || []).find((subagent) => subagent.id === view.id);
		if (!restored) return undefined;
		const current = state.subagents.get(view.id);
		state.subagents.set(view.id, { ...restored, ...current, sessionFile: restored.sessionFile || current?.sessionFile });
		view.sessionFile = restored.sessionFile;
		return view.sessionFile;
	} catch {
		return undefined;
	}
}

async function refreshViewedSubagent() {
	const view = state.subagentView;
	if (!view || view.reading) return;
	view.reading = true;
	try {
		const sessionFile = await resolveSubagentSessionFile(view);
		if (state.subagentView !== view) return;
		if (!sessionFile) {
			view.unavailable = !isSubagentWorking(state.subagents.get(view.id) || view);
			view.loading = !view.unavailable;
			renderMessages();
			return;
		}
		const { messages } = await window.desktopAgent.readSessionMessages({ sessionPath: sessionFile });
		if (state.subagentView !== view) return;
		view.messages = (messages || []).map(normalizeMessage);
		view.loading = false;
		view.unavailable = false;
		renderMessages();
	} catch {
		if (state.subagentView !== view) return;
		view.loading = false;
		view.unavailable = true;
		renderMessages();
	} finally {
		view.reading = false;
	}
}

function openSubagentConversation(subagent) {
	if (!subagent?.id) return;
	state.subagentView = {
		id: subagent.id,
		name: subagentDisplayName(subagent),
		sessionFile: subagent.sessionFile,
		messages: [],
		loading: true,
	};
	syncSubagentView();
	conversation.scrollTop = 0;
	renderMessages();
	void refreshViewedSubagent();
}

function closeSubagentConversation() {
	if (!state.subagentView) return;
	state.subagentView = undefined;
	syncSubagentView();
	conversation.scrollTop = conversation.scrollHeight;
	renderMessages();
	void refreshWorkspaceChanges();
}

function renderSubagentEmptyRow(row) {
	const view = state.subagentView;
	row.className = "message-row subagent-empty-row";
	row.replaceChildren();
	const status = document.createElement("div");
	status.className = "subagent-empty";
	if (view?.loading) {
		status.append(createWorkingIndicator());
		const text = document.createElement("span");
		text.textContent = "Loading sub-agent conversation…";
		status.append(text);
	} else {
		status.textContent = view?.unavailable
			? "This sub-agent conversation is not available yet."
			: "This sub-agent has not written any messages yet.";
	}
	row.append(status);
}

function renderSubagentRow(row, subagent) {
	row.className = "message-row subagent-row";
	row.replaceChildren();
	const card = document.createElement("button");
	const working = isSubagentWorking(subagent);
	card.type = "button";
	card.className = `subagent-card subagent-card-button${working ? " working" : ""}${subagent.status === "error" ? " failed" : ""}`;
	card.setAttribute("aria-label", `Open sub-agent conversation: ${subagentDisplayName(subagent)}`);
	card.addEventListener("click", () => openSubagentConversation(subagent));
	if (working) card.append(createWorkingIndicator());
	const label = document.createElement("span");
	label.className = "subagent-label";
	const prefix = document.createElement("span");
	prefix.className = "subagent-prefix";
	prefix.textContent = "Sub-agent:";
	label.append(prefix, ` ${subagentSummary(subagent)}`);
	// The full prompt is what got truncated, so keep it reachable on hover.
	label.title = subagent.error || subagent.label || "";
	card.append(label);
	if (subagent.status === "error") {
		const status = document.createElement("span");
		status.className = "subagent-status";
		status.textContent = "failed";
		card.append(status);
	}
	const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	arrow.classList.add("subagent-open-icon");
	arrow.setAttribute("viewBox", "0 0 16 16");
	arrow.setAttribute("aria-hidden", "true");
	arrow.innerHTML = '<path d="m6 3.5 4.5 4.5L6 12.5"/>';
	card.append(arrow);
	row.append(card);
}

function renderApprovalCard(row, approval) {
	row.className = "message-row approval-row";
	row.replaceChildren();
	const card = document.createElement("div");
	card.className = "approval-card";
	const title = document.createElement("strong");
	title.textContent = approval.title;
	const message = document.createElement("p");
	message.textContent = approval.message;
	const actions = document.createElement("div");
	actions.className = "approval-actions";
	for (const [label, confirmed] of [
		["Accept", true],
		["Deny", false],
	]) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = confirmed ? "approval-accept" : "approval-deny";
		button.textContent = label;
		button.addEventListener("click", () => {
			state.approval = undefined;
			renderMessages();
			void window.desktopAgent.send({ type: "extension_ui_response", id: approval.id, confirmed });
		});
		actions.appendChild(button);
	}
	card.append(title, message, actions);
	row.appendChild(card);
}

function renderMessagesNow() {
	const distanceFromBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
	const followLatest = distanceFromBottom < 120;
	const displayedMessages = state.subagentView?.messages || state.messages;
	const displayedTools = state.subagentView ? [] : state.tools;
	$("welcome-card").style.display = state.subagentView || displayedMessages.length || displayedTools.length ? "none" : "block";

	const rows = buildTranscriptRows();

	let cursor = conversation.querySelector(".message-row");
	for (const row of rows) {
		if (cursor?.dataset.key === row.key) {
			row.render(cursor);
			cursor = cursor.nextElementSibling;
			continue;
		}
		const node = document.createElement("article");
		node.dataset.key = row.key;
		row.render(node);
		conversation.insertBefore(node, cursor);
	}
	while (cursor) {
		const next = cursor.nextElementSibling;
		cursor.remove();
		cursor = next;
	}

	if (followLatest) conversation.scrollTop = conversation.scrollHeight;
	else conversation.scrollTop = Math.max(0, conversation.scrollHeight - conversation.clientHeight - distanceFromBottom);
}

function formatToolDetails(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function updateModelOptions() {
	modelSelect.replaceChildren();
	if (!state.models.length) {
		modelSelect.add(new Option("No models available", ""));
		syncComposer();
		return;
	}
	const modelsByProvider = new Map();
	for (const model of state.models) {
		const provider = model.provider || "Other";
		if (!modelsByProvider.has(provider)) modelsByProvider.set(provider, []);
		modelsByProvider.get(provider).push(model);
	}
	const modelCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
	const manualModelOrder = ["fable", "opus", "sonnet", "sol", "terra", "luna"];
	const manualModelPriority = (modelId) => {
		const modelNameParts = modelId.toLowerCase().split(/[^a-z0-9]+/);
		return manualModelOrder.findIndex((name) => modelNameParts.includes(name));
	};
	for (const [provider, models] of modelsByProvider) {
		models.sort((a, b) => {
			const priorityDifference = manualModelPriority(a.id) - manualModelPriority(b.id);
			if (priorityDifference !== 0) {
				if (manualModelPriority(a.id) === -1) return 1;
				if (manualModelPriority(b.id) === -1) return -1;
				return priorityDifference;
			}
			return modelCollator.compare(b.id, a.id);
		});
		const group = document.createElement("optgroup");
		group.label = provider;
		modelSelect.appendChild(group);
		for (const model of models) {
			const option = new Option(formatModel(model), `${model.provider}:${model.id}`);
			option.title = `${model.contextWindow ? `${model.contextWindow.toLocaleString()} context` : ""}${model.reasoning ? " · reasoning" : ""}`;
			group.appendChild(option);
		}
	}
	if (state.model) modelSelect.value = `${state.model.provider}:${state.model.id}`;
	syncComposer();
}

function formatElapsed(milliseconds) {
	const seconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function renderRuntimeFeatures() {
	const features = state.runtimeFeatures;
	const mode = features?.executionMode;
	$("job-command").disabled = !state.runtimeAvailable || !features;
	$("job-form").querySelector("button").disabled = !state.runtimeAvailable || !features;
	for (const button of document.querySelectorAll("[data-execution-mode]")) {
		button.setAttribute("aria-checked", String(button.dataset.executionMode === mode));
		button.disabled = !state.runtimeAvailable || !features;
	}
	$("execution-status").textContent = state.runtimeAvailable ? mode || "Loading" : "Unavailable";
	const composerMode = $("composer-mode");
	composerMode.disabled = !state.runtimeAvailable || !features;
	if (mode) {
		$("composer-mode-label").textContent = mode[0].toUpperCase() + mode.slice(1);
		for (const option of document.querySelectorAll("[data-composer-execution-mode]")) {
			option.setAttribute("aria-selected", String(option.dataset.composerExecutionMode === mode));
		}
	}
	const executionNote = $("execution-note");
	executionNote.classList.toggle("warning", mode === "unrestricted" || !state.runtimeAvailable);
	executionNote.textContent = !state.runtimeAvailable
		? "Restart Prometheus to use runtime controls with this session."
		: mode === "unrestricted"
			? "Processes can access files and the network without OS sandboxing."
			: mode === "plan"
				? "Read-only exploration and web search are enabled. Writes, subprocesses, general network access, and background commands are blocked."
				: mode === "workspace"
					? navigator.userAgent.includes("Windows")
						? "Project work is enabled. Kernel writes stay inside the workspace; processes it starts are not OS-contained on Windows."
						: "Writes stay inside the workspace and configured roots."
					: "";

	const jobs = features?.jobs || [];
	renderJobBanner(jobs);
	$("job-count").textContent = String(jobs.length);
	jobList.replaceChildren();
	if (!jobs.length) {
		const empty = document.createElement("p");
		empty.className = "runtime-empty";
		empty.textContent = "No background jobs in this session.";
		jobList.appendChild(empty);
	}
	for (const job of jobs) {
		const row = document.createElement("article");
		row.className = "runtime-row";
		const head = document.createElement("div");
		head.className = "runtime-row-head";
		const title = document.createElement("span");
		title.className = "runtime-row-title";
		title.title = job.command;
		title.textContent = job.command;
		const status = document.createElement("span");
		status.className = `runtime-row-state ${job.status}`;
		status.textContent = job.status;
		head.append(title, status);
		const meta = document.createElement("div");
		meta.className = "runtime-row-meta";
		const detail = document.createElement("span");
		detail.textContent = job.progress?.message || (job.exitCode !== undefined ? `Exit ${job.exitCode}` : job.id);
		const elapsed = document.createElement("span");
		elapsed.textContent = formatElapsed(job.elapsedMs);
		meta.append(detail, elapsed);
		row.append(head, meta);
		if (job.progress?.percent !== undefined) {
			const progress = document.createElement("div");
			progress.className = "runtime-progress";
			const fill = document.createElement("span");
			fill.style.width = `${Math.max(0, Math.min(100, job.progress.percent))}%`;
			progress.appendChild(fill);
			row.appendChild(progress);
		}
		const actions = document.createElement("div");
		actions.className = "runtime-row-actions";
		const tail = document.createElement("button");
		tail.type = "button";
		tail.dataset.runtimeAction = "tail-job";
		tail.dataset.jobId = job.id;
		tail.textContent = state.jobOutputs.has(job.id) ? "Hide output" : "Output";
		actions.appendChild(tail);
		if (job.status === "running" || job.status === "orphaned") {
			const write = document.createElement("button");
			write.type = "button";
			write.dataset.runtimeAction = "write-job";
			write.dataset.jobId = job.id;
			write.textContent = "Send input";
			actions.appendChild(write);
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.dataset.runtimeAction = "cancel-job";
			cancel.dataset.jobId = job.id;
			cancel.textContent = "Cancel";
			actions.appendChild(cancel);
		}
		row.appendChild(actions);
		if (state.jobOutputs.has(job.id)) {
			const output = document.createElement("pre");
			output.className = "runtime-output";
			output.textContent = state.jobOutputs.get(job.id) || "No output yet.";
			row.appendChild(output);
		}
		jobList.appendChild(row);
	}
	watchRunningJobs(jobs);

	const worktrees = (features?.worktrees || []).filter((worktree) => worktree.state !== "clean");
	$("worktree-count").textContent = String(worktrees.length);
	worktreeList.replaceChildren();
	if (!worktrees.length) {
		const empty = document.createElement("p");
		empty.className = "runtime-empty";
		empty.textContent = "No isolated changes waiting for review.";
		worktreeList.appendChild(empty);
	}
	for (const worktree of worktrees) {
		const row = document.createElement("article");
		row.className = "runtime-row";
		const head = document.createElement("div");
		head.className = "runtime-row-head";
		const title = document.createElement("span");
		title.className = "runtime-row-title";
		title.textContent = worktree.id;
		const status = document.createElement("span");
		status.className = `runtime-row-state ${worktree.state}`;
		status.textContent = worktree.state;
		head.append(title, status);
		row.appendChild(head);
		if (worktree.state === "changed") {
			const actions = document.createElement("div");
			actions.className = "runtime-row-actions";
			for (const [action, label, primary] of [["discard-worktree", "Discard", false], ["apply-worktree", "Apply patch", true]]) {
				const button = document.createElement("button");
				button.type = "button";
				button.dataset.runtimeAction = action;
				button.dataset.worktreeId = worktree.id;
				button.classList.toggle("primary", primary);
				button.textContent = label;
				actions.appendChild(button);
			}
			row.appendChild(actions);
		}
		worktreeList.appendChild(row);
	}
}

function renderJobBanner(jobs) {
	const active = jobs.filter((job) => job.status === "running" || job.status === "orphaned");
	jobBanner.hidden = active.length === 0;
	if (!active.length) state.jobBannerExpanded = false;
	jobBanner.dataset.expanded = String(state.jobBannerExpanded);
	jobBannerToggle.setAttribute("aria-expanded", String(state.jobBannerExpanded));
	jobBannerLabel.textContent = `${active.length} Background`;
	jobBannerList.hidden = !state.jobBannerExpanded;
	jobBannerList.replaceChildren();
	for (const job of active) {
		const row = document.createElement("div");
		row.className = "job-banner-row";
		row.dataset.status = job.status;
		const dot = document.createElement("span");
		dot.className = "job-banner-dot";
		const text = document.createElement("span");
		text.title = job.command;
		text.textContent = job.command;
		row.append(dot, text);
		jobBannerList.appendChild(row);
	}
}

function workspaceChangeName(filePath) {
	return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function workspaceChangeParent(filePath) {
	const parts = filePath.split(/[\\/]/).filter(Boolean);
	return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function renderWorkspaceChanges() {
	const changes = state.workspaceChanges;
	changeReview.hidden = changes.length === 0;
	changeReview.dataset.expanded = String(state.changeReviewExpanded);
	changeReviewToggle.setAttribute("aria-expanded", String(state.changeReviewExpanded));
	changeReviewFiles.hidden = !state.changeReviewExpanded;
	$("change-review-label").textContent = `${changes.length} ${changes.length === 1 ? "File" : "Files"} With Changes`;
	changeReviewFiles.replaceChildren();
	for (const change of changes) {
		const row = document.createElement("div");
		row.className = "change-review-file";
		row.dataset.status = change.status;
		row.title = change.previousPath ? `${change.path} (from ${change.previousPath})` : change.path;

		const icon = document.createElement("span");
		icon.className = "change-review-file-icon";
		icon.setAttribute("aria-hidden", "true");
		icon.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="8" cy="8" r="1.25"/></svg>';
		const name = document.createElement("span");
		name.className = "change-review-file-name";
		name.textContent = workspaceChangeName(change.path);
		const parent = document.createElement("span");
		parent.className = "change-review-file-path";
		parent.textContent = workspaceChangeParent(change.path);
		const status = document.createElement("span");
		status.className = "change-review-file-status";
		status.textContent = change.status.replace("-", " ");
		row.append(icon, name, parent);

		if (Number.isFinite(change.added) && Number.isFinite(change.removed)) {
			const stats = document.createElement("span");
			stats.className = "change-review-file-stats";
			stats.innerHTML = `<span class="change-review-add">+${change.added}</span><span class="change-review-remove">-${change.removed}</span>`;
			row.appendChild(stats);
		} else row.appendChild(status);
		changeReviewFiles.appendChild(row);
	}
	acceptAllChanges.textContent = state.changeReviewPending ? "Applying…" : "Accept all";
	syncComposer();
}

async function refreshWorkspaceChanges() {
	const sessionPath = state.activeSessionPath;
	const request = ++state.changeReviewRequest;
	if (!sessionPath || state.subagentView) {
		state.workspaceChanges = [];
		renderWorkspaceChanges();
		return;
	}
	try {
		const result = await window.desktopAgent.listWorkspaceChanges({ sessionPath });
		if (request !== state.changeReviewRequest || sessionPath !== state.activeSessionPath) return;
		state.workspaceChanges = Array.isArray(result?.changes) ? result.changes : [];
	} catch {
		if (request !== state.changeReviewRequest) return;
		state.workspaceChanges = [];
	}
	renderWorkspaceChanges();
}

async function applyWorkspaceChangeReview(operation) {
	if (state.busy || state.changeReviewPending || !state.workspaceChanges.length) return;
	const sessionPath = state.activeSessionPath;
	if (!sessionPath) return;
	state.changeReviewPending = true;
	renderWorkspaceChanges();
	try {
		const result = await window.desktopAgent.applyWorkspaceChanges({ sessionPath, operation });
		if (sessionPath === state.activeSessionPath) {
			state.workspaceChanges = Array.isArray(result?.changes) ? result.changes : [];
		}
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error));
	} finally {
		state.changeReviewPending = false;
		renderWorkspaceChanges();
	}
}

function watchRunningJobs(jobs) {
	for (const job of jobs) {
		if ((job.status !== "running" && job.status !== "orphaned") || state.waitingJobs.has(job.id)) continue;
		state.waitingJobs.add(job.id);
		sendCommand(
			"wait_background_job",
			{ jobId: job.id, sinceRevision: job.revision, timeoutMs: 30000 },
			{ jobId: job.id },
		);
	}
}

function refreshRuntimeFeatures() {
	// The composer's mode chip needs these even while the runtime drawer is shut.
	if (!state.runtimeAvailable) return;
	sendCommand("get_runtime_features");
}

function startsBackgroundJob(event) {
	return event.toolName === "ipython" && typeof event.args?.code === "string" && /\brlm\.jobs\.start\s*\(/.test(event.args.code);
}

function openRuntimeDrawer() {
	runtimeDrawer.hidden = false;
	$("runtime-button").setAttribute("aria-pressed", "true");
	refreshRuntimeFeatures();
}

function closeRuntimeDrawer() {
	runtimeDrawer.hidden = true;
	$("runtime-button").setAttribute("aria-pressed", "false");
}

function handleResponse(event) {
	const pending = event.id ? state.pending.get(event.id) : undefined;
	if (pending?.resolve) {
		state.pending.delete(event.id);
		if (event.success) pending.resolve(event);
		else pending.reject(new Error(event.error || "The agent rejected that request."));
		return;
	}
	const pendingType = pending?.type;
	if (event.id) state.pending.delete(event.id);
	if (!event.success) {
		if (pending?.optimisticKey) {
			state.messages = state.messages.filter((message) => message._key !== pending.optimisticKey);
			if (!input.value.trim()) {
				input.value = pending.message || "";
				input.dispatchEvent(new Event("input"));
			}
			renderMessages();
		}
		// Autocomplete is optional: an engine without get_commands should not raise an error toast.
		if (event.command === "get_commands" || pendingType === "get_commands") return;
		// A background poll must never toast; the indicators just stay as they were.
		if (event.command === "list_busy_sessions" || pendingType === "list_busy_sessions") return;
		if ((pendingType || event.command) === "get_runtime_features") {
			state.runtimeAvailable = false;
			renderRuntimeFeatures();
		}
		if ((pendingType || event.command) === "wait_background_job" && pending?.jobId) {
			state.waitingJobs.delete(pending.jobId);
			return;
		}
		if (event.command === "get_state") setDisconnected("Agent handshake failed");
		else if (["prompt", "steer", "follow_up"].includes(pendingType || event.command)) sendCommand("get_state");
		if (event.command === "open_session" || pendingType === "open_session") {
			// A stale failure must not unblock a switch that is still running.
			if (pending?.switchToken !== state.switchToken) return;
			state.switchingSession = false;
			// The chat it was meant for never opened; hand the text back.
			returnQueuedPromptToComposer();
			renderWorkspaceList();
			// The engine is still on the previous conversation; these put the UI back on it.
			sendCommand("get_state");
			sendCommand("get_messages");
		}
		showToast(event.error || "The agent rejected that request.");
		return;
	}
	if (event.command === "get_state") {
		clearTimeout(handshakeTimer);
		applyState(event.data);
		setReady(true);
		refreshBusySessions();
		void restoreSubagents(state.activeSessionPath);
		void refreshWorkspaceChats(state.workspace);
		flushQueuedPrompt();
	}
	if (event.command === "get_available_models") {
		state.models = event.data?.models || [];
		updateModelOptions();
		modelSelect.disabled = !state.ready || state.models.length === 0;
		// A prompt typed before the model list landed can go now.
		flushQueuedPrompt();
	}
	if (event.command === "get_commands") {
		state.commands = event.data?.commands || [];
	}
	// /permissions changes the mode inside the engine without notifying the UI.
	if (["prompt", "steer", "follow_up"].includes(pendingType || event.command)) refreshRuntimeFeatures();
	if (["get_runtime_features", "set_execution_mode", "start_background_job", "write_background_job", "cancel_background_job", "apply_subagent_worktree", "discard_subagent_worktree"].includes(event.command)) {
		state.runtimeFeatures = event.data;
		state.runtimeAvailable = true;
		renderRuntimeFeatures();
	}
	if (event.command === "tail_background_job") {
		if (pending?.jobId) state.jobOutputs.set(pending.jobId, event.data?.output || "");
		renderRuntimeFeatures();
	}
	if (event.command === "wait_background_job") {
		if (pending?.jobId) state.waitingJobs.delete(pending.jobId);
		refreshRuntimeFeatures();
	}
	if (event.command === "get_messages") {
		// Mid-switch the engine still answers for the conversation we are leaving.
		// The open_session handshake re-asks once it has attached to the new one.
		if (state.switchingSession) return;
		// A prompt sent but not yet echoed by the engine keeps its optimistic row.
		const optimistic = state.messages.filter((message) => message._optimistic);
		state.messages = [...(event.data?.messages || []).map(normalizeMessage), ...optimistic];
		state.streamIndex = -1;
		renderMessages();
	}
	if (event.command === "list_busy_sessions") {
		const busySessions = new Set((event.data?.sessionFiles || []).map(sessionPathKey));
		// Re-render only on a real change: the sidebar rebuilds every row, which
		// would restart the indicator animation on every poll.
		const changed =
			busySessions.size !== state.busySessions.size || [...busySessions].some((key) => !state.busySessions.has(key));
		state.busySessions = busySessions;
		if (changed) renderWorkspaceList();
	}
	if (event.command === "open_session") {
		// The user clicked past this conversation while it was attaching; the newer
		// switch owns the transcript now.
		if (pending?.switchToken !== state.switchToken) return;
		state.switchingSession = false;
		if (event.data?.cancelled === true) {
			// The engine stayed on the conversation we tried to leave, so put the UI
			// back on it rather than leaving the composer pointed at the wrong chat.
			returnQueuedPromptToComposer();
			showToast("That conversation could not be opened.");
			sendCommand("get_state");
			sendCommand("get_messages");
			return;
		}
		renderWorkspaceList();
		sendCommand("get_state");
		sendCommand("get_messages");
		sendCommand("get_available_models");
		refreshRuntimeFeatures();
		flushQueuedPrompt();
	}
	if (event.command === "set_model") {
		state.model = event.data;
	}
	if (event.command === "set_thinking_level") {
	}
	if (event.command === "export_html") {
		showToast(`Exported session to ${event.data?.path || "HTML"}`);
		if (event.data?.path) window.desktopAgent.openPath(event.data.path);
	}
	if (event.command === "get_session_stats") {
		const stats = event.data || {};
		showToast(`Session: ${stats.userMessages ?? 0} user messages · ${stats.assistantMessages ?? 0} assistant messages`);
	}
}

const TRANSCRIPT_EVENTS = new Set([
	"agent_start",
	"agent_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"session_info_changed",
	"rlm_child_update",
]);

function handleAgentEvent(event) {
	if (!event || typeof event !== "object") return;
	if (event.type === "response") return handleResponse(event);
	// Until open_session lands, streamed turns still belong to the conversation we
	// left. Dropping them keeps another chat's output out of the one just opened;
	// the transcript is re-fetched from the engine as soon as it attaches.
	if (state.switchingSession && TRANSCRIPT_EVENTS.has(event.type)) return;
	if (event.type === "session_info_changed") {
		state.sessionName = event.name || "New conversation";
		$("header-title").textContent = event.name || "Untitled session";
		const chats = state.workspaceChats.get(state.workspace);
		const activeChat = chats?.find((chat) => chat.path === state.activeSessionPath);
		if (activeChat) {
			activeChat.name = state.sessionName;
			renderWorkspaceList();
		} else {
			void refreshWorkspaceChats(state.workspace);
		}
		return;
	}
	if (event.type === "agent_start") {
		// Tool history belongs to the transcript, not to a single turn.
		setBusy(true, "Working · send a message to steer");
		return;
	}
	if (event.type === "agent_end") {
		setBusy(false, "Ready");
		// The streamed transcript is optimistic; the engine's message list is authoritative.
		sendCommand("get_messages");
		sendCommand("get_state");
		sendCommand("get_available_models");
		refreshRuntimeFeatures();
		return;
	}
	if (event.type === "message_start") {
		const message = normalizeMessage(event.message);
		message._streaming = message.role === "assistant";
		if (hasTextPhase(message, "final_answer")) message._finalStartedAt = Date.now();
		// The optimistic user row is the same message the engine just accepted.
		const optimisticIndex =
			message.role === "user"
				? state.messages.findIndex((item) => item._optimistic && contentText(item) === contentText(message))
				: -1;
		if (optimisticIndex >= 0) state.messages.splice(optimisticIndex, 1);
		state.messages.push(message);
		// Remember where the streaming message lives: role + timestamp merged separate messages.
		state.streamIndex = state.messages.length - 1;
		if (message.role === "user") {
			setBusy(true, "Working");
			void refreshWorkspaceChats(state.workspace);
		}
		renderMessages();
		return;
	}
	if (event.type === "message_update" || event.type === "message_end") {
		const message = { ...normalizeMessage(event.message), _streaming: event.type !== "message_end" };
		const streaming = state.streamIndex >= 0 ? state.messages[state.streamIndex] : undefined;
		let index =
			streaming && streaming.role === message.role
				? state.streamIndex
				: state.messages.findIndex((item) => item._key === message._key);
		// get_messages resets streamIndex while an attached conversation continues
		// streaming. Resume its latest assistant row instead of appending every update.
		if (index < 0 && message.role === "assistant") {
			index = state.messages.findLastIndex((item) => item.role === "assistant");
		}
		if (index >= 0) {
			const finalStartedAt = state.messages[index]._finalStartedAt ?? (hasTextPhase(message, "final_answer") ? Date.now() : undefined);
			state.messages[index] = { ...state.messages[index], ...message, ...(finalStartedAt ? { _finalStartedAt: finalStartedAt } : {}) };
		}
		else {
			if (hasTextPhase(message, "final_answer")) message._finalStartedAt = Date.now();
			state.messages.push(message);
			index = state.messages.length - 1;
		}
		if (event.type === "message_end") {
			state.streamIndex = -1;
			if (message.role === "assistant") state.messages[index]._finishedAt = Date.now();
		} else {
			state.streamIndex = index;
		}
		renderMessages();
		return;
	}
	if (event.type === "tool_execution_start") {
		state.tools.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args, done: false });
		renderMessages();
		return;
	}
	if (event.type === "tool_execution_update") {
		const tool = state.tools.find((item) => item.toolCallId === event.toolCallId);
		if (tool) tool.result = event.partialResult;
		renderMessages();
		return;
	}
	if (event.type === "tool_execution_end") {
		const tool = state.tools.find((item) => item.toolCallId === event.toolCallId);
		if (tool) Object.assign(tool, { result: event.result, done: true, isError: event.isError });
		if (startsBackgroundJob(event)) refreshRuntimeFeatures();
		renderMessages();
		return;
	}
	if (event.type === "rlm_child_update") {
		const child = event.child;
		if (!child?.id) return;
		// A cancelled subagent was deleted by its orchestrator: drop the row rather
		// than leaving a task in the transcript that nothing is doing.
		if (child.status === "cancelled") {
			state.subagents.delete(child.id);
		} else {
			const previous = state.subagents.get(child.id);
			// Anchor to the tool call that was running when the subagent first
			// appeared — the cell that spawned it — and never move it after that.
			const anchorToolCallId =
				previous?.anchorToolCallId ?? state.tools.filter((tool) => !tool.done).at(-1)?.toolCallId;
			state.subagents.set(child.id, { ...previous, ...child, anchorToolCallId });
		}
		renderMessages();
		return;
	}
	if (event.type === "extension_ui_request") {
		void handleExtensionUIRequest(event).catch((error) => showToast(error.message));
	}
}

function bootstrap() {
	clearTimeout(handshakeTimer);
	setBusy(false, "Connecting to the agent…");
	sendCommand("get_state");
	sendCommand("get_available_models");
	sendCommand("get_messages");
	sendCommand("get_commands");
	refreshRuntimeFeatures();
	handshakeTimer = setTimeout(() => {
		if (!state.ready) {
			setStatus("Still starting", "busy");
		}
	}, 8000);
}

// Only the initial launch starts an agent; switching workspaces opens a session
// in the running one.
async function startWorkspace(workspace, { silent = false } = {}) {
	clearTimeout(handshakeTimer);
	setReady(false);
	state.runtimeAvailable = true;
	state.runtimeFeatures = undefined;
	state.jobOutputs.clear();
	state.waitingJobs.clear();
	state.subagents.clear();
	setBusy(false, "Starting Prometheus…");
	if (!silent) {
		displayWorkspace(workspace);
		rememberWorkspace(workspace);
		void refreshWorkspaceChats(workspace);
	}
	try {
		await window.desktopAgent.start({ cwd: workspace });
		// Give the child process a turn to attach its RPC reader before the
		// first request. The agent:started event is also a useful lifecycle
		// boundary, but this fallback keeps startup deterministic if that event
		// is delivered before the renderer listener is attached.
		setTimeout(bootstrap, 50);
	} catch (error) {
		state.switchingSession = false;
		setDisconnected("Agent could not start");
		showToast(error.message);
	}
}

async function submitPrompt(message, allowWithoutModel = false) {
	const fromComposer = message === undefined;
	const composerText = fromComposer ? input.value.trim() : "";
	const attachments = fromComposer ? [...state.attachments] : [];
	if (fromComposer) message = composePromptMessage(composerText, attachments);
	if (!message) return;
	// Selecting a command from the menu runs it immediately via applyCommand; this covers
	// typing the full "/name args" line by hand and hitting Enter before the menu is open.
	const typedCommand = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message);
	const clientCommand = typedCommand && findClientCommand(typedCommand[1]);
	if (clientCommand) {
		input.value = "";
		input.style.height = "auto";
		closeCommandMenu();
		void clientCommand.run(typedCommand[2] || "");
		return;
	}
	const connecting = isEngineConnecting();
	// A missing provider is a real refusal; a connecting engine is not. While it
	// connects the model is not known yet, so that check waits for the flush.
	if (!connecting && !allowWithoutModel && !hasConfiguredModel()) return;
	const wasBusy = state.busy;
	input.value = "";
	input.style.height = "auto";
	if (fromComposer) clearAttachments();
	closeCommandMenu();
	const optimisticMessage = normalizeMessage({ role: "user", content: message, timestamp: Date.now(), _optimistic: true });
	state.messages.push(optimisticMessage);
	renderMessages();
	if (connecting) {
		// Hold the prompt rather than the composer: the engine is either still
		// starting or still attaching to the chat on screen, and sending now would
		// deliver it to the conversation we just left.
		state.queuedPrompt = { message, optimisticMessage, composerText, attachments };
		setBusy(false, state.switchingSession ? "Opening conversation" : "Connecting…");
		return;
	}
	setBusy(true, wasBusy ? "Steering current turn…" : "Working");
	await sendCommand(
		"prompt",
		{ message, ...(wasBusy ? { streamingBehavior: "steer" } : {}) },
		{ message, optimisticKey: optimisticMessage._key },
	);
}

// The row a held prompt already put on screen. Session switching rebuilds the
// transcript from disk, which would otherwise blank a message the user has sent
// but the engine has not accepted yet.
function heldPromptMessages() {
	return state.queuedPrompt ? [state.queuedPrompt.optimisticMessage] : [];
}

// Send a prompt that was typed while the engine was connecting. Its optimistic
// row is already on screen, so this reuses it instead of adding another.
function flushQueuedPrompt() {
	// Keep holding until there is somewhere to send it: the model list arrives on
	// its own response, and an unconfigured provider resolves once one is added.
	if (!state.queuedPrompt || isEngineConnecting() || !hasConfiguredModel()) return;
	const queued = state.queuedPrompt;
	state.queuedPrompt = undefined;
	setBusy(true, "Working");
	void sendCommand("prompt", { message: queued.message }, { message: queued.message, optimisticKey: queued.optimisticMessage._key });
}

// Undo a held prompt: drop its optimistic row and hand the text back rather than
// losing what the user typed.
function returnQueuedPromptToComposer() {
	const queued = state.queuedPrompt;
	state.queuedPrompt = undefined;
	if (!queued) return;
	state.messages = state.messages.filter((message) => message._key !== queued.optimisticMessage._key);
	if (!input.value.trim()) {
		input.value = queued.composerText ?? queued.message;
		state.attachments = queued.attachments || [];
		renderAttachments();
		input.dispatchEvent(new Event("input"));
	}
	renderMessages();
}

async function copyMessageText(message) {
	const text = assistantHasFinalAnswer(message) ? finalAnswerText(message) : contentText(message);
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		showToast("Copied to clipboard");
	} catch {
		showToast("Could not copy to clipboard");
	}
}

async function copyText(text, successMessage = "Copied to clipboard") {
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		showToast(successMessage);
	} catch {
		showToast("Could not copy to clipboard");
	}
}

async function showNativeContextMenu(items, target) {
	if (!items.length) return undefined;
	target?.classList.add("context-open");
	try {
		return await window.desktopAgent.showContextMenu({ items });
	} finally {
		target?.classList.remove("context-open");
	}
}

function findWorkspaceChat(workspace, sessionPath) {
	return (state.workspaceChats.get(workspace) || []).find((chat) => chat.path === sessionPath);
}

async function renameConversation(workspace, sessionPath) {
	const chat = findWorkspaceChat(workspace, sessionPath);
	if (!chat) return;
	const value = await openInteraction({
		title: "Rename conversation",
		kind: "input",
		prefill: chat.name || "",
		placeholder: "Conversation name",
		confirmLabel: "Rename",
	});
	const name = typeof value === "string" ? value.trim() : "";
	if (!name) return;
	try {
		if (workspace === state.workspace && sessionPathKey(sessionPath) === sessionPathKey(state.activeSessionPath)) {
			sendCommand("set_session_name", { name });
		} else {
			await window.desktopAgent.renameSession({ sessionPath, name });
			chat.name = name;
			renderWorkspaceList();
		}
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error));
	}
}

async function deleteConversation(workspace, sessionPath) {
	const chat = findWorkspaceChat(workspace, sessionPath);
	if (!chat) return;
	const active = workspace === state.workspace && sessionPathKey(sessionPath) === sessionPathKey(state.activeSessionPath);
	const confirmed = await openInteraction({
		title: "Move conversation to trash?",
		message: `“${chat.name}” will be removed from Prometheus and moved to the system trash.`,
		confirmLabel: "Move to trash",
	});
	if (confirmed !== true) return;
	try {
		if (active) {
			const { sessionPath: replacementPath } = await window.desktopAgent.createWorkspaceSession({ workspace });
			state.tools = [];
			state.queuedPrompt = undefined;
			input.value = "";
			clearAttachments();
			input.dispatchEvent(new Event("input"));
			state.switchingSession = true;
			state.openedWorkspace = workspace;
			const switchToken = showSessionLocally(replacementPath, "New conversation");
			setBusy(false, "Opening conversation");
			const response = await sendCommandAwait("switch_session", { sessionPath: replacementPath });
			if (switchToken !== state.switchToken || response.data?.cancelled === true) {
				throw new Error("That conversation could not be opened.");
			}
			state.switchingSession = false;
			await window.desktopAgent.trashSession({ sessionPath });
			renderWorkspaceList();
			sendCommand("get_state");
			sendCommand("get_messages");
			sendCommand("get_available_models");
			refreshRuntimeFeatures();
			flushQueuedPrompt();
		} else {
			await window.desktopAgent.trashSession({ sessionPath });
		}
		state.workspaceChats.set(workspace, (state.workspaceChats.get(workspace) || []).filter((item) => item.path !== sessionPath));
		renderWorkspaceList();
		showToast("Conversation moved to trash");
	} catch (error) {
		state.switchingSession = false;
		sendCommand("get_state");
		sendCommand("get_messages");
		showToast(error instanceof Error ? error.message : String(error));
	}
}

function removeWorkspaceFromSidebar(workspace) {
	state.workspaces = state.workspaces.filter((item) => item !== workspace);
	state.collapsedWorkspaces.delete(workspace);
	state.workspaceChats.delete(workspace);
	saveStoredWorkspaces();
	renderWorkspaceList();
	showToast(`Removed ${workspaceName(workspace)} from the sidebar`);
}

async function refreshAllWorkspaceChats() {
	await Promise.all(state.workspaces.map((workspace) => refreshWorkspaceChats(workspace)));
	showToast("Conversation history refreshed");
}

async function handleWorkspaceContextMenu(event, workspace, target) {
	event.preventDefault();
	const collapsed = state.collapsedWorkspaces.has(workspace);
	const action = await showNativeContextMenu([
		{ id: "new", label: "New conversation" },
		{ id: "refresh", label: "Refresh conversations" },
		{ type: "separator" },
		{ id: "open-folder", label: "Open in File Explorer" },
		{ id: "copy-path", label: "Copy workspace path" },
		{ type: "separator" },
		{ id: "toggle", label: collapsed ? "Expand workspace" : "Collapse workspace" },
		{ id: "remove", label: "Remove from sidebar" },
	], target);
	if (action === "new") {
		openWorkspace(workspace);
		if (workspace === state.workspace) void createNewSession();
		else void switchWorkspace(workspace);
	} else if (action === "refresh") void refreshWorkspaceChats(workspace);
	else if (action === "open-folder") void window.desktopAgent.openPath(workspace);
	else if (action === "copy-path") void copyText(workspace, "Workspace path copied");
	else if (action === "toggle") toggleWorkspaceCollapse(workspace);
	else if (action === "remove") removeWorkspaceFromSidebar(workspace);
}

async function handleSessionContextMenu(event, workspace, sessionPath, target) {
	event.preventDefault();
	const chat = findWorkspaceChat(workspace, sessionPath);
	if (!chat) return;
	const active = workspace === state.workspace && sessionPathKey(sessionPath) === sessionPathKey(state.activeSessionPath);
	const working = isSessionWorking(sessionPath);
	const action = await showNativeContextMenu([
		{ id: "open", label: active ? "Conversation is open" : "Open conversation", enabled: !active },
		{ id: "rename", label: "Rename conversation", enabled: !working || active },
		{ type: "separator" },
		{ id: "copy-name", label: "Copy conversation name" },
		{ id: "show-file", label: "Show in File Explorer" },
		{ id: "copy-path", label: "Copy session path" },
		{ type: "separator" },
		{ id: "delete", label: "Move conversation to trash", enabled: active || !working },
	], target);
	if (action === "open") void openConversation(workspace, sessionPath);
	else if (action === "rename") void renameConversation(workspace, sessionPath);
	else if (action === "copy-name") void copyText(chat.name, "Conversation name copied");
	else if (action === "show-file") void window.desktopAgent.showItem(sessionPath);
	else if (action === "copy-path") void copyText(sessionPath, "Session path copied");
	else if (action === "delete") void deleteConversation(workspace, sessionPath);
}

// The session that fork() switches to is a brand new file with its own history;
// this mirrors the reset open_session does when handing off to a different session.
function resetConversationState() {
	state.messages = [];
	state.tools = [];
	state.streamIndex = -1;
	state.runtimeFeatures = undefined;
	state.jobOutputs.clear();
	state.waitingJobs.clear();
	state.subagents.clear();
	state.approval = undefined;
	renderMessages();
}

// entryId isn't carried on transcript messages, so it's looked up by position: the Nth
// user message shown is the Nth entry get_fork_messages returns, in the same order.
async function forkEntryIdForMessage(message) {
	const userMessages = state.messages.filter((item) => item.role === "user" && !item._optimistic);
	const rank = userMessages.indexOf(message);
	if (rank < 0) return undefined;
	const response = await sendCommandAwait("get_fork_messages");
	return response.data?.messages?.[rank]?.entryId;
}

async function forkAtEntry(entryId, position) {
	const response = await sendCommandAwait("fork", { entryId, position });
	const result = response.data || {};
	if (result.cancelled) return result;
	resetConversationState();
	await sendCommand("get_state");
	await sendCommand("get_messages");
	sendCommand("get_available_models");
	refreshRuntimeFeatures();
	void refreshWorkspaceChats(state.workspace);
	return result;
}

async function editFromMessage(message) {
	// The text to edit is already on the client - don't make the user wait on a
	// round trip (entry id lookup, then the actual fork/branch) just to see it in
	// the composer. Put it there immediately and rewind the session underneath in
	// the background; the reader is virtually always still editing by the time
	// that finishes, so it never races a Send.
	input.value = contentText(message);
	input.dispatchEvent(new Event("input"));
	input.focus();
	try {
		const entryId = await forkEntryIdForMessage(message);
		if (!entryId) {
			showToast("Could not find that message to edit.");
			return;
		}
		await forkAtEntry(entryId, "before");
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error));
	}
}

async function forkFromMessage(message) {
	try {
		const entryId = await forkEntryIdForMessage(message);
		if (!entryId) {
			showToast("Could not find that message to fork from.");
			return;
		}
		// "before", not "at": the message forked from is the one about to be re-sent
		// or branched away from, not a message that belongs in the new session.
		const result = await forkAtEntry(entryId, "before");
		if (!result.cancelled) showToast("Forked to a new session");
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error));
	}
}

function precedingUserMessage(message) {
	const index = state.messages.indexOf(message);
	for (let i = index - 1; i >= 0; i--) {
		if (state.messages[i]?.role === "user") return state.messages[i];
	}
	return undefined;
}

async function retryAssistantMessage(message) {
	const userMessage = precedingUserMessage(message);
	if (!userMessage) {
		showToast("No preceding message to retry from.");
		return;
	}
	try {
		const entryId = await forkEntryIdForMessage(userMessage);
		if (!entryId) {
			showToast("Could not find that message to retry.");
			return;
		}
		const result = await forkAtEntry(entryId, "before");
		if (result.cancelled) return;
		await submitPrompt(result.text || "");
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error));
	}
}

conversation.addEventListener("click", (event) => {
	const button = event.target instanceof Element ? event.target.closest("[data-msg-action]") : undefined;
	if (!button) return;
	const rowMatch = /^m:(\d+)$/.exec(button.closest("[data-key]")?.dataset.key || "");
	const messages = state.subagentView?.messages || state.messages;
	const message = rowMatch ? messages[Number(rowMatch[1])] : undefined;
	if (!message) return;
	const action = button.dataset.msgAction;
	if (action === "copy") void copyMessageText(message);
	else if (action === "edit") void editFromMessage(message);
	else if (action === "fork") void forkFromMessage(message);
	else if (action === "retry") void retryAssistantMessage(message);
});

// Relative "X minutes/hours ago" labels go stale without a new message to trigger a
// re-render; renderMessageRow's signature check keeps this cheap when nothing changed.
setInterval(() => {
	if (state.messages.length) renderMessages();
}, 30000);

// Desktop-native slash commands: builtins with no server-side equivalent for an RPC
// client (they open a picker, a dialog, or a native OS control instead of running through
// the agent session). Never sent as prompt text — `run` is invoked locally and the
// composer is cleared. Anything the server already knows about (get_commands) wins on
// a name collision, so this list only fills gaps.
function openNativeSelect(select) {
	select.focus();
	try {
		select.showPicker?.();
	} catch {
		// showPicker can refuse outside a user gesture; focus alone still lets Space/↓ open it.
	}
}

const CLIENT_COMMANDS = [
	{ name: "new", source: "app", description: "Start a new session", run: () => void createNewSession() },
	{ name: "model", source: "app", description: "Select model", run: () => openNativeSelect(modelSelect) },
	{
		name: "effort",
		source: "app",
		description: "Select reasoning/thinking level",
		argumentHint: "[level]",
		run: (args) => {
			const level = args.trim().toLowerCase();
			const option = level && [...thinkingSelect.options].find((item) => item.value === level);
			if (option) {
				thinkingSelect.value = level;
				thinkingSelect.dispatchEvent(new Event("change"));
			} else {
				openNativeSelect(thinkingSelect);
			}
		},
	},
	{ name: "export", source: "app", description: "Export session as HTML", run: () => sendCommand("export_html") },
	{
		name: "name",
		source: "app",
		description: "Rename this session",
		argumentHint: "[name]",
		run: async (args) => {
			const typed = args.trim();
			if (typed) {
				sendCommand("set_session_name", { name: typed });
				return;
			}
			const value = await openInteraction({
				title: "Rename session",
				kind: "input",
				prefill: state.sessionName || "",
				placeholder: "Session name",
				confirmLabel: "Rename",
			});
			if (value?.trim()) sendCommand("set_session_name", { name: value.trim() });
		},
	},
	{
		name: "session",
		source: "app",
		description: "Show session info",
		run: () =>
			void openInteraction({
				title: "Session info",
				kind: "confirm",
				confirmLabel: "Close",
				message: [
					`Name: ${state.sessionName || "New conversation"}`,
					`Workspace: ${workspaceName(state.workspace) || "—"}`,
					`Model: ${formatModel(state.model)}`,
					`Thinking: ${state.thinkingLevel || "off"}`,
					`Session file: ${state.activeSessionPath || "—"}`,
				].join("\n"),
			}),
	},
	{
		name: "context",
		source: "app",
		description: "Show token, cost, and message usage",
		run: () => sendCommand("get_session_stats"),
	},
	{
		name: "copy",
		source: "app",
		description: "Copy last agent message to clipboard",
		run: () => {
			const last = [...state.messages].reverse().find((item) => item.role === "assistant");
			if (last) void copyMessageText(last);
			else showToast("No agent message to copy yet");
		},
	},
	{
		name: "hotkeys",
		source: "app",
		description: "Show keyboard shortcuts",
		run: () =>
			void openInteraction({
				title: "Keyboard shortcuts",
				kind: "confirm",
				confirmLabel: "Close",
				message: [
					"Ctrl+N — New session",
					"Enter — Send message",
					"Shift+Enter — Insert newline",
					"↑ / ↓ — Navigate the command menu",
					"Tab / Enter — Apply the selected command",
					"Esc — Close the command menu or dialog",
				].join("\n"),
			}),
	},
];

function findClientCommand(name) {
	return CLIENT_COMMANDS.find((command) => command.name === name.toLowerCase());
}

// Slash-command autocomplete. Only the leading token completes: the agent parses a
// command from the start of the prompt (parseSlashCommand), so mid-text "/" is plain text.
let commandMatches = [];
let commandIndex = 0;

function commandQuery() {
	if (input.selectionStart !== input.value.length) return undefined;
	const match = /^\/(\S*)$/.exec(input.value);
	return match ? match[1].toLowerCase() : undefined;
}

function closeCommandMenu() {
	commandMatches = [];
	commandMenu.hidden = true;
	commandMenu.replaceChildren();
}

function applyCommand(command) {
	if (command.run) {
		closeCommandMenu();
		input.value = "";
		input.dispatchEvent(new Event("input"));
		void command.run("");
		return;
	}
	input.value = `/${command.name} `;
	input.focus();
	input.dispatchEvent(new Event("input"));
}

function renderCommandMenu() {
	commandMenu.replaceChildren();
	for (const [index, command] of commandMatches.entries()) {
		const item = document.createElement("button");
		item.type = "button";
		item.className = index === commandIndex ? "command-item active" : "command-item";
		item.setAttribute("role", "option");
		item.setAttribute("aria-selected", String(index === commandIndex));
		const name = document.createElement("span");
		name.className = "command-name";
		name.textContent = `/${command.name}`;
		const description = document.createElement("span");
		description.className = "command-description";
		description.textContent = command.description || "";
		description.title = command.description || "";
		const source = document.createElement("span");
		source.className = "command-source";
		source.textContent = command.source || "";
		item.append(name, description, source);
		// mousedown, not click: click fires after the textarea has already lost focus.
		item.addEventListener("mousedown", (event) => {
			event.preventDefault();
			applyCommand(command);
		});
		commandMenu.appendChild(item);
	}
	commandMenu.hidden = commandMatches.length === 0;
	commandMenu.querySelector(".command-item.active")?.scrollIntoView({ block: "nearest" });
}

function updateCommandMenu() {
	const query = commandQuery();
	if (query === undefined) {
		closeCommandMenu();
		return;
	}
	const knownNames = new Set(state.commands.map((command) => command.name));
	const pool = [...state.commands, ...CLIENT_COMMANDS.filter((command) => !knownNames.has(command.name))];
	commandMatches = pool.filter((command) => command.name.toLowerCase().startsWith(query));
	commandIndex = 0;
	renderCommandMenu();
}

function moveCommandSelection(delta) {
	commandIndex = (commandIndex + delta + commandMatches.length) % commandMatches.length;
	renderCommandMenu();
}

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	await submitPrompt();
});

input.addEventListener("input", () => {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
	syncComposer();
	updateCommandMenu();
});
input.addEventListener("keydown", (event) => {
	if (commandMatches.length) {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveCommandSelection(event.key === "ArrowDown" ? 1 : -1);
			return;
		}
		if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
			event.preventDefault();
			applyCommand(commandMatches[commandIndex]);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			closeCommandMenu();
			return;
		}
	}
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		$("composer").requestSubmit();
	}
});

input.addEventListener("blur", closeCommandMenu);

const IMAGE_ATTACHMENT_EXTENSIONS = new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]);
const attachmentPreviewCache = new Map();

function attachmentName(path) {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function attachmentExtension(path) {
	const name = attachmentName(path);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "file";
}

function imageAttachmentPreview(path) {
	if (!attachmentPreviewCache.has(path)) {
		attachmentPreviewCache.set(
			path,
			window.desktopAgent.getImagePreview(path).catch(() => undefined),
		);
	}
	return attachmentPreviewCache.get(path);
}

function createAttachmentRemoveButton(path, name) {
	const button = document.createElement("button");
	button.className = "attachment-remove";
	button.type = "button";
	button.title = `Remove ${name}`;
	button.setAttribute("aria-label", button.title);
	button.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>';
	button.addEventListener("click", () => {
		state.attachments = state.attachments.filter((attachment) => attachment !== path);
		attachmentPreviewCache.delete(path);
		renderAttachments();
		syncComposer();
		input.focus();
	});
	return button;
}

function renderAttachments() {
	attachmentList.replaceChildren();
	for (const path of state.attachments) {
		const name = attachmentName(path);
		const extension = attachmentExtension(path);
		const card = document.createElement("div");
		card.className = `attachment-card attachment-card-${IMAGE_ATTACHMENT_EXTENSIONS.has(extension) ? "image" : "file"}`;
		card.setAttribute("role", "listitem");
		card.title = path;
		if (IMAGE_ATTACHMENT_EXTENSIONS.has(extension)) {
			card.classList.add("preview-loading");
			const preview = document.createElement("img");
			preview.className = "attachment-preview";
			preview.alt = name;
			preview.addEventListener("error", () => {
				card.classList.remove("preview-loading");
				card.classList.add("preview-failed");
			});
			const fallback = document.createElement("span");
			fallback.className = "attachment-preview-fallback";
			fallback.setAttribute("aria-hidden", "true");
			fallback.innerHTML = '<svg viewBox="0 0 20 20"><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="m4.5 14 3.5-3 2.5 2 2-1.5 3 2.5"/></svg>';
			card.append(preview, fallback);
			void imageAttachmentPreview(path).then((source) => {
				if (!card.isConnected) return;
				card.classList.remove("preview-loading");
				if (source) preview.src = source;
				else card.classList.add("preview-failed");
			});
		} else {
			const icon = document.createElement("span");
			icon.className = "attachment-file-icon";
			icon.setAttribute("aria-hidden", "true");
			icon.innerHTML = '<svg viewBox="0 0 20 20"><path d="M5 2.75h6l4 4v10.5H5z"/><path d="M11 2.75v4h4M7.5 10h5M7.5 13h5"/></svg>';
			const copy = document.createElement("span");
			copy.className = "attachment-file-copy";
			const title = document.createElement("span");
			title.className = "attachment-file-name";
			title.textContent = name;
			const type = document.createElement("span");
			type.className = "attachment-file-type";
			type.textContent = extension;
			copy.append(title, type);
			card.append(icon, copy);
		}
		card.appendChild(createAttachmentRemoveButton(path, name));
		attachmentList.appendChild(card);
	}
	attachmentList.hidden = state.attachments.length === 0;
}

function clearAttachments() {
	if (!state.attachments.length) return;
	for (const path of state.attachments) attachmentPreviewCache.delete(path);
	state.attachments = [];
	renderAttachments();
}

function composePromptMessage(text, attachments) {
	const paths = attachments.map((path) => (/\s/.test(path) ? `"${path}"` : path)).join(" ");
	return [text, paths].filter(Boolean).join(" ");
}

// Attachments are handed to the agent as file paths; the cards keep those paths
// out of the editable prompt while preserving the existing prompt payload.
function addAttachments(paths) {
	if (!paths?.length) return;
	const knownPaths = new Set(state.attachments.map((path) => path.toLocaleLowerCase()));
	for (const path of paths) {
		if (typeof path !== "string" || !path || knownPaths.has(path.toLocaleLowerCase())) continue;
		knownPaths.add(path.toLocaleLowerCase());
		state.attachments.push(path);
	}
	renderAttachments();
	syncComposer();
	input.focus();
}

$("attach-button").addEventListener("click", async () => {
	addAttachments(await window.desktopAgent.chooseFiles());
});

input.addEventListener("paste", async (event) => {
	const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
	if (!files.length) return;
	event.preventDefault();
	const paths = [];
	for (const file of files) {
		const data = new Uint8Array(await file.arrayBuffer());
		paths.push(
			await window.desktopAgent.savePastedImage({ data, extension: file.type.split("/")[1] || "png" }),
		);
	}
	addAttachments(paths);
});

const composerBox = document.querySelector(".composer-box");
for (const type of ["dragenter", "dragover"]) {
	composerBox.addEventListener(type, (event) => {
		if (input.disabled || !event.dataTransfer?.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		composerBox.classList.add("dropping");
	});
}
for (const type of ["dragleave", "drop"]) {
	composerBox.addEventListener(type, () => composerBox.classList.remove("dropping"));
}
composerBox.addEventListener("drop", (event) => {
	const files = Array.from(event.dataTransfer?.files || []);
	if (input.disabled || !files.length) return;
	event.preventDefault();
	addAttachments(files.map((file) => window.desktopAgent.getFilePath(file)).filter(Boolean));
});
// A file dropped outside the composer would otherwise navigate the window away.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

$("dictate-button").addEventListener("click", async () => {
	input.focus();
	try {
		await window.desktopAgent.startDictation();
	} catch (error) {
		showToast(error?.message || "Voice input is unavailable.");
	}
});

for (const button of document.querySelectorAll("[data-prompt]")) {
	button.addEventListener("click", () => {
		input.value = button.dataset.prompt;
		input.dispatchEvent(new Event("input"));
		input.focus();
	});
}

connectProviderButton.addEventListener("click", openProviderDialog);
$("welcome-connect-provider-button").addEventListener("click", openProviderDialog);
providerSelect.addEventListener("change", updateProviderKeyHelp);
providerForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void connectSelectedProvider();
});
$("provider-dialog-close").addEventListener("click", closeProviderDialog);
$("provider-dialog-cancel").addEventListener("click", closeProviderDialog);
$("subscription-login-button").addEventListener("click", () => {
	void startSubscriptionLogin();
});
providerDialog.addEventListener("close", () => {
	providerApiKey.value = "";
	providerApiKey.type = "password";
	secretToggle.textContent = "Show";
	secretToggle.setAttribute("aria-pressed", "false");
});
secretToggle.addEventListener("click", () => {
	const visible = providerApiKey.type === "text";
	providerApiKey.type = visible ? "password" : "text";
	secretToggle.textContent = visible ? "Show" : "Hide";
	secretToggle.setAttribute("aria-pressed", String(!visible));
	providerApiKey.focus();
});

interactionForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!activeInteraction) return;
	if (activeInteraction.kind === "confirm") finishInteraction(true);
	else finishInteraction(activeInteraction.control?.value ?? "");
});
$("interaction-cancel").addEventListener("click", () => finishInteraction(null));
$("interaction-close").addEventListener("click", () => finishInteraction(null));
interactionDialog.addEventListener("cancel", (event) => {
	event.preventDefault();
	finishInteraction(null);
});

async function confirmDiscard(title, message, confirmLabel) {
	if (!state.busy && !state.messages.length && !input.value.trim()) return true;
	return (await openInteraction({ title, message, confirmLabel })) === true;
}

// Show a conversation without waiting for the engine. Attaching to a session the
// daemon has no worker for costs a process spawn (seconds); the transcript on
// disk is the same message list, so the chat paints now and the engine's copy
// reconciles when open_session lands.
function showSessionLocally(sessionPath, sessionName) {
	closeSubagentConversation();
	const token = ++state.switchToken;
	state.activeSessionPath = sessionPath;
	// A prompt still held for this chat keeps its row. Every caller that navigates
	// somewhere else drops the held prompt first, so anything left here belongs to
	// the session being opened — blanking it would erase what the user just sent.
	state.messages = heldPromptMessages();
	state.tools = [];
	state.streamIndex = -1;
	state.runtimeFeatures = undefined;
	state.jobOutputs.clear();
	state.waitingJobs.clear();
	state.subagents.clear();
	state.approval = undefined;
	state.workspaceChanges = [];
	renderWorkspaceChanges();
	const chat = (state.workspaceChats.get(state.workspace) || []).find((entry) => entry.path === sessionPath);
	state.sessionName = sessionName || chat?.name || "New conversation";
	$("header-title").textContent = state.sessionName;
	renderMessages();
	renderWorkspaceList();
	// A session that has not been minted yet has nothing to read.
	if (!sessionPath) return token;
	void refreshWorkspaceChanges();
	void window.desktopAgent
		.readSessionMessages({ sessionPath })
		.then(({ messages }) => {
			if (token !== state.switchToken) return;
			state.messages = [...(messages || []).map(normalizeMessage), ...heldPromptMessages()];
			renderMessages();
			void restoreSubagents(sessionPath);
		})
		.catch(() => {
			// An unreadable transcript just means the engine's copy shows first.
		});
	return token;
}

function requestSessionSwitch(sessionPath, options = {}) {
	if (!state.ready || !sessionPath) return;
	state.switchingSession = true;
	// Callers point the sidebar at the target workspace before switching, so this
	// is the workspace the opened conversation is expected to run in.
	state.openedWorkspace = state.workspace;
	const switchToken = showSessionLocally(sessionPath, options.sessionName);
	setBusy(false, "Opening conversation");
	// open_session, not switch_session: switching replaces the agent's session in
	// place, which stops whatever the conversation we are leaving was doing.
	sendCommand("open_session", { sessionPath }, { sessionPath, switchToken });
}

async function openConversation(workspace, sessionPath) {
	if (!workspace || !sessionPath) return;
	if (state.subagentView) closeSubagentConversation();
	if (workspace === state.workspace && sessionPath === state.activeSessionPath) return;
	// Leaving for another chat abandons anything typed for this one, queued included.
	state.queuedPrompt = undefined;
	input.value = "";
	clearAttachments();
	input.dispatchEvent(new Event("input"));
	if (workspace !== state.workspace) {
		displayWorkspace(workspace);
	}
	requestSessionSwitch(sessionPath);
}

async function createNewSession() {
	if (!state.ready) return;
	openWorkspace(state.workspace);
	state.tools = [];
	state.queuedPrompt = undefined;
	input.value = "";
	clearAttachments();
	setBusy(false, "Creating session");
	// Blank the conversation on click rather than after the round trip: an empty
	// chat is exactly what the new session will contain. The switch flag is what
	// holds a prompt typed before the agent has the new session open.
	showSessionLocally("", "New conversation");
	state.switchingSession = true;
	// Mint the transcript first so the new chat is a session of its own that the
	// agent opens alongside the running one, rather than one that replaces it.
	try {
		const { sessionPath } = await window.desktopAgent.createWorkspaceSession({ workspace: state.workspace });
		requestSessionSwitch(sessionPath);
	} catch (error) {
		state.switchingSession = false;
		state.queuedPrompt = undefined;
		setBusy(false, "Ready");
		showToast(error instanceof Error ? error.message : String(error));
	}
}

$("new-session-button").addEventListener("click", () => void createNewSession());

async function switchWorkspace(workspace) {
	if (!workspace || workspace === state.workspace) return;
	// Move the sidebar and the transcript now so the switch reads as immediate;
	// the composer holds any prompt typed while the session attaches.
	state.queuedPrompt = undefined;
	input.value = "";
	clearAttachments();
	input.dispatchEvent(new Event("input"));
	const previousWorkspace = state.workspace;
	displayWorkspace(workspace);
	rememberWorkspace(workspace);
	void refreshWorkspaceChats(workspace);
	// Mint the conversation here and open it in place. The agent process is not
	// bound to a workspace — each session runs in the cwd recorded in its own
	// header — so restarting the agent bought nothing but a second cold session
	// worker and a dead UI for the length of a process boot.
	let sessionPath;
	try {
		({ sessionPath } = await window.desktopAgent.createWorkspaceSession({ workspace }));
	} catch (error) {
		displayWorkspace(previousWorkspace);
		showToast(error instanceof Error ? error.message : String(error));
		return;
	}
	requestSessionSwitch(sessionPath, { sessionName: "New conversation" });
}

$("workspace-add-button").addEventListener("click", async () => {
	const workspace = await window.desktopAgent.chooseWorkspace();
	await switchWorkspace(workspace);
});

workspaceList.addEventListener("click", (event) => {
	const target = event.target instanceof Element ? event.target.closest("button") : undefined;
	if (target?.dataset.sessionPath && target.dataset.sessionWorkspace) {
		void openConversation(target.dataset.sessionWorkspace, target.dataset.sessionPath);
		return;
	}
	if (target?.dataset.newSessionWorkspace) {
		const workspace = target.dataset.newSessionWorkspace;
		openWorkspace(workspace);
		if (workspace === state.workspace) void createNewSession();
		else void switchWorkspace(workspace);
		return;
	}
	if (target?.dataset.collapseWorkspace) {
		toggleWorkspaceCollapse(target.dataset.collapseWorkspace);
		return;
	}
	if (target?.dataset.selectWorkspace) {
		void switchWorkspace(target.dataset.selectWorkspace);
	}
});

async function handleTranscriptContextMenu(event, row) {
	const key = row.dataset.key || "";
	if (key.startsWith("t:")) {
		event.preventDefault();
		const details = row.querySelector(".tool-card");
		const command = row.querySelector(".tool-command-code")?.textContent || "";
		const output = row.querySelector(".diff-card-body, .tool-output")?.textContent || "";
		const action = await showNativeContextMenu([
			{ id: "toggle", label: details?.open ? "Collapse tool details" : "Expand tool details" },
			{ type: "separator" },
			{ id: "copy-output", label: "Copy tool output", enabled: Boolean(output) },
			{ id: "copy-command", label: "Copy command", enabled: Boolean(command) },
		], row);
		if (action === "toggle" && details) details.open = !details.open;
		else if (action === "copy-output") void copyText(output, "Tool output copied");
		else if (action === "copy-command") void copyText(command, "Command copied");
		return;
	}

	const match = /^m:(\d+)$/.exec(key);
	const messages = state.subagentView?.messages || state.messages;
	const message = match ? messages[Number(match[1])] : undefined;
	if (!message || !["user", "assistant"].includes(message.role) || message._streaming || message._optimistic) return;
	event.preventDefault();
	const selection = window.getSelection()?.toString().trim() || "";
	const readOnly = Boolean(state.subagentView);
	const items = selection ? [{ id: "copy-selection", label: "Copy selection" }, { type: "separator" }] : [];
	if (!readOnly && message.role === "user") {
		items.push(
			{ id: "edit", label: "Edit and resend" },
			{ id: "fork", label: "Fork from here" },
			{ type: "separator" },
		);
	} else if (!readOnly && message.role === "assistant") {
		items.push({ id: "retry", label: "Retry response" }, { type: "separator" });
	}
	items.push({ id: "copy", label: "Copy message" });
	const action = await showNativeContextMenu(items, row);
	if (action === "copy-selection") void copyText(selection);
	else if (action === "copy") void copyMessageText(message);
	else if (action === "edit") void editFromMessage(message);
	else if (action === "fork") void forkFromMessage(message);
	else if (action === "retry") void retryAssistantMessage(message);
}

async function handleSidebarBackgroundContextMenu(event) {
	event.preventDefault();
	const action = await showNativeContextMenu([
		{ id: "new", label: "New conversation", enabled: Boolean(state.workspace && state.ready) },
		{ id: "add", label: "Add workspace…" },
		{ id: "refresh", label: "Refresh all conversations", enabled: state.workspaces.length > 0 },
		{ type: "separator" },
		{ id: "expand", label: "Expand all workspaces", enabled: state.collapsedWorkspaces.size > 0 },
		{ id: "collapse", label: "Collapse all workspaces", enabled: state.workspaces.length > 0 },
	], sidebar);
	if (action === "new") void createNewSession();
	else if (action === "add") $("workspace-add-button").click();
	else if (action === "refresh") void refreshAllWorkspaceChats();
	else if (action === "expand") {
		state.collapsedWorkspaces.clear();
		renderWorkspaceList();
	} else if (action === "collapse") {
		state.collapsedWorkspaces = new Set(state.workspaces);
		renderWorkspaceList();
	}
}

document.addEventListener("contextmenu", (event) => {
	if (!(event.target instanceof Element)) return;
	const target = event.target;
	const editable = target.closest("input, textarea, [contenteditable='true']");
	if (editable) {
		event.preventDefault();
		void showNativeContextMenu([
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ type: "separator" },
			{ role: "selectAll" },
		], editable);
		return;
	}
	const session = target.closest("[data-session-path][data-session-workspace]");
	if (session) {
		void handleSessionContextMenu(event, session.dataset.sessionWorkspace, session.dataset.sessionPath, session);
		return;
	}
	const workspaceCard = target.closest("[data-workspace]");
	if (workspaceCard) {
		void handleWorkspaceContextMenu(event, workspaceCard.dataset.workspace, workspaceCard.querySelector(".workspace-card-header"));
		return;
	}
	const link = target.closest("a[href]");
	if (link) {
		event.preventDefault();
		void showNativeContextMenu([
			{ id: "open", label: "Open link" },
			{ id: "copy", label: "Copy link address" },
		], link).then((action) => {
			if (action === "open") void window.desktopAgent.openExternal(link.href);
			else if (action === "copy") void copyText(link.href, "Link copied");
		});
		return;
	}
	const code = target.closest("pre, code");
	if (code) {
		event.preventDefault();
		void showNativeContextMenu([{ id: "copy", label: "Copy code" }], code).then((action) => {
			if (action === "copy") void copyText(code.textContent || "", "Code copied");
		});
		return;
	}
	const transcriptRow = target.closest(".message-row");
	if (transcriptRow) {
		void handleTranscriptContextMenu(event, transcriptRow);
		return;
	}
	if (target.closest(".topbar-context")) {
		event.preventDefault();
		void showNativeContextMenu([
			{ id: "rename", label: "Rename conversation" },
			{ id: "export", label: "Export conversation" },
			{ id: "stats", label: "Show conversation stats" },
			{ type: "separator" },
			{ id: "show-file", label: "Show in File Explorer", enabled: Boolean(state.activeSessionPath) },
			{ id: "copy-path", label: "Copy session path", enabled: Boolean(state.activeSessionPath) },
		], target.closest(".topbar-context")).then((action) => {
			if (action === "rename") void findClientCommand("name")?.run("");
			else if (action === "export") sendCommand("export_html");
			else if (action === "stats") sendCommand("get_session_stats");
			else if (action === "show-file") void window.desktopAgent.showItem(state.activeSessionPath);
			else if (action === "copy-path") void copyText(state.activeSessionPath, "Session path copied");
		});
		return;
	}
	if (target.closest(".sidebar")) void handleSidebarBackgroundContextMenu(event);
});
document.addEventListener("scroll", (event) => revealScrollbar(event.target), true);
document.addEventListener("pointermove", (event) => revealScrollbar(event.target), { passive: true });
document.addEventListener("focusin", (event) => revealScrollbar(event.target));

const SIDEBAR_WIDTH_STORAGE_KEY = "prometheus:sidebar-width";
const SIDEBAR_CONTENT_MIN_WIDTH = 420;

function sidebarBounds() {
	const styles = getComputedStyle(document.documentElement);
	const min = Number.parseFloat(styles.getPropertyValue("--sidebar-min-width")) || 248;
	const configuredMax = Number.parseFloat(styles.getPropertyValue("--sidebar-max-width")) || 520;
	const viewportMax = window.innerWidth - SIDEBAR_CONTENT_MIN_WIDTH;
	return { min, max: Math.max(min, Math.min(configuredMax, viewportMax)) };
}

function setSidebarWidth(width, persist = false) {
	const { min, max } = sidebarBounds();
	const clamped = Math.round(Math.max(min, Math.min(max, width)));
	document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
	if (persist) {
		try {
			localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped));
		} catch {
			// Ignore storage failures, such as private browsing restrictions.
		}
	}
}

function setupSidebarResize() {
	if (!sidebar || !sidebarResizer) return;
	try {
		const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
		if (Number.isFinite(saved)) setSidebarWidth(saved);
	} catch {
		// Use the default width when storage is unavailable.
	}

	let startX = 0;
	let startWidth = 0;
	const stopResize = () => {
		document.body.classList.remove("sidebar-resizing");
		if (sidebarResizer.hasPointerCapture?.(activePointerId)) sidebarResizer.releasePointerCapture(activePointerId);
		setSidebarWidth(sidebar.getBoundingClientRect().width, true);
	};
	let activePointerId = -1;
	sidebarResizer.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		activePointerId = event.pointerId;
		startX = event.clientX;
		startWidth = sidebar.getBoundingClientRect().width;
		document.body.classList.add("sidebar-resizing");
		sidebarResizer.setPointerCapture?.(activePointerId);
	});
	sidebarResizer.addEventListener("pointermove", (event) => {
		if (!document.body.classList.contains("sidebar-resizing")) return;
		setSidebarWidth(startWidth + event.clientX - startX);
	});
	sidebarResizer.addEventListener("pointerup", stopResize);
	sidebarResizer.addEventListener("pointercancel", stopResize);
	sidebarResizer.addEventListener("keydown", (event) => {
		const step = event.shiftKey ? 50 : 10;
		const current = sidebar.getBoundingClientRect().width;
		if (event.key === "ArrowRight") setSidebarWidth(current + step, true);
		else if (event.key === "ArrowLeft") setSidebarWidth(current - step, true);
		else if (event.key === "Home") setSidebarWidth(sidebarBounds().min, true);
		else if (event.key === "End") setSidebarWidth(sidebarBounds().max, true);
		else return;
		event.preventDefault();
	});
	window.addEventListener("resize", () => setSidebarWidth(sidebar.getBoundingClientRect().width));
}

setupSidebarResize();

modelSelect.addEventListener("change", () => {
	const [provider, ...idParts] = modelSelect.value.split(":");
	if (provider && idParts.length) sendCommand("set_model", { provider, modelId: idParts.join(":") });
});

thinkingSelect.addEventListener("change", () => {
	state.thinkingLevel = thinkingSelect.value;
	sendCommand("set_thinking_level", { level: state.thinkingLevel });
});

$("export-button").addEventListener("click", () => sendCommand("export_html"));
$("stats-button").addEventListener("click", () => sendCommand("get_session_stats"));
$("runtime-button").addEventListener("click", () => {
	if (runtimeDrawer.hidden) openRuntimeDrawer();
	else closeRuntimeDrawer();
});
$("runtime-close").addEventListener("click", closeRuntimeDrawer);
subagentBackButton.addEventListener("click", closeSubagentConversation);
jobBannerToggle.addEventListener("click", () => {
	state.jobBannerExpanded = !state.jobBannerExpanded;
	renderJobBanner(state.runtimeFeatures?.jobs || []);
});
changeReviewToggle.addEventListener("click", () => {
	state.changeReviewExpanded = !state.changeReviewExpanded;
	renderWorkspaceChanges();
});
acceptAllChanges.addEventListener("click", () => void applyWorkspaceChangeReview("accept-all"));
rejectAllChanges.addEventListener("click", async () => {
	const confirmed = await openInteraction({
		title: "Reject all workspace changes?",
		message: "This undoes the listed agent changes while preserving compatible edits made afterward.",
		confirmLabel: "Reject changes",
	});
	if (confirmed === true) void applyWorkspaceChangeReview("reject-all");
});
async function requestExecutionMode(mode) {
	if (!mode || mode === state.runtimeFeatures?.executionMode) return;
	if (mode === "unrestricted") {
		const confirmed = await openInteraction({
			title: "Use unrestricted execution?",
			message: "New processes will be able to read, write, and use the network without OS sandboxing.",
			confirmLabel: "Use unrestricted",
		});
		if (confirmed !== true) {
			renderRuntimeFeatures();
			return;
		}
	}
	sendCommand("set_execution_mode", { mode });
}

$("mode-picker").addEventListener("click", (event) => {
	const button = event.target instanceof Element ? event.target.closest("[data-execution-mode]") : undefined;
	requestExecutionMode(button?.dataset.executionMode);
});
const composerMode = $("composer-mode");
const composerModeMenu = $("composer-mode-menu");

function closeComposerModeMenu() {
	composerModeMenu.hidden = true;
	composerMode.setAttribute("aria-expanded", "false");
}

composerMode.addEventListener("click", () => {
	if (composerMode.disabled) return;
	const opening = composerModeMenu.hidden;
	composerModeMenu.hidden = !opening;
	composerMode.setAttribute("aria-expanded", String(opening));
});
composerModeMenu.addEventListener("click", (event) => {
	const option = event.target instanceof Element ? event.target.closest("[data-composer-execution-mode]") : undefined;
	if (!option) return;
	closeComposerModeMenu();
	requestExecutionMode(option.dataset.composerExecutionMode);
});
composerModeMenu.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	closeComposerModeMenu();
	composerMode.focus();
});
document.addEventListener("pointerdown", (event) => {
	if (!composerModeMenu.hidden && event.target instanceof Node && !$("composer-mode").parentElement.contains(event.target)) closeComposerModeMenu();
});
$("job-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const commandInput = $("job-command");
	const command = commandInput.value.trim();
	if (!command) return;
	commandInput.value = "";
	sendCommand("start_background_job", { command });
});
runtimeDrawer.addEventListener("click", async (event) => {
	const button = event.target instanceof Element ? event.target.closest("[data-runtime-action]") : undefined;
	if (!button) return;
	const action = button.dataset.runtimeAction;
	if (action === "tail-job" && button.dataset.jobId) {
		if (state.jobOutputs.has(button.dataset.jobId)) {
			state.jobOutputs.delete(button.dataset.jobId);
			renderRuntimeFeatures();
		} else {
			sendCommand("tail_background_job", { jobId: button.dataset.jobId, maxChars: 12000 }, { jobId: button.dataset.jobId });
		}
		return;
	}
	if (action === "cancel-job" && button.dataset.jobId) {
		sendCommand("cancel_background_job", { jobId: button.dataset.jobId });
		return;
	}
	if (action === "write-job" && button.dataset.jobId) {
		const value = await openInteraction({
			title: "Send input to background job",
			message: "The input is written to the running process exactly as entered.",
			kind: "input",
			placeholder: "Input, including any needed newline",
			confirmLabel: "Send input",
		});
		if (typeof value === "string" && value) {
			sendCommand("write_background_job", { jobId: button.dataset.jobId, input: value });
		}
		return;
	}
	if (action === "apply-worktree" && button.dataset.worktreeId) {
		sendCommand("apply_subagent_worktree", { worktreeId: button.dataset.worktreeId });
		return;
	}
	if (action === "discard-worktree" && button.dataset.worktreeId) {
		const confirmed = await openInteraction({
			title: "Discard isolated changes?",
			message: "The retained patch and its worktree will be removed.",
			confirmLabel: "Discard changes",
		});
		if (confirmed === true) sendCommand("discard_subagent_worktree", { worktreeId: button.dataset.worktreeId });
	}
});
stopButton.addEventListener("click", () => {
	stopButton.disabled = true;
	sendCommand("abort").finally(() => {
		stopButton.disabled = false;
	});
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && state.subagentView && runtimeDrawer.hidden && !providerDialog.open && !interactionDialog.open) {
		closeSubagentConversation();
		return;
	}
	if (event.key === "Escape" && !runtimeDrawer.hidden && !providerDialog.open && !interactionDialog.open) {
		closeRuntimeDrawer();
		return;
	}
	const binding = DEFAULT_DESKTOP_KEYBINDINGS.newSession;
	if (event.key.toLowerCase() === binding.key && event.ctrlKey === binding.ctrlKey && !event.altKey && !event.shiftKey) {
		event.preventDefault();
		void createNewSession();
	}
});

// Chats we are not attached to send no events, so their working state has to be
// polled. The attached chat drives its own indicator from state.busy.
setInterval(() => {
	refreshBusySessions();
	void refreshViewedSubagent();
}, 2000);
document.addEventListener("visibilitychange", () => {
	refreshBusySessions();
	if (!document.hidden) void refreshWorkspaceChanges();
});

window.desktopAgent.onEvent(handleAgentEvent);
window.desktopAgent.onProviderLoginEvent(handleProviderLoginEvent);
window.desktopAgent.onError((payload) => {
	const message = payload?.message || "The agent process stopped unexpectedly.";
	clearTimeout(handshakeTimer);
	setDisconnected("Agent stopped");
	showToast(message.trim());
});
window.desktopAgent.onExit((payload) => {
	clearTimeout(handshakeTimer);
	setDisconnected(payload?.code === 0 ? "Agent stopped" : "Agent stopped unexpectedly");
	showToast(payload?.code === 0 ? "Prometheus stopped. Restart the session to reconnect." : "The Prometheus process stopped. Restart the session to reconnect.");
});

(async () => {
	state.workspaces = await loadStoredWorkspaces();
	void Promise.all(state.workspaces.map((storedWorkspace) => refreshWorkspaceChats(storedWorkspace)));
	if (state.workspaces[0]) {
		await startWorkspace(state.workspaces[0]);
	} else {
		// Nothing saved yet: keep the workspace list empty and start the engine in
		// the user's profile folder so it's already warm once one is picked.
		pendingDefaultCwd = await window.desktopAgent.getDefaultWorkspace();
		await startWorkspace(pendingDefaultCwd, { silent: true });
	}
})();

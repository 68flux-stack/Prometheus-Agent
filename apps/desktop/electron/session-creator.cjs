const { parentPort, workerData } = require("node:worker_threads");
const { existsSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

function countTextLines(filePath) {
	try {
		const stats = statSync(filePath);
		if (!stats.isFile() || stats.size > 4 * 1024 * 1024) return undefined;
		const content = readFileSync(filePath);
		if (content.includes(0)) return undefined;
		if (content.length === 0) return 0;
		let lines = 0;
		for (const byte of content) if (byte === 10) lines++;
		return lines + (content[content.length - 1] === 10 ? 0 : 1);
	} catch {
		return undefined;
	}
}

function countPatchLines(patchText) {
	let added = 0;
	let removed = 0;
	for (const line of patchText.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function createSession(SessionManager) {
	const { workspace, sessionsDir } = workerData;
	const session = SessionManager.create(workspace, sessionsDir);
	session.flushNow();
	const sessionPath = session.getSessionFile();
	if (!sessionPath) throw new Error("Could not create a conversation for this workspace.");
	return { sessionPath };
}

function listWorkspaceChanges(SessionManager, WorkspaceChangeReview) {
	const session = SessionManager.open(workerData.sessionPath);
	const artifactDir = session.getSessionArtifactDir();
	if (!artifactDir || !existsSync(path.join(artifactDir, "change-review.json"))) return { changes: [] };
	const review = WorkspaceChangeReview.openOrCreate(session.getCwd(), artifactDir);
	let baselineEntries = {};
	let pendingBeforeEntries = {};
	try {
		baselineEntries = JSON.parse(readFileSync(path.join(artifactDir, "change-review.json"), "utf8")).entries || {};
	} catch {}
	try {
		const pending = JSON.parse(readFileSync(path.join(artifactDir, "change-review-pending.json"), "utf8"));
		for (const delta of pending?.deltas || []) {
			for (const entry of delta?.entries || []) {
				if (!(entry.path in pendingBeforeEntries)) pendingBeforeEntries[entry.path] = entry.before;
			}
		}
	} catch {}
	const changes = review.changes().map((change) => {
		let stats;
		if (change.status === "modified" && change.kind === "file" && change.baselineKind === "file") {
			stats = countPatchLines(review.preview(change.path));
		} else if (change.status === "created" && change.kind === "file") {
			const added = countTextLines(path.resolve(session.getCwd(), change.path));
			if (added !== undefined) stats = { added, removed: 0 };
		} else if (change.status === "deleted" && change.baselineKind === "file") {
			const hash = pendingBeforeEntries[change.path]?.hash ?? baselineEntries[change.path]?.hash;
			const removed = typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
				? countTextLines(path.join(artifactDir, "change-review-objects", hash))
				: undefined;
			if (removed !== undefined) stats = { added: 0, removed };
		} else if (change.status === "renamed") {
			stats = { added: 0, removed: 0 };
		}
		return { ...change, ...stats };
	});
	return { changes };
}

try {
	const { SessionManager } = require(path.join(workerData.distDir, "core", "session-manager.js"));
	const result = workerData.action === "create"
		? createSession(SessionManager)
		: workerData.action === "list-workspace-changes"
			? listWorkspaceChanges(SessionManager, require(path.join(workerData.distDir, "core", "workspace-change-review.js")).WorkspaceChangeReview)
			: undefined;
	if (!result) throw new Error("Unknown session worker action.");
	parentPort.postMessage(result);
} catch (error) {
	parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}

import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { applyPatch, createTwoFilesPatch } from "diff";
import ignore from "ignore";

type EntryKind = "file" | "directory" | "symlink";

interface ManifestEntry {
	kind: EntryKind;
	hash?: string;
	target?: string;
	/**
	 * Stat identity of the file the hash was taken from. A rescan that sees the same
	 * size and mtime reuses the hash instead of re-reading the bytes — without it,
	 * every changes() call re-hashes the whole workspace, and one accept()/reject()
	 * does that three times over.
	 *
	 * ponytail: same race as git's index — a write that keeps the size and lands in
	 * the same mtime tick is missed. Add a content check only if that ever bites.
	 */
	size?: number;
	mtimeMs?: number;
}

interface Manifest {
	version: 1;
	entries: Record<string, ManifestEntry>;
}

interface WorkspaceDeltaEntry {
	path: string;
	before?: ManifestEntry;
	after?: ManifestEntry;
}

interface WorkspaceDelta {
	entries: WorkspaceDeltaEntry[];
}

interface PendingManifest {
	version: 2;
	deltas: WorkspaceDelta[];
	activeBaseline?: Record<string, ManifestEntry>;
	activePaths?: string[];
}

interface PlannedPathState {
	entry?: ManifestEntry;
	content?: Buffer;
}

export interface WorkspaceChange {
	path: string;
	status: "created" | "deleted" | "modified" | "renamed" | "type-changed";
	kind: EntryKind | undefined;
	baselineKind: EntryKind | undefined;
	previousPath?: string;
}

export interface WorkspaceMutationDiff {
	path: string;
	oldStr: string;
	newStr: string;
	startLine: 1;
}

const HASH_CHUNK_BYTES = 1024 * 1024;
/** Largest before/after pair preview() will diff inline. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_MUTATION_DIFF_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * Hashes in fixed chunks rather than readFileSync: a workspace can hold files
 * larger than the process should hold in memory (build outputs, datasets, media),
 * and past Buffer.kMaxLength readFileSync throws outright.
 */
function hashFile(path: string): string {
	const digest = createHash("sha256");
	const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
	const fd = openSync(path, "r");
	try {
		let read = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
		while (read > 0) {
			digest.update(buffer.subarray(0, read));
			read = readSync(fd, buffer, 0, HASH_CHUNK_BYTES, null);
		}
	} finally {
		closeSync(fd);
	}
	return digest.digest("hex");
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function lineEndingOf(text: string): "\n" | "\r\n" | "\r" {
	const newline = text.search(/[\r\n]/);
	if (newline < 0 || text[newline] === "\n") return "\n";
	return text[newline + 1] === "\n" ? "\r\n" : "\r";
}

function textPatch(path: string, before: string, after: string): string {
	return createTwoFilesPatch(path, path, normalizeLineEndings(before), normalizeLineEndings(after));
}

function commandMutationCandidates(code: string): string[] {
	const paths = new Set<string>();
	const recordMatches = (pattern: RegExp, indexes: readonly number[] = [1]) => {
		for (const match of code.matchAll(pattern)) {
			for (const index of indexes) {
				const path = match[index]?.trim();
				if (path) paths.add(path);
			}
		}
	};
	const pathVars = new Map<string, string>();
	for (const match of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*Path\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*\)/gi)) {
		pathVars.set(match[1], match[2]);
	}
	recordMatches(
		/Path\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*\)\.(?:write_text|write_bytes|touch|mkdir|unlink|rmdir)\s*\(/gi,
	);
	recordMatches(
		/Path\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*\)\.(?:rename|replace)\s*\(\s*(?:[rubf]{0,2})?["']([^"']+)["']/gi,
		[1, 2],
	);
	for (const match of code.matchAll(/\b([A-Za-z_]\w*)\.(?:write_text|write_bytes|touch|mkdir|unlink|rmdir)\s*\(/g)) {
		const path = pathVars.get(match[1]);
		if (path) paths.add(path);
	}
	recordMatches(/\bopen\(\s*(?:[rubf]{0,2})?["']([^"']+)["']\s*,\s*["'][^"']*[wax+][^"']*["']/gi);
	recordMatches(/(?:^|[\s;&|])(?:touch|mkdir|rm)\s+(?:-[^\s]+\s+)*(?:["']([^"']+)["']|([^\s;&|]+))/gm, [1, 2]);
	recordMatches(
		/(?:^|[\s;&|])(?:cp|mv)\s+(?:-[^\s]+\s+)*(?:["'][^"']+["']|[^\s;&|]+)\s+(?:["']([^"']+)["']|([^\s;&|]+))/gm,
		[1, 2],
	);
	recordMatches(/(?:^|[^>])>>?\s*(?:["']([^"']+)["']|([^\s;&|]+))/gm, [1, 2]);
	return [...paths];
}

/** Durable, workspace-wide baseline used by /changes. Symlinks are recorded, never followed. */
export class WorkspaceChangeReview {
	private readonly manifestPath: string;
	private readonly pendingPath: string;
	private readonly objectsDir: string;
	private manifest: Manifest;
	private pending: PendingManifest;

	// artifactDir is always "<agentDataDir>/session-artifacts/<sessionId>" (session-manager.ts,
	// daemon-mode.ts, daemon-supervisor.ts, cron-jobs.ts all build it this way), so two levels up
	// is the agent's whole data directory — sessions, logs, other sessions' own artifact stores.
	// A workspace whose cwd contains that directory (e.g. the user's home folder) must never have
	// it baselined: copying one session's blob store into the next session's blob store compounds
	// without bound.
	private readonly agentDataRoot: string;

	private constructor(
		private readonly cwd: string,
		private readonly artifactDir: string,
		manifest: Manifest,
		pending: PendingManifest,
	) {
		this.manifest = manifest;
		this.pending = pending;
		this.manifestPath = join(artifactDir, "change-review.json");
		this.pendingPath = join(artifactDir, "change-review-pending.json");
		this.objectsDir = join(artifactDir, "change-review-objects");
		const artifactParent = dirname(artifactDir);
		this.agentDataRoot = resolve(
			basename(artifactParent) === "session-artifacts" ? dirname(artifactParent) : artifactDir,
		);
	}

	static openOrCreate(cwd: string, artifactDir: string): WorkspaceChangeReview {
		const manifestPath = join(artifactDir, "change-review.json");
		const pendingPath = join(artifactDir, "change-review-pending.json");
		let pending: PendingManifest = { version: 2, deltas: [] };
		try {
			const parsed = JSON.parse(readFileSync(pendingPath, "utf8")) as PendingManifest;
			if (parsed.version === 2 && Array.isArray(parsed.deltas)) {
				pending = parsed;
			} else if ((parsed as { version?: number }).version === 1) {
				// Version 1 attributed every workspace edit during the turn to this session.
				// Its deltas are unsafe when conversations overlapped, so leave files alone.
			}
		} catch {
			// Older sessions do not have a frozen-delta file yet.
		}
		if (existsSync(manifestPath)) {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
			if (manifest.version === 1 && manifest.entries && typeof manifest.entries === "object") {
				return new WorkspaceChangeReview(resolve(cwd), artifactDir, manifest, pending);
			}
		}
		const review = new WorkspaceChangeReview(resolve(cwd), artifactDir, { version: 1, entries: {} }, pending);
		review.captureBaseline();
		review.savePending();
		return review;
	}

	private captureBaseline(): void {
		this.manifest.entries = this.scanWorkspace(true);
		this.save();
	}

	private scanWorkspace(storeBytes: boolean): Record<string, ManifestEntry> {
		const entries: Record<string, ManifestEntry> = {};
		const ignored = ignore().add([".git/", "node_modules/", ".tmp-agent/"]);
		try {
			ignored.add(readFileSync(join(this.cwd, ".gitignore"), "utf8"));
		} catch {
			// A workspace does not need to be a Git repository.
		}
		const preserveBaseline = (key: string) => {
			const prefix = key ? `${key}/` : "";
			for (const [baselinePath, entry] of Object.entries(this.manifest.entries)) {
				if (baselinePath === key || baselinePath.startsWith(prefix)) entries[baselinePath] = entry;
			}
		};
		const visit = (absolute: string) => {
			let names: string[];
			try {
				names = readdirSync(absolute);
			} catch {
				preserveBaseline(relative(this.cwd, absolute).split(sep).join("/"));
				return;
			}
			for (const name of names) {
				const path = join(absolute, name);
				if (isInside(this.agentDataRoot, resolve(path))) continue;
				const key = relative(this.cwd, path).split(sep).join("/");
				try {
					const stat = lstatSync(path);
					if (ignored.ignores(stat.isDirectory() ? `${key}/` : key)) continue;
					if (stat.isSymbolicLink()) {
						entries[key] = { kind: "symlink", target: readlinkSync(path) };
						continue;
					}
					if (stat.isDirectory()) {
						entries[key] = { kind: "directory" };
						visit(path);
						continue;
					}
					if (!stat.isFile()) continue;
					const baseline = this.manifest.entries[key];
					const unchanged =
						baseline?.kind === "file" &&
						baseline.hash !== undefined &&
						baseline.size === stat.size &&
						baseline.mtimeMs === stat.mtimeMs;
					const digest = unchanged ? baseline.hash! : hashFile(path);
					entries[key] = { kind: "file", hash: digest, size: stat.size, mtimeMs: stat.mtimeMs };
					if (storeBytes) this.storeObject(digest, path);
				} catch {
					preserveBaseline(key);
				}
			}
		};
		visit(this.cwd);
		return entries;
	}

	private storeObject(digest: string, source: string): void {
		mkdirSync(this.objectsDir, { recursive: true });
		const path = join(this.objectsDir, digest);
		if (!existsSync(path)) copyFileSync(source, path);
	}

	private save(): void {
		mkdirSync(this.artifactDir, { recursive: true });
		writeFileSync(this.manifestPath, JSON.stringify(this.manifest), "utf8");
	}

	private savePending(): void {
		mkdirSync(this.artifactDir, { recursive: true });
		writeFileSync(this.pendingPath, JSON.stringify(this.pending), "utf8");
	}

	/** Capture the workspace immediately before an agent run starts. */
	beginTurn(): void {
		this.pending.activeBaseline = this.scanWorkspace(true);
		this.pending.activePaths = [];
		this.savePending();
	}

	beginMutationScope(): void {
		this.pending.activeBaseline = this.scanWorkspace(true);
		this.pending.activePaths = [];
		this.savePending();
	}

	recordMutatedPaths(paths: readonly string[]): void {
		if (!this.pending.activeBaseline) return;
		const owned = new Set(this.pending.activePaths ?? []);
		for (const path of paths) {
			const absolute = resolve(this.cwd, path);
			if (!isInside(this.cwd, absolute)) continue;
			const key = relative(this.cwd, absolute).split(sep).join("/");
			if (!key || key === ".git" || key.startsWith(".git/")) continue;
			owned.add(key);
		}
		this.pending.activePaths = [...owned].sort();
		this.savePending();
	}

	recordCommandMutationCandidates(code: string): void {
		this.recordMutatedPaths(commandMutationCandidates(code));
	}

	private finalizeActiveScope(): WorkspaceDeltaEntry[] {
		const before = this.pending.activeBaseline;
		if (!before) return [];
		const after = this.scanWorkspace(true);
		const owned = new Set(this.pending.activePaths ?? []);
		const entries = this.deltaEntries(before, after).filter((entry) => owned.has(entry.path));
		if (entries.length > 0) this.pending.deltas.push({ entries });
		this.pending.activeBaseline = undefined;
		this.pending.activePaths = undefined;
		this.savePending();
		return entries;
	}

	/** Freeze only the files changed during the active agent run. */
	finalizeTurn(): void {
		this.finalizeActiveScope();
	}

	finalizeMutationScope(paths: readonly string[]): WorkspaceMutationDiff[] {
		this.recordMutatedPaths(paths);
		return this.mutationDiffs(this.finalizeActiveScope());
	}

	private mutationDiffs(entries: readonly WorkspaceDeltaEntry[]): WorkspaceMutationDiff[] {
		const diffs: WorkspaceMutationDiff[] = [];
		let totalBytes = 0;
		for (const entry of entries) {
			if (entry.before && entry.before.kind !== "file") continue;
			if (entry.after && entry.after.kind !== "file") continue;
			const before = entry.before ? this.objectContent(entry.before) : Buffer.alloc(0);
			const after = entry.after ? this.objectContent(entry.after) : Buffer.alloc(0);
			if (!before || !after || before.length > MAX_DIFF_BYTES || after.length > MAX_DIFF_BYTES) continue;
			if (before.includes(0) || after.includes(0)) continue;
			const pairBytes = before.length + after.length;
			if (totalBytes + pairBytes > MAX_MUTATION_DIFF_TOTAL_BYTES) continue;
			totalBytes += pairBytes;
			diffs.push({
				path: entry.path,
				oldStr: normalizeLineEndings(before.toString("utf8")),
				newStr: normalizeLineEndings(after.toString("utf8")),
				startLine: 1,
			});
		}
		return diffs;
	}

	private entriesEqual(left: ManifestEntry | undefined, right: ManifestEntry | undefined): boolean {
		if (!left || !right) return left === right;
		if (left.kind !== right.kind) return false;
		if (left.kind === "file") return left.hash === right.hash;
		if (left.kind === "symlink") return left.target === right.target;
		return true;
	}

	private deltaEntries(
		before: Record<string, ManifestEntry>,
		after: Record<string, ManifestEntry>,
	): WorkspaceDeltaEntry[] {
		const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
		return [...paths]
			.sort()
			.filter((path) => {
				const left = before[path];
				const right = after[path];
				if (left?.kind === "directory" || right?.kind === "directory") return false;
				return !this.entriesEqual(left, right);
			})
			.map((path) => ({ path, before: before[path], after: after[path] }));
	}

	private aggregatePendingEntries(): WorkspaceDeltaEntry[] {
		const aggregate = new Map<string, WorkspaceDeltaEntry>();
		for (const delta of this.pending.deltas) {
			for (const entry of delta.entries) {
				const existing = aggregate.get(entry.path);
				if (existing) existing.after = entry.after;
				else aggregate.set(entry.path, { ...entry });
			}
		}
		return [...aggregate.values()].filter((entry) => !this.entriesEqual(entry.before, entry.after));
	}

	private describeEntries(entries: WorkspaceDeltaEntry[]): WorkspaceChange[] {
		const deletedFilesByHash = new Map<string, string>();
		for (const entry of entries) {
			if (!entry.after && entry.before?.kind === "file" && entry.before.hash) {
				deletedFilesByHash.set(entry.before.hash, entry.path);
			}
		}
		const renamesByPath = new Map<string, string>();
		for (const entry of entries) {
			if (!entry.before && entry.after?.kind === "file" && entry.after.hash) {
				const previousPath = deletedFilesByHash.get(entry.after.hash);
				if (previousPath) renamesByPath.set(entry.path, previousPath);
			}
		}
		const renamedFrom = new Set(renamesByPath.values());
		const changes: WorkspaceChange[] = [];
		for (const entry of entries) {
			const baseline = entry.before;
			const current = entry.after;
			if (!baseline && current?.kind === "file" && renamesByPath.has(entry.path)) {
				changes.push({
					path: entry.path,
					status: "renamed",
					kind: current.kind,
					baselineKind: "file",
					previousPath: renamesByPath.get(entry.path),
				});
			} else if (!baseline) {
				changes.push({ path: entry.path, status: "created", kind: current?.kind, baselineKind: undefined });
			} else if (!current) {
				if (!renamedFrom.has(entry.path)) {
					changes.push({ path: entry.path, status: "deleted", kind: undefined, baselineKind: baseline.kind });
				}
			} else if (baseline.kind !== current.kind) {
				changes.push({
					path: entry.path,
					status: "type-changed",
					kind: current.kind,
					baselineKind: baseline.kind,
				});
			} else {
				changes.push({
					path: entry.path,
					status: "modified",
					kind: current.kind,
					baselineKind: baseline.kind,
				});
			}
		}
		return changes.sort((a, b) => a.path.localeCompare(b.path));
	}

	changes(): WorkspaceChange[] {
		return this.describeEntries(this.aggregatePendingEntries());
	}

	preview(path?: string): string {
		const changes = path
			? this.changes().filter((change) => change.path === this.validatePath(path))
			: this.changes();
		if (changes.length === 0) return "No pending workspace changes.";
		if (path && changes.length === 1) {
			const change = changes[0];
			if (change.status === "modified" && change.kind === "file" && change.baselineKind === "file") {
				const pendingEntry = this.aggregatePendingEntries().find((entry) => entry.path === change.path);
				const baseline = pendingEntry?.before ?? this.manifest.entries[change.path];
				const current = pendingEntry?.after;
				const afterPath = current?.hash ? join(this.objectsDir, current.hash) : resolve(this.cwd, change.path);
				// Both sides land in memory twice over (Buffer, then string) before diff
				// walks them line by line, so an unbounded read here is the same trap as
				// hashing by readFileSync. Oversized files fall through to the status line.
				if (baseline?.hash && this.diffableSize(join(this.objectsDir, baseline.hash), afterPath)) {
					const before = readFileSync(join(this.objectsDir, baseline.hash));
					const after = readFileSync(afterPath);
					if (!before.includes(0) && !after.includes(0)) {
						return textPatch(change.path, before.toString("utf8"), after.toString("utf8"));
					}
				}
			}
		}
		return changes
			.map(
				(change) =>
					`${change.status}\t${change.path}${change.previousPath ? ` (from ${change.previousPath})` : ""}${change.kind ? ` (${change.kind})` : ""}`,
			)
			.join("\n");
	}

	private diffableSize(...paths: string[]): boolean {
		try {
			return paths.every((path) => lstatSync(path).size <= MAX_DIFF_BYTES);
		} catch {
			return false;
		}
	}

	private clearPendingPaths(paths: Set<string>): void {
		this.pending.deltas = this.pending.deltas
			.map((delta) => ({ entries: delta.entries.filter((entry) => !paths.has(entry.path)) }))
			.filter((delta) => delta.entries.length > 0);
		this.savePending();
	}

	private pendingPathsFor(path: string): Set<string> {
		const change = this.changes().find((candidate) => candidate.path === path);
		return new Set([path, ...(change?.previousPath ? [change.previousPath] : [])]);
	}

	private objectContent(entry: ManifestEntry | undefined): Buffer | undefined {
		if (entry?.kind !== "file" || !entry.hash) return undefined;
		try {
			return readFileSync(join(this.objectsDir, entry.hash));
		} catch {
			return undefined;
		}
	}

	private stateContent(path: string, state: PlannedPathState): Buffer | undefined {
		if (state.content) return state.content;
		if (state.entry?.kind !== "file") return undefined;
		const object = this.objectContent(state.entry);
		if (object) return object;
		try {
			return readFileSync(resolve(this.cwd, path));
		} catch {
			return undefined;
		}
	}

	private reverseEntry(path: string, current: PlannedPathState, delta: WorkspaceDeltaEntry): PlannedPathState {
		if (this.entriesEqual(current.entry, delta.before)) return current;
		if (this.entriesEqual(current.entry, delta.after)) return { entry: delta.before };
		if (delta.after?.kind === "file" && current.entry?.kind === "file") {
			const currentContent = this.stateContent(path, current);
			const afterContent = this.objectContent(delta.after);
			const beforeContent = delta.before ? this.objectContent(delta.before) : Buffer.alloc(0);
			if (
				!currentContent ||
				!afterContent ||
				!beforeContent ||
				currentContent.length > MAX_DIFF_BYTES ||
				afterContent.length > MAX_DIFF_BYTES ||
				beforeContent.length > MAX_DIFF_BYTES ||
				currentContent.includes(0) ||
				afterContent.includes(0) ||
				beforeContent.includes(0)
			) {
				throw new Error(`Later edits conflict with ${path}`);
			}
			const currentText = currentContent.toString("utf8");
			const reversePatch = textPatch(path, afterContent.toString("utf8"), beforeContent.toString("utf8"));
			const merged = applyPatch(normalizeLineEndings(currentText), reversePatch);
			if (merged === false) throw new Error(`Later edits conflict with ${path}`);
			if (!delta.before && merged.length === 0) return {};
			const newline = lineEndingOf(currentText);
			const content = Buffer.from(newline === "\n" ? merged : merged.replaceAll("\n", newline), "utf8");
			return {
				entry: {
					kind: "file",
					hash: createHash("sha256").update(content).digest("hex"),
					size: content.length,
				},
				content,
			};
		}
		throw new Error(`Later edits conflict with ${path}`);
	}

	private rejectPending(paths?: Set<string>): void {
		const live = this.scanWorkspace(false);
		const planned = new Map<string, PlannedPathState>();
		const touched = new Set<string>();
		const deltas = [...this.pending.deltas].reverse();
		for (const delta of deltas) {
			for (const entry of [...delta.entries].reverse()) {
				if (paths && !paths.has(entry.path)) continue;
				const current = planned.get(entry.path) ?? { entry: live[entry.path] };
				planned.set(entry.path, this.reverseEntry(entry.path, current, entry));
				touched.add(entry.path);
			}
		}

		for (const path of [...touched].sort((a, b) => b.length - a.length)) {
			const target = planned.get(path);
			if (!target?.entry) this.removePath(path);
		}
		for (const path of [...touched].sort((a, b) => a.length - b.length)) {
			const target = planned.get(path);
			if (!target?.entry) continue;
			this.removePath(path);
			if (target.content) {
				const absolute = resolve(this.cwd, path);
				mkdirSync(dirname(absolute), { recursive: true });
				writeFileSync(absolute, target.content);
			} else {
				this.restorePath(path, target.entry);
			}
		}
		if (paths) this.clearPendingPaths(paths);
		else {
			this.pending.deltas = [];
			this.savePending();
		}
		this.manifest.entries = this.scanWorkspace(true);
		this.save();
	}

	accept(path: string): void {
		const key = this.validatePath(path);
		this.clearPendingPaths(this.pendingPathsFor(key));
		this.pruneFinalizedObjects();
	}

	acceptAll(): void {
		this.pending.deltas = [];
		this.savePending();
		this.manifest.entries = this.scanWorkspace(true);
		this.save();
		this.pruneFinalizedObjects();
	}

	reject(path: string): void {
		const key = this.validatePath(path);
		this.rejectPending(this.pendingPathsFor(key));
		this.pruneFinalizedObjects();
	}

	rejectAll(): void {
		this.rejectPending();
		this.pruneFinalizedObjects();
	}

	private pruneFinalizedObjects(): void {
		if (this.changes().length > 0 || !existsSync(this.objectsDir)) return;
		const retained = new Set(
			Object.values(this.manifest.entries).flatMap((entry) =>
				entry.kind === "file" && entry.hash ? [entry.hash] : [],
			),
		);
		for (const name of readdirSync(this.objectsDir)) {
			if (!retained.has(name)) unlinkSync(join(this.objectsDir, name));
		}
	}

	private validatePath(path: string): string {
		const key = path.replaceAll("\\", "/").replace(/^\.\//, "");
		if (!key || key === ".git" || key.startsWith(".git/") || !isInside(this.cwd, resolve(this.cwd, key))) {
			throw new Error("Path must be a workspace path outside .git");
		}
		return key;
	}

	private removePath(key: string): void {
		const path = resolve(this.cwd, key);
		if (!isInside(this.cwd, path) || !existsSync(path)) return;
		const stat = lstatSync(path);
		if (stat.isDirectory() && !stat.isSymbolicLink()) rmSync(path, { recursive: true, force: true });
		else unlinkSync(path);
	}

	private restorePath(key: string, entry: ManifestEntry): void {
		const path = resolve(this.cwd, key);
		mkdirSync(dirname(path), { recursive: true });
		if (entry.kind === "directory") {
			mkdirSync(path, { recursive: true });
			return;
		}
		if (entry.kind === "symlink") {
			symlinkSync(entry.target ?? "", path);
			return;
		}
		if (!entry.hash) throw new Error(`Missing snapshot content for ${key}`);
		writeFileSync(path, readFileSync(join(this.objectsDir, entry.hash)));
	}
}

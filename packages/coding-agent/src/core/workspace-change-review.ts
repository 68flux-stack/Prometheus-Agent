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
import { dirname, join, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
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

export interface WorkspaceChange {
	path: string;
	status: "created" | "deleted" | "modified" | "renamed" | "type-changed";
	kind: EntryKind | undefined;
	baselineKind: EntryKind | undefined;
	previousPath?: string;
}

const HASH_CHUNK_BYTES = 1024 * 1024;
/** Largest before/after pair preview() will diff inline. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

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

/** Durable, workspace-wide baseline used by /changes. Symlinks are recorded, never followed. */
export class WorkspaceChangeReview {
	private readonly manifestPath: string;
	private readonly objectsDir: string;
	private manifest: Manifest;

	private constructor(
		private readonly cwd: string,
		private readonly artifactDir: string,
		manifest: Manifest,
	) {
		this.manifest = manifest;
		this.manifestPath = join(artifactDir, "change-review.json");
		this.objectsDir = join(artifactDir, "change-review-objects");
	}

	static openOrCreate(cwd: string, artifactDir: string): WorkspaceChangeReview {
		const manifestPath = join(artifactDir, "change-review.json");
		if (existsSync(manifestPath)) {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
			if (manifest.version === 1 && manifest.entries && typeof manifest.entries === "object") {
				return new WorkspaceChangeReview(resolve(cwd), artifactDir, manifest);
			}
		}
		const review = new WorkspaceChangeReview(resolve(cwd), artifactDir, { version: 1, entries: {} });
		review.captureBaseline();
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
				if (resolve(path) === resolve(this.artifactDir)) continue;
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

	changes(): WorkspaceChange[] {
		const live = this.scanWorkspace(false);
		const paths = new Set([...Object.keys(this.manifest.entries), ...Object.keys(live)]);
		const deletedFilesByHash = new Map<string, string>();
		for (const [path, entry] of Object.entries(this.manifest.entries)) {
			if (!live[path] && entry.kind === "file" && entry.hash) deletedFilesByHash.set(entry.hash, path);
		}
		const renamesByPath = new Map<string, string>();
		for (const [path, entry] of Object.entries(live)) {
			if (!this.manifest.entries[path] && entry.kind === "file" && entry.hash) {
				const previousPath = deletedFilesByHash.get(entry.hash);
				if (previousPath) renamesByPath.set(path, previousPath);
			}
		}
		const renamedFrom = new Set(renamesByPath.values());
		const changes: WorkspaceChange[] = [];
		for (const path of [...paths].sort()) {
			const baseline = this.manifest.entries[path];
			const current = live[path];
			if (!baseline && current?.kind === "file" && renamesByPath.has(path)) {
				changes.push({
					path,
					status: "renamed",
					kind: current.kind,
					baselineKind: "file",
					previousPath: renamesByPath.get(path),
				});
			} else if (!baseline) changes.push({ path, status: "created", kind: current?.kind, baselineKind: undefined });
			else if (!current) {
				if (!renamedFrom.has(path))
					changes.push({ path, status: "deleted", kind: undefined, baselineKind: baseline.kind });
			} else if (baseline.kind !== current.kind)
				changes.push({ path, status: "type-changed", kind: current.kind, baselineKind: baseline.kind });
			else if (baseline.kind === "file" && baseline.hash !== current.hash)
				changes.push({ path, status: "modified", kind: current.kind, baselineKind: baseline.kind });
			else if (baseline.kind === "symlink" && baseline.target !== current.target)
				changes.push({ path, status: "modified", kind: current.kind, baselineKind: baseline.kind });
		}
		return changes;
	}

	preview(path?: string): string {
		const changes = path
			? this.changes().filter((change) => change.path === this.validatePath(path))
			: this.changes();
		if (changes.length === 0) return "No pending workspace changes.";
		if (path && changes.length === 1) {
			const change = changes[0];
			if (change.status === "modified" && change.kind === "file" && change.baselineKind === "file") {
				const baseline = this.manifest.entries[change.path];
				// Both sides land in memory twice over (Buffer, then string) before diff
				// walks them line by line, so an unbounded read here is the same trap as
				// hashing by readFileSync. Oversized files fall through to the status line.
				if (
					baseline?.hash &&
					this.diffableSize(join(this.objectsDir, baseline.hash), resolve(this.cwd, change.path))
				) {
					const before = readFileSync(join(this.objectsDir, baseline.hash));
					const after = readFileSync(resolve(this.cwd, change.path));
					if (!before.includes(0) && !after.includes(0)) {
						return createTwoFilesPatch(change.path, change.path, before.toString("utf8"), after.toString("utf8"));
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

	accept(path: string): void {
		const key = this.validatePath(path);
		const change = this.changes().find((candidate) => candidate.path === key);
		const live = this.scanWorkspace(true);
		if (live[key]) this.manifest.entries[key] = live[key];
		else delete this.manifest.entries[key];
		if (change?.status === "renamed" && change.previousPath) delete this.manifest.entries[change.previousPath];
		this.save();
		this.pruneFinalizedObjects();
	}

	acceptAll(): void {
		this.manifest.entries = this.scanWorkspace(true);
		this.save();
		this.pruneFinalizedObjects();
	}

	reject(path: string): void {
		const key = this.validatePath(path);
		const change = this.changes().find((candidate) => candidate.path === key);
		this.removePath(key);
		const entry = this.manifest.entries[key];
		if (entry) this.restorePath(key, entry);
		if (change?.status === "renamed" && change.previousPath) {
			const previous = this.manifest.entries[change.previousPath];
			if (previous) this.restorePath(change.previousPath, previous);
		}
		this.pruneFinalizedObjects();
	}

	rejectAll(): void {
		for (const key of Object.keys(this.scanWorkspace(false)).sort((a, b) => b.length - a.length))
			this.removePath(key);
		for (const [key, entry] of Object.entries(this.manifest.entries).sort(([a], [b]) => a.length - b.length)) {
			this.restorePath(key, entry);
		}
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

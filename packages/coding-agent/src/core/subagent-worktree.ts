import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type RlmSubagentIsolation = "none" | "worktree";

export interface SubagentWorktree {
	id: string;
	repoRoot: string;
	parentCwd: string;
	worktreeRoot: string;
	worktreeCwd: string;
	baseCommit: string;
	patchPath: string;
	state: "active" | "changed" | "clean" | "applied" | "discarded";
}

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return {
		status: result.status ?? 1,
		stdout: typeof result.stdout === "string" ? result.stdout : "",
		stderr: typeof result.stderr === "string" ? result.stderr : "",
	};
}

function requireGit(cwd: string, args: string[], operation: string): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		throw new Error(`${operation} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown git error"}`);
	}
	return result.stdout.trim();
}

function isWithin(root: string, candidate: string): boolean {
	const child = relative(resolve(root), resolve(candidate));
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

export class SubagentWorktreeManager {
	private readonly root: string;
	private readonly entries = new Map<string, SubagentWorktree>();

	constructor(artifactDir: string) {
		this.root = resolve(artifactDir, "isolated-worktrees");
		mkdirSync(this.root, { recursive: true });
	}

	create(id: string, parentCwd: string): SubagentWorktree {
		if (this.entries.has(id)) throw new Error(`Subagent worktree already exists for ${id}`);
		const repoRoot = requireGit(parentCwd, ["rev-parse", "--show-toplevel"], "Resolving Git repository");
		const dirty = requireGit(repoRoot, ["status", "--porcelain", "--untracked-files=normal"], "Checking workspace");
		if (dirty) {
			throw new Error(
				"Worktree isolation requires a clean Git workspace so the child cannot silently miss uncommitted parent changes",
			);
		}
		const baseCommit = requireGit(repoRoot, ["rev-parse", "HEAD"], "Resolving worktree base");
		const relativeCwd = relative(repoRoot, resolve(parentCwd));
		if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
			throw new Error("Subagent cwd must be inside the Git repository");
		}
		const worktreeRoot = join(this.root, `${id}-${randomUUID().slice(0, 8)}`);
		requireGit(repoRoot, ["worktree", "add", "--detach", worktreeRoot, baseCommit], "Creating subagent worktree");
		const worktreeCwd = resolve(worktreeRoot, relativeCwd);
		if (!existsSync(worktreeCwd)) {
			this.removeWorktree(repoRoot, worktreeRoot);
			throw new Error(`Subagent cwd does not exist in isolated worktree: ${relativeCwd}`);
		}
		const entry: SubagentWorktree = {
			id,
			repoRoot,
			parentCwd: resolve(parentCwd),
			worktreeRoot,
			worktreeCwd,
			baseCommit,
			patchPath: join(this.root, `${id}.patch`),
			state: "active",
		};
		this.entries.set(id, entry);
		this.persist(entry);
		return { ...entry };
	}

	finalize(id: string): SubagentWorktree {
		const entry = this.require(id);
		if (entry.state !== "active") return { ...entry };
		// Intent-to-add makes untracked files appear in the binary diff without committing them.
		requireGit(entry.worktreeRoot, ["add", "-N", "--all"], "Preparing isolated changes");
		const diff = runGit(entry.worktreeRoot, ["diff", "--binary", "--full-index", entry.baseCommit, "--"]);
		if (diff.status !== 0) {
			throw new Error(`Capturing isolated changes failed: ${diff.stderr.trim() || "unknown git error"}`);
		}
		const patch = diff.stdout;
		if (!patch) {
			entry.state = "clean";
			writeFileSync(entry.patchPath, "", "utf8");
			this.cleanup(entry);
		} else {
			entry.state = "changed";
			writeFileSync(entry.patchPath, patch, "utf8");
			this.persist(entry);
		}
		return { ...entry };
	}

	get(id: string): SubagentWorktree | undefined {
		const entry = this.entries.get(id);
		return entry ? { ...entry } : undefined;
	}

	list(): SubagentWorktree[] {
		return [...this.entries.values()].map((entry) => ({ ...entry }));
	}

	apply(id: string): SubagentWorktree {
		const entry = this.require(id);
		if (entry.state !== "changed") throw new Error(`Subagent ${id} has no retained patch to apply`);
		const patch = readFileSync(entry.patchPath, "utf8");
		if (!patch) throw new Error(`Subagent ${id} patch is empty`);
		requireGit(entry.repoRoot, ["apply", "--check", "--binary", entry.patchPath], "Checking isolated patch");
		requireGit(entry.repoRoot, ["apply", "--binary", entry.patchPath], "Applying isolated patch");
		entry.state = "applied";
		this.persist(entry);
		this.cleanup(entry);
		return { ...entry };
	}

	discard(id: string): SubagentWorktree {
		const entry = this.require(id);
		if (entry.state === "applied" || entry.state === "discarded") return { ...entry };
		entry.state = "discarded";
		this.persist(entry);
		this.cleanup(entry);
		return { ...entry };
	}

	disposeActive(): void {
		for (const entry of this.entries.values()) {
			if (entry.state === "active") this.discard(entry.id);
		}
	}

	private require(id: string): SubagentWorktree {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`No isolated worktree exists for subagent ${id}`);
		return entry;
	}

	private persist(entry: SubagentWorktree): void {
		writeFileSync(join(this.root, `${entry.id}.json`), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
	}

	private cleanup(entry: SubagentWorktree): void {
		this.removeWorktree(entry.repoRoot, entry.worktreeRoot);
	}

	private removeWorktree(repoRoot: string, worktreeRoot: string): void {
		if (!isWithin(this.root, worktreeRoot))
			throw new Error("Refusing to remove worktree outside the session artifact root");
		const removed = runGit(repoRoot, ["worktree", "remove", "--force", worktreeRoot]);
		if (removed.status !== 0 && existsSync(worktreeRoot)) {
			rmSync(worktreeRoot, { recursive: true, force: true });
			runGit(repoRoot, ["worktree", "prune"]);
		}
	}
}

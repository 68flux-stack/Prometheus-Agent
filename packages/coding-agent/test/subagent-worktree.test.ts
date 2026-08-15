import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SubagentWorktreeManager } from "../src/core/subagent-worktree.js";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function repository(): { repo: string; artifacts: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-worktree-test-"));
	const repo = join(root, "repo");
	const artifacts = join(root, "artifacts");
	mkdirSync(repo);
	mkdirSync(artifacts);
	git(repo, "init");
	git(repo, "config", "user.name", "Prometheus Test");
	git(repo, "config", "user.email", "prometheus@example.invalid");
	writeFileSync(join(repo, "file.txt"), "before\n");
	git(repo, "add", "file.txt");
	git(repo, "commit", "-m", "initial");
	return { repo, artifacts };
}

describe("SubagentWorktreeManager", () => {
	it("captures isolated changes and applies them only after an explicit request", () => {
		const { repo, artifacts } = repository();
		const manager = new SubagentWorktreeManager(artifacts);
		const isolated = manager.create("sub-test", repo);
		writeFileSync(join(isolated.worktreeRoot, "file.txt"), "after\n");

		const finalized = manager.finalize("sub-test");
		expect(finalized.state).toBe("changed");
		expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("before\n");
		expect(readFileSync(finalized.patchPath, "utf8")).toContain("+after");

		const applied = manager.apply("sub-test");
		expect(applied.state).toBe("applied");
		expect(readFileSync(join(repo, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("after\n");
	});

	it("rejects a dirty parent workspace", () => {
		const { repo, artifacts } = repository();
		writeFileSync(join(repo, "file.txt"), "dirty\n");
		const manager = new SubagentWorktreeManager(artifacts);
		expect(() => manager.create("sub-dirty", repo)).toThrow(/requires a clean Git workspace/);
	});

	it("removes an unchanged worktree", () => {
		const { repo, artifacts } = repository();
		const manager = new SubagentWorktreeManager(artifacts);
		manager.create("sub-clean", repo);
		expect(manager.finalize("sub-clean").state).toBe("clean");
		expect(git(repo, "worktree", "list")).not.toContain("sub-clean");
	});
});

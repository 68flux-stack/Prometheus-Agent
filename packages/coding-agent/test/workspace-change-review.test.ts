import { access, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceChangeReview } from "../src/core/workspace-change-review.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-change-review-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("WorkspaceChangeReview", () => {
	it("reuses the baseline hash while size and mtime are unchanged, and rehashes when they move", async () => {
		const cwd = await createTempDir();
		const artifacts = join(cwd, ".artifacts");
		const file = join(cwd, "note.txt");
		const pinned = new Date(1_700_000_000_000);
		await writeFile(file, "aaa\n");
		await utimes(file, pinned, pinned);
		const review = WorkspaceChangeReview.openOrCreate(cwd, artifacts);

		// Same size, content swapped, stat identity restored: the scan must not have
		// re-read the bytes, so this edit is invisible (the documented index race).
		await writeFile(file, "bbb\n");
		await utimes(file, pinned, pinned);
		expect(review.changes()).toEqual([]);

		// A real edit moves mtime, so the hash is recomputed and the change surfaces.
		review.beginTurn();
		await writeFile(file, "cccc\n");
		review.recordMutatedPaths([file]);
		review.finalizeTurn();
		expect(review.changes()).toEqual([{ path: "note.txt", status: "modified", kind: "file", baselineKind: "file" }]);
	});

	it("accumulates repeated edits and resets a file baseline after accept", async () => {
		const cwd = await createTempDir();
		const artifacts = join(cwd, ".artifacts");
		const file = join(cwd, "note.txt");
		await writeFile(file, "one\n");
		const review = WorkspaceChangeReview.openOrCreate(cwd, artifacts);

		review.beginTurn();
		await writeFile(file, "two\n");
		await writeFile(file, "three\n");
		review.recordMutatedPaths([file]);
		review.finalizeTurn();
		expect(review.preview("note.txt")).toContain("-one");
		expect(review.preview("note.txt")).toContain("+three");
		expect(review.changes()).toEqual([{ path: "note.txt", status: "modified", kind: "file", baselineKind: "file" }]);

		review.accept("note.txt");
		expect(review.changes()).toEqual([]);
		review.beginTurn();
		await writeFile(file, "four\n");
		review.recordMutatedPaths([file]);
		review.finalizeTurn();
		expect(review.changes()).toHaveLength(1);
		review.reject("note.txt");
		expect(await readFile(file, "utf8")).toBe("three\n");
	});

	it("rejects only the frozen agent delta and preserves changes made afterward", async () => {
		const cwd = await createTempDir();
		const artifacts = join(cwd, ".artifacts");
		const owned = join(cwd, "owned.txt");
		const later = join(cwd, "later.txt");
		await writeFile(owned, "before\n");
		await writeFile(later, "original\n");
		const review = WorkspaceChangeReview.openOrCreate(cwd, artifacts);

		review.beginTurn();
		await writeFile(owned, "changed by this agent\n");
		review.recordMutatedPaths([owned]);
		review.finalizeTurn();
		await writeFile(later, "changed by another agent\n");

		expect(review.changes()).toEqual([{ path: "owned.txt", status: "modified", kind: "file", baselineKind: "file" }]);
		review.rejectAll();
		expect(await readFile(owned, "utf8")).toBe("before\n");
		expect(await readFile(later, "utf8")).toBe("changed by another agent\n");
	});

	it("keeps an accepted review empty after reopening while other conversations edit the workspace", async () => {
		const cwd = await createTempDir();
		const artifacts = join(cwd, ".artifacts");
		const owned = join(cwd, "owned.txt");
		const later = join(cwd, "later.txt");
		await writeFile(owned, "before\n");
		await writeFile(later, "original\n");
		const review = WorkspaceChangeReview.openOrCreate(cwd, artifacts);

		review.beginTurn();
		await writeFile(owned, "accepted\n");
		review.recordMutatedPaths([owned]);
		review.finalizeTurn();
		review.acceptAll();
		await writeFile(later, "changed by another conversation\n");

		const reopened = WorkspaceChangeReview.openOrCreate(cwd, artifacts);
		expect(reopened.changes()).toEqual([]);
		reopened.rejectAll();
		expect(await readFile(owned, "utf8")).toBe("accepted\n");
		expect(await readFile(later, "utf8")).toBe("changed by another conversation\n");
	});

	it("keeps a conversation with no turns empty while another conversation edits the workspace", async () => {
		const cwd = await createTempDir();
		const file = join(cwd, "fifty-lines.txt");
		await writeFile(file, "before\n");
		const emptyArtifacts = join(cwd, ".empty-artifacts");
		WorkspaceChangeReview.openOrCreate(cwd, emptyArtifacts);

		await writeFile(file, `${Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);

		const reopened = WorkspaceChangeReview.openOrCreate(cwd, emptyArtifacts);
		expect(reopened.changes()).toEqual([]);
		reopened.rejectAll();
		expect(await readFile(file, "utf8")).toContain("line 50\n");
	});

	it("keeps concurrent conversations scoped to the paths each one mutated", async () => {
		const cwd = await createTempDir();
		const firstFile = join(cwd, "first.txt");
		const secondFile = join(cwd, "second.txt");
		await writeFile(firstFile, "first before\n");
		await writeFile(secondFile, "second before\n");
		const first = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".first-artifacts"));
		const second = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".second-artifacts"));

		first.beginTurn();
		second.beginTurn();
		await writeFile(firstFile, "first changed\n");
		first.recordMutatedPaths([firstFile]);
		await writeFile(secondFile, "second changed\n");
		second.recordMutatedPaths([secondFile]);
		first.finalizeTurn();
		second.finalizeTurn();

		expect(first.changes().map((change) => change.path)).toEqual(["first.txt"]);
		expect(second.changes().map((change) => change.path)).toEqual(["second.txt"]);
		first.rejectAll();
		expect(await readFile(firstFile, "utf8")).toBe("first before\n");
		expect(await readFile(secondFile, "utf8")).toBe("second changed\n");
	});

	it("attributes a subprocess write without claiming a concurrent conversation's file", async () => {
		const cwd = await createTempDir();
		const firstFile = join(cwd, "test.md");
		const secondFile = join(cwd, "test1.md");
		const first = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".first-artifacts"));
		const second = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".second-artifacts"));
		first.beginTurn();
		second.beginTurn();

		first.beginMutationScope();
		first.recordCommandMutationCandidates(
			"%%bash\nsleep 15\npython - <<'PY'\nfrom pathlib import Path\nPath('test.md').write_text('a\\n')\nPY",
		);
		second.beginMutationScope();
		await writeFile(secondFile, "second conversation\n");
		second.finalizeMutationScope([secondFile]);
		await writeFile(firstFile, "first conversation\n");
		first.finalizeMutationScope([]);

		expect(first.changes().map((change) => change.path)).toEqual(["test.md"]);
		expect(second.changes().map((change) => change.path)).toEqual(["test1.md"]);
	});

	it("uses each tool boundary when concurrent conversations edit the same file", async () => {
		const cwd = await createTempDir();
		const file = join(cwd, "shared.txt");
		const original = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		await writeFile(file, original);
		const first = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".first-artifacts"));
		const second = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".second-artifacts"));
		first.beginTurn();
		second.beginTurn();

		first.beginMutationScope();
		await writeFile(file, original.replace("line 3", "line 3 from first"));
		first.finalizeMutationScope([file]);
		second.beginMutationScope();
		await writeFile(file, original.replace("line 3", "line 3 from first").replace("line 18", "line 18 from second"));
		second.finalizeMutationScope([file]);

		second.rejectAll();
		expect(await readFile(file, "utf8")).toBe(original.replace("line 3", "line 3 from first"));
	});

	it("ignores legacy deltas that cannot prove which conversation owned them", async () => {
		const cwd = await createTempDir();
		const artifacts = join(cwd, ".artifacts");
		const file = join(cwd, "other-agent.txt");
		await writeFile(file, "before\n");
		WorkspaceChangeReview.openOrCreate(cwd, artifacts);
		await writeFile(
			join(artifacts, "change-review-pending.json"),
			JSON.stringify({
				version: 1,
				deltas: [{ entries: [{ path: "other-agent.txt", before: { kind: "file" }, after: { kind: "file" } }] }],
			}),
		);
		await writeFile(file, "changed elsewhere\n");

		const reopened = WorkspaceChangeReview.openOrCreate(cwd, artifacts);
		expect(reopened.changes()).toEqual([]);
		reopened.rejectAll();
		expect(await readFile(file, "utf8")).toBe("changed elsewhere\n");
	});

	it("reverses its own hunk while preserving a later non-overlapping edit to the same file", async () => {
		const cwd = await createTempDir();
		const file = join(cwd, "shared.txt");
		const before = `${Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		await writeFile(file, before);
		const review = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".artifacts"));

		review.beginTurn();
		await writeFile(file, before.replace("line 3", "line 3 changed by this agent"));
		review.recordMutatedPaths([file]);
		review.finalizeTurn();
		await writeFile(
			file,
			before.replace("line 3", "line 3 changed by this agent").replace("line 18", "line 18 changed later"),
		);

		review.rejectAll();
		expect(await readFile(file, "utf8")).toBe(before.replace("line 18", "line 18 changed later"));
	});

	it("refuses to overwrite a later conflicting edit to the same hunk", async () => {
		const cwd = await createTempDir();
		const file = join(cwd, "shared.txt");
		await writeFile(file, "before\n");
		const review = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".artifacts"));

		review.beginTurn();
		await writeFile(file, "changed by this agent\n");
		review.recordMutatedPaths([file]);
		review.finalizeTurn();
		await writeFile(file, "changed later by another agent\n");

		expect(() => review.rejectAll()).toThrow("Later edits conflict with shared.txt");
		expect(await readFile(file, "utf8")).toBe("changed later by another agent\n");
	});

	it("ignores line-ending normalization when previewing and reversing a turn", async () => {
		const cwd = await createTempDir();
		const file = join(cwd, "memory.md");
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
		await writeFile(file, `${lines.join("\r\n")}\r\n`);
		const review = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".artifacts"));

		review.beginTurn();
		await writeFile(file, `${lines.slice(0, -5).join("\n")}\n`);
		review.recordMutatedPaths([file]);
		review.finalizeTurn();
		const preview = review.preview("memory.md");
		expect(preview.match(/^-line /gm)).toHaveLength(5);
		expect(preview.match(/^\+line /gm)).toBeNull();

		await writeFile(file, `${["line 1 changed later", ...lines.slice(1, -5)].join("\n")}\n`);
		review.rejectAll();
		expect(await readFile(file, "utf8")).toBe(`${["line 1 changed later", ...lines.slice(1)].join("\n")}\n`);
	});

	it("renders a file rename as metadata and restores the original name", async () => {
		const cwd = await createTempDir();
		const file = join(cwd, "before.txt");
		await writeFile(file, "content");
		const review = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".artifacts"));
		const after = join(cwd, "after.txt");
		review.beginTurn();
		await rename(file, after);
		review.recordMutatedPaths([file, after]);
		review.finalizeTurn();

		expect(review.changes()).toEqual([
			{
				path: "after.txt",
				status: "renamed",
				kind: "file",
				baselineKind: "file",
				previousPath: "before.txt",
			},
		]);
		review.rejectAll();
		expect(await readFile(file, "utf8")).toBe("content");
		await expect(access(join(cwd, "after.txt"))).rejects.toThrow();
	});

	it("restores binary, created, deleted, nested, and symlink entries without touching .git", async () => {
		const cwd = await createTempDir();
		const artifacts = join(cwd, ".artifacts");
		const binary = join(cwd, "asset.bin");
		const nested = join(cwd, "nested", "saved.txt");
		const gitFile = join(cwd, ".git", "config");
		await writeFile(binary, Buffer.from([0, 1, 2, 255]));
		await mkdir(join(cwd, "nested"));
		await mkdir(join(cwd, ".git"));
		await writeFile(nested, "saved");
		await writeFile(gitFile, "untouched");
		let hasSymlink = true;
		try {
			await symlink("asset.bin", join(cwd, "asset-link"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			hasSymlink = false;
		}
		const review = WorkspaceChangeReview.openOrCreate(cwd, artifacts);

		review.beginTurn();
		await writeFile(binary, Buffer.from([9, 8, 7]));
		await rm(nested);
		const created = join(cwd, "nested", "created.txt");
		await writeFile(created, "created");
		await writeFile(gitFile, "changed by git");
		review.recordMutatedPaths([binary, nested, created, gitFile]);
		review.finalizeTurn();
		review.rejectAll();

		expect(await readFile(binary)).toEqual(Buffer.from([0, 1, 2, 255]));
		expect(await readFile(nested, "utf8")).toBe("saved");
		await expect(access(join(cwd, "nested", "created.txt"))).rejects.toThrow();
		expect(await readFile(gitFile, "utf8")).toBe("changed by git");
		if (hasSymlink) await expect(access(join(cwd, "asset-link"))).resolves.toBeUndefined();
	});

	it("excludes ignored dependencies and desktop runtime data", async () => {
		const cwd = await createTempDir();
		await mkdir(join(cwd, "node_modules", "package"), { recursive: true });
		await mkdir(join(cwd, ".tmp-agent", "cache"), { recursive: true });
		await mkdir(join(cwd, "generated"), { recursive: true });
		await writeFile(join(cwd, ".gitignore"), "generated/\n");
		await writeFile(join(cwd, "node_modules", "package", "index.js"), "baseline");
		await writeFile(join(cwd, ".tmp-agent", "cache", "LOCK"), "baseline");
		await writeFile(join(cwd, "generated", "output.js"), "baseline");
		const review = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".artifacts"));

		const dependency = join(cwd, "node_modules", "package", "index.js");
		const runtime = join(cwd, ".tmp-agent", "cache", "LOCK");
		const generated = join(cwd, "generated", "output.js");
		review.beginTurn();
		await writeFile(dependency, "changed");
		await writeFile(runtime, "changed");
		await writeFile(generated, "changed");
		review.recordMutatedPaths([dependency, runtime, generated]);
		review.finalizeTurn();
		expect(review.changes()).toEqual([]);
	});
});

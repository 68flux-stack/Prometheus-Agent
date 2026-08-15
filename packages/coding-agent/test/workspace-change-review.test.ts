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
		await writeFile(file, "cccc\n");
		expect(review.changes()).toEqual([{ path: "note.txt", status: "modified", kind: "file", baselineKind: "file" }]);
	});

	it("accumulates repeated edits and resets a file baseline after accept", async () => {
		const cwd = await createTempDir();
		const artifacts = join(cwd, ".artifacts");
		const file = join(cwd, "note.txt");
		await writeFile(file, "one\n");
		const review = WorkspaceChangeReview.openOrCreate(cwd, artifacts);

		await writeFile(file, "two\n");
		await writeFile(file, "three\n");
		expect(review.preview("note.txt")).toContain("-one");
		expect(review.preview("note.txt")).toContain("+three");
		expect(review.changes()).toEqual([{ path: "note.txt", status: "modified", kind: "file", baselineKind: "file" }]);

		review.accept("note.txt");
		expect(review.changes()).toEqual([]);
		await writeFile(file, "four\n");
		expect(review.changes()).toHaveLength(1);
		review.reject("note.txt");
		expect(await readFile(file, "utf8")).toBe("three\n");
	});

	it("renders a file rename as metadata and restores the original name", async () => {
		const cwd = await createTempDir();
		const file = join(cwd, "before.txt");
		await writeFile(file, "content");
		const review = WorkspaceChangeReview.openOrCreate(cwd, join(cwd, ".artifacts"));
		await rename(file, join(cwd, "after.txt"));

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

		await writeFile(binary, Buffer.from([9, 8, 7]));
		await rm(nested);
		await writeFile(join(cwd, "nested", "created.txt"), "created");
		await writeFile(gitFile, "changed by git");
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

		await writeFile(join(cwd, "node_modules", "package", "index.js"), "changed");
		await writeFile(join(cwd, ".tmp-agent", "cache", "LOCK"), "changed");
		await writeFile(join(cwd, "generated", "output.js"), "changed");
		expect(review.changes()).toEqual([]);
	});
});

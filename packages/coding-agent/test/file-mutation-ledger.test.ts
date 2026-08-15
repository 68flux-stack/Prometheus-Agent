import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

/**
 * The shipped agent registers exactly one tool (`ipython`), so file mutations
 * never reach compaction as tool-call arguments — they arrive on the tool
 * *result*, from the `edit` skill's diffs and the kernel's audit-hook ledger.
 * Before this path existed, every compaction summary shipped an empty
 * <modified-files> section.
 */
describe("compaction file-op extraction from ipython tool results", () => {
	it("collects edited paths from edit-skill diffs on a tool result", () => {
		const fileOps = createFileOps();

		extractFileOpsFromMessage(
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "ipython",
				content: [{ type: "text", text: "Edited src/auth.py" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					status: "ok",
					diffs: [{ path: "src/auth.py", oldStr: "a", newStr: "b" }],
				},
			},
			fileOps,
		);

		expect([...fileOps.edited]).toEqual(["src/auth.py"]);
	});

	it("collects written paths from the audit-hook ledger on a tool result", () => {
		const fileOps = createFileOps();

		extractFileOpsFromMessage(
			{
				role: "toolResult",
				toolCallId: "call-2",
				toolName: "ipython",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					status: "ok",
					mutatedPaths: ["/repo/out.json", "/repo/notes.md"],
				},
			},
			fileOps,
		);

		expect(computeFileLists(fileOps).modifiedFiles).toEqual(["/repo/notes.md", "/repo/out.json"]);
	});

	it("ignores malformed details rather than throwing mid-compaction", () => {
		const fileOps = createFileOps();
		const base = {
			role: "toolResult" as const,
			toolCallId: "call-3",
			toolName: "ipython",
			content: [{ type: "text" as const, text: "" }],
			isError: false,
			timestamp: Date.now(),
		};

		for (const details of [
			undefined,
			null,
			"nope",
			{ diffs: "nope" },
			{ diffs: [null, 7, {}] },
			{ mutatedPaths: [1] },
		]) {
			expect(() => extractFileOpsFromMessage({ ...base, details }, fileOps)).not.toThrow();
		}
		expect(computeFileLists(fileOps).modifiedFiles).toEqual([]);
	});

	it("still reads tool-call arguments, for SDK embedders that register the edit tool", () => {
		const fileOps = createFileOps();

		extractFileOpsFromMessage(
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-4", name: "edit", arguments: { path: "embedder.ts" } }],
				timestamp: Date.now(),
			} as never,
			fileOps,
		);

		expect([...fileOps.edited]).toEqual(["embedder.ts"]);
	});
});

describe("kernel audit-hook file-mutation ledger", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-fs-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		// The kernel's cwd is tempDir, and Windows refuses to remove a directory that
		// is still a live process's cwd even after dispose() resolves. Leaving a temp
		// directory behind must not fail the assertions above.
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	});

	it("reports Python-level writes, renames, and deletes under the cwd", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir);
		const manager = await provisioner.ensure();

		const result = await manager.execute(
			[
				"import os, pathlib, shutil",
				"open('written.txt', 'w').close()",
				"pathlib.Path('via_pathlib.txt').write_text('hi')",
				"open('renamed_from.txt', 'w').close()",
				"os.rename('renamed_from.txt', 'renamed_to.txt')",
				"open('deleted.txt', 'w').close()",
				"os.remove('deleted.txt')",
				"shutil.copyfile('written.txt', 'copied.txt')",
			].join("\n"),
		);

		expect(result.status).toBe("ok");
		const names = (result.mutatedPaths ?? []).map((p) => p.split(/[\\/]/).pop());
		expect(names).toEqual(
			expect.arrayContaining([
				"written.txt",
				"via_pathlib.txt",
				"renamed_from.txt",
				"renamed_to.txt",
				"deleted.txt",
				"copied.txt",
			]),
		);
	}, 180_000);

	it("does not report reads, and does not report writes outside the cwd", async () => {
		const outsideDir = join(tmpdir(), `pi-fs-ledger-outside-${Date.now()}`);
		mkdirSync(outsideDir, { recursive: true });
		writeFileSync(join(tempDir, "readme.txt"), "content");

		try {
			provisioner = new IpythonKernelProvisioner(tempDir);
			const manager = await provisioner.ensure();

			const result = await manager.execute(
				[
					"import os",
					"_ = open('readme.txt').read()",
					`open(os.path.join(${JSON.stringify(outsideDir)}, 'outside.txt'), 'w').close()`,
					"print('done')",
				].join("\n"),
			);

			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("done");
			expect(result.mutatedPaths ?? []).toEqual([]);
		} finally {
			try {
				rmSync(outsideDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}, 180_000);

	it("drains the ledger per cell so a later clean cell reports nothing", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir);
		const manager = await provisioner.ensure();

		const first = await manager.execute("open('once.txt', 'w').close()");
		expect((first.mutatedPaths ?? []).map((p) => p.split(/[\\/]/).pop())).toContain("once.txt");

		const second = await manager.execute("x = 1 + 1");
		expect(second.mutatedPaths ?? []).toEqual([]);
	}, 180_000);
});

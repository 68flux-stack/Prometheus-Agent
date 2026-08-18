import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Windows fails the lease's directory rename with EPERM while something else
// still holds the freshly created candidate; acquisition must retry instead of
// failing the session switch that asked for the lease.
let pendingTransientRenameFailures = 0;

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		renameSync: (from: string, to: string) => {
			if (pendingTransientRenameFailures > 0 && String(to).endsWith(".lock")) {
				pendingTransientRenameFailures--;
				const error = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return actual.renameSync(from, to);
		},
	};
});

const { acquireSessionLease, canonicalSessionPath, SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } =
	await import("../src/core/session-lease.js");

const tempDirs: string[] = [];

afterEach(() => {
	pendingTransientRenameFailures = 0;
	for (const directory of tempDirs.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Best effort: the lease guard may still hold a handle on Windows.
		}
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-session-lease-retry-"));
	tempDirs.push(directory);
	return directory;
}

describe("session lease rename retries", () => {
	it("acquires the lease after transient rename failures", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		pendingTransientRenameFailures = 3;

		const lease = acquireSessionLease(sessionPath, agentDir, {
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: "resident-a",
		});

		expect(pendingTransientRenameFailures).toBe(0);
		expect(lease?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		lease?.release();
	});

	it("surfaces a rename failure that never clears", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		pendingTransientRenameFailures = Number.MAX_SAFE_INTEGER;

		expect(() =>
			acquireSessionLease(sessionPath, agentDir, {
				[SESSION_LEASES_ENABLED_ENV]: "1",
				[SESSION_LEASE_OWNER_ID_ENV]: "resident-a",
			}),
		).toThrow(/EPERM/);
	});
});

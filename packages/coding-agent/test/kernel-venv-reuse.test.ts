import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isVenvLockedError, venvInterpreterUsable } from "../src/core/kernel/bootstrap.js";

const dirs: string[] = [];

function tempVenv(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-kernel-venv-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("venvInterpreterUsable", () => {
	it("rejects a venv whose interpreter is missing", async () => {
		const venv = tempVenv();
		writeFileSync(join(venv, "pyvenv.cfg"), "home = /somewhere\n");

		expect(await venvInterpreterUsable(venv, join(venv, "Scripts", "python.exe"))).toBe(false);
	});

	it("rejects a half-deleted venv that kept only the locked interpreter", async () => {
		// The exact state a failed rebuild leaves on Windows: python.exe survives
		// because it is in use, pyvenv.cfg and Lib/ are already gone. Reusing it
		// would install into the base interpreter instead of the venv.
		const venv = tempVenv();
		const python = join(venv, "python");
		writeFileSync(python, "");

		expect(await venvInterpreterUsable(venv, python)).toBe(false);
	});
});

describe("isVenvLockedError", () => {
	it("recognises the Windows in-use failures for the kernel interpreter", () => {
		for (const message of [
			"failed to remove file `C:\\Users\\x\\.prometheusagent\\kernel-venv\\Scripts\\python.exe`: Access is denied. (os error 5)",
			"EPERM: operation not permitted, unlink 'C:\\...\\kernel-venv\\Scripts\\python.exe'",
			"EBUSY: resource busy or locked, rmdir 'C:\\...\\kernel-venv'",
		]) {
			expect(isVenvLockedError(new Error(message))).toBe(true);
		}
	});

	it("leaves unrelated bootstrap failures on the generic message", () => {
		expect(isVenvLockedError(new Error("failed to fetch https://pypi.org/simple: connection refused"))).toBe(false);
		expect(isVenvLockedError(new Error("No space left on device"))).toBe(false);
	});
});

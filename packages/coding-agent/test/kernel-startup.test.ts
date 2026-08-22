import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessWrapper } from "../src/core/execution-policy.js";
import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

/**
 * A stub interpreter that dies before binding its ports. Windows cannot execute
 * an extensionless `#!/bin/sh` file and Node refuses to spawn a `.cmd` without a
 * shell, so there the stub is a batch file reached through the `processWrapper`
 * hook the sandbox already uses.
 */
function writeFakePython(stderrLine: string): { python: string; processWrapper?: ProcessWrapper } {
	if (process.platform === "win32") {
		const python = join(tempDir, "python.cmd");
		writeFileSync(python, ["@echo off", `echo ${stderrLine}>&2`, "exit /b 42", ""].join("\r\n"));
		return {
			python,
			processWrapper: (command, args) => ({ command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }),
		};
	}
	const python = join(tempDir, "python");
	writeFileSync(python, ["#!/bin/sh", `echo "${stderrLine}" >&2`, "exit 42", ""].join("\n"));
	chmodSync(python, 0o755);
	return { python };
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prometheus-kernel-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		const spawnOptions = writeFakePython("fake kernel died before binding");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ ...spawnOptions, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});
});

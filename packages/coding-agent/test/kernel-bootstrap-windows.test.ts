import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKernelVenvPython } from "../src/core/kernel/bootstrap.js";
import { shouldUseWindowsShell, windowsShellSpawn } from "../src/utils/child-process.js";

let tempDir = "";

describe.runIf(process.platform === "win32")("kernel bootstrap on Windows", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prometheus-bootstrap-win-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("uses the Scripts layout for the venv interpreter", () => {
		expect(getKernelVenvPython(String.raw`C:\venv`)).toBe(String.raw`C:\venv\Scripts\python.exe`);
	});

	it("runs a shim-installed uv, which is a .cmd rather than a PE binary", () => {
		// Mirrors what the bootstrap does once findExecutable resolves `uv.cmd`:
		// spawn it through the shell with quoted arguments. Without the shell Node
		// rejects a .cmd outright, and without quoting an install path with a space
		// splits into two arguments.
		const binDir = join(tempDir, "a bin dir");
		mkdirSync(binDir, { recursive: true });
		const uv = join(binDir, "uv.cmd");
		const logPath = join(tempDir, "uv.log");
		writeFileSync(uv, ["@echo off", `>>"${logPath}" echo %*`, "exit /b 0", ""].join("\r\n"));

		expect(shouldUseWindowsShell(uv)).toBe(true);
		const launch = windowsShellSpawn(uv, ["venv", join(tempDir, "a venv"), "--python", "3.11"]);
		const result = spawnSync(launch.command, launch.args, {
			shell: launch.shell,
			encoding: "utf8",
			windowsHide: true,
			env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.error).toBeUndefined();
	});
});

import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { quoteForWindowsShell, waitForChildProcess } from "../src/utils/child-process.js";

describe("quoteForWindowsShell", () => {
	it("keeps an argument with spaces intact through the Windows shell", () => {
		const args = quoteForWindowsShell(["-p", "process.argv[1]", "C:\\Program Files\\a b"]);
		expect(args[2]).toBe('"C:\\Program Files\\a b"');
		if (process.platform !== "win32") return;
		const result = spawnSync("node", args, { shell: true, encoding: "utf8", windowsHide: true });
		expect(result.stdout.trim()).toBe("C:\\Program Files\\a b");
	});

	it("leaves plain arguments untouched", () => {
		expect(quoteForWindowsShell(["run", "build:desktop"])).toEqual(["run", "build:desktop"]);
	});
});

describe("waitForChildProcess", () => {
	it("reports signaled already-exited children as failures", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: null,
			stderr: null,
			exitCode: null,
			signalCode: "SIGTERM" as NodeJS.Signals,
		});

		await expect(waitForChildProcess(child as unknown as ChildProcess)).resolves.toBe(143);
	});
});

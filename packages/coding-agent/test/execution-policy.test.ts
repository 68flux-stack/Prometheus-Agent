import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutionPolicy, resolvePermission } from "../src/core/execution-policy.js";
import {
	WINDOWS_PLAN_MODE_ENV,
	WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE,
	WINDOWS_WRITE_ROOTS_ENV,
} from "../src/core/kernel/windows-plan-policy.js";

const pythonAvailable = spawnSync("python", ["--version"], { windowsHide: true }).status === 0;

describe("execution policy", () => {
	it("uses ordered last-match-wins rules", () => {
		const rules = [
			{ target: "command" as const, pattern: "*", action: "ask" as const },
			{ target: "command" as const, pattern: "git status*", action: "allow" as const },
			{ target: "command" as const, pattern: "git status --ignored", action: "deny" as const },
		];
		expect(resolvePermission(rules, "command", "git status", "deny")).toBe("allow");
		expect(resolvePermission(rules, "command", "git status --ignored", "allow")).toBe("deny");
		expect(resolvePermission(rules, "command", "npm test", "allow")).toBe("ask");
	});

	it("leaves unrestricted processes unchanged", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-policy-test-"));
		const policy = createExecutionPolicy({ mode: "unrestricted" }, dir, dir);
		expect(policy.secure).toBe(false);
		expect(policy.enforcement).toBe("none");
		expect(policy.wrapProcess("node", ["script.js"])).toEqual({ command: "node", args: ["script.js"] });
	});

	it.runIf(process.platform === "win32")("enforces plan mode at the application boundary on Windows", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-policy-test-"));
		const policy = createExecutionPolicy({ mode: "plan" }, dir, dir);
		expect(policy.secure).toBe(false);
		expect(policy.enforcement).toBe("application");
		expect(policy.permission("tool", "ipython")).toBe("allow");
		expect(policy.permission("tool", "custom-writer")).toBe("deny");
		expect(policy.permission("command", "npm test")).toBe("deny");
		expect(policy.permission("filesystem.read", "README.md")).toBe("allow");
	});

	it.runIf(process.platform === "win32" && pythonAvailable)(
		"allows reads but blocks kernel mutation on Windows",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "prime-policy-test-"));
			const readable = join(dir, "readable.txt");
			writeFileSync(readable, "readable");
			const code = `${WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE}
print(open(${JSON.stringify(readable)}, "r").read())
try:
    open(${JSON.stringify(readable)}, "w").write("changed")
except PermissionError:
    print("write-blocked")
try:
    import subprocess
    subprocess.run(["cmd.exe", "/c", "echo", "changed"])
except PermissionError:
    print("process-blocked")
try:
    import socket
    socket.socket().connect(("127.0.0.1", 9))
except PermissionError:
    print("network-blocked")`;
			const result = spawnSync("python", ["-c", code], {
				encoding: "utf8",
				env: { ...process.env, [WINDOWS_PLAN_MODE_ENV]: "1" },
				windowsHide: true,
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("readable");
			expect(result.stdout).toContain("write-blocked");
			expect(result.stdout).toContain("process-blocked");
			expect(result.stdout).toContain("network-blocked");
		},
	);

	it.runIf(process.platform === "win32")("allows workspace mode on Windows", () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-policy-test-"));
		const policy = createExecutionPolicy({ mode: "workspace" }, dir, dir);
		expect(policy.enforcement).toBe("application");
		expect(policy.permission("tool", "ipython")).toBe("allow");
		expect(policy.permission("command", "npm test")).toBe("allow");
		expect(policy.writeRoots).toEqual([resolve(dir)]);
		const granted = mkdtempSync(join(tmpdir(), "prime-policy-granted-"));
		policy.grantRoot(granted);
		expect(policy.writeRoots).toEqual([resolve(dir), resolve(granted)]);
	});

	it.runIf(process.platform === "win32" && pythonAvailable)(
		"confines kernel writes to the workspace roots on Windows",
		() => {
			const workspace = mkdtempSync(join(tmpdir(), "prime-policy-workspace-"));
			const readable = join(mkdtempSync(join(tmpdir(), "prime-policy-outside-")), "readable.txt");
			writeFileSync(readable, "readable");
			// Outside the workspace *and* outside the temp dir the kernel is allowed to
			// use for its own scratch files. The writes below are expected to fail, so
			// nothing is created here.
			const escapeTarget = join(homedir(), "prime-policy-should-never-exist.txt");
			const code = `${WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE}
import os
escape_path = ${JSON.stringify(escapeTarget)}
print(open(${JSON.stringify(readable)}, "r").read())
open(os.path.join(${JSON.stringify(workspace)}, "inside.txt"), "w").write("ok")
print("inside-allowed")
try:
    open(escape_path, "w").write("nope")
except PermissionError:
    print("outside-blocked")
try:
    os.remove(escape_path)
except PermissionError:
    print("delete-blocked")`;
			const result = spawnSync("python", ["-c", code], {
				encoding: "utf8",
				env: {
					...process.env,
					[WINDOWS_PLAN_MODE_ENV]: "",
					[WINDOWS_WRITE_ROOTS_ENV]: JSON.stringify([workspace]),
				},
				windowsHide: true,
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("readable");
			expect(result.stdout).toContain("inside-allowed");
			expect(result.stdout).toContain("outside-blocked");
			expect(result.stdout).toContain("delete-blocked");
		},
	);

	it.runIf(process.platform === "win32" && pythonAvailable)(
		"opens a directory once the user approves the kernel's access request",
		() => {
			const workspace = mkdtempSync(join(tmpdir(), "prime-policy-workspace-"));
			// Outside the temp dir too — the kernel always keeps its own scratch dir writable.
			const outside = mkdtempSync(join(homedir(), "prime-policy-outside-"));
			const code = `import sys, types
_fake = types.ModuleType("rlm")
_fake.host_request = lambda kind, payload: {"granted": payload["path"] == ${JSON.stringify(outside)}, "root": payload["path"], "message": "ok"}
sys.modules["rlm"] = _fake

${WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE}
import os
denied = os.path.join(${JSON.stringify(outside)}, "..", "prime-policy-denied")
try:
    open(os.path.join(${JSON.stringify(outside)}, "granted.txt"), "w").write("nope")
except PermissionError:
    print("blocked-before-grant")
request_directory_access(${JSON.stringify(outside)}, "test")
open(os.path.join(${JSON.stringify(outside)}, "granted.txt"), "w").write("ok")
print("allowed-after-grant")
request_directory_access(denied, "test")
try:
    open(os.path.join(denied, "nope.txt"), "w").write("nope")
except (PermissionError, FileNotFoundError):
    print("still-blocked-after-deny")`;
			const result = spawnSync("python", ["-c", code], {
				encoding: "utf8",
				env: {
					...process.env,
					[WINDOWS_PLAN_MODE_ENV]: "",
					[WINDOWS_WRITE_ROOTS_ENV]: JSON.stringify([workspace]),
				},
				windowsHide: true,
			});
			rmSync(outside, { recursive: true, force: true });
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("blocked-before-grant");
			expect(result.stdout).toContain("allowed-after-grant");
			expect(result.stdout).toContain("still-blocked-after-deny");
		},
	);
});

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessWrapper } from "../src/core/execution-policy.js";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import type { KernelBootstrapProgressHandler } from "../src/core/kernel/bootstrap.js";
import { type ExecuteResult, KernelBusyAfterInterruptError, KernelManager } from "../src/core/kernel/index.js";
import { createIpythonToolDefinition, IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

let tempDir = "";

// These tests count spawns of a stub python; the default-on forkserver adds an
// extra spawn + ready handshake the stub never answers, so pin direct-spawn.
const savedForkFlag = process.env.PROMETHEUS_KERNEL_FORKSERVER;
beforeAll(() => {
	process.env.PROMETHEUS_KERNEL_FORKSERVER = "0";
});
afterAll(() => {
	if (savedForkFlag === undefined) delete process.env.PROMETHEUS_KERNEL_FORKSERVER;
	else process.env.PROMETHEUS_KERNEL_FORKSERVER = savedForkFlag;
});

/**
 * A stub interpreter that records each spawn and exits non-zero.
 *
 * Windows cannot execute an extensionless `#!/bin/sh` file, and Node refuses to
 * spawn a `.cmd` without a shell, so there the stub is a batch file launched
 * through the same `processWrapper` hook the sandbox uses. Spread `spawnOptions`
 * into the provisioner so both platforms reach the stub the same way.
 */
function writeFakePython(opts: { sleepSeconds?: number } = {}): {
	python: string;
	countRuns: () => number;
	spawnOptions: { python: string; processWrapper?: ProcessWrapper };
} {
	const isWindows = process.platform === "win32";
	const python = join(tempDir, isWindows ? "python.cmd" : "python");
	const countFile = join(tempDir, "runs");
	writeFileSync(
		python,
		isWindows
			? [
					"@echo off",
					`>>"${countFile}" echo run`,
					// `timeout` needs a console; ping is the redirect-safe sleep.
					...(opts.sleepSeconds ? [`ping -n ${opts.sleepSeconds + 1} 127.0.0.1 >nul`] : []),
					"exit /b 42",
					"",
				].join("\r\n")
			: [
					"#!/bin/sh",
					`echo run >> "${countFile}"`,
					...(opts.sleepSeconds ? [`sleep ${opts.sleepSeconds}`] : []),
					"exit 42",
					"",
				].join("\n"),
	);
	if (!isWindows) chmodSync(python, 0o755);
	const countRuns = () => {
		try {
			return readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
		} catch {
			return 0;
		}
	};
	const spawnOptions = isWindows
		? {
				python,
				processWrapper: (command: string, args: string[]) => ({
					command: "cmd.exe",
					args: ["/d", "/s", "/c", command, ...args],
				}),
			}
		: { python };
	return { python, countRuns, spawnOptions };
}

function okExecuteResult(): ExecuteResult {
	return { stdout: "ok", stderr: "", status: "ok", durationMs: 1 };
}

function createBusyKernelContext(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	options: { throwWorkingMessage?: boolean } = {},
): {
	ctx: ExtensionContext;
	setWorkingMessage: ReturnType<typeof vi.fn>;
} {
	const setWorkingMessage = vi.fn(() => {
		if (options.throwWorkingMessage) {
			throw new Error("stale UI context");
		}
	});
	const ctx = {
		hasUI: true,
		ui: {
			select,
			setWorkingMessage,
		},
	} as unknown as ExtensionContext;
	return { ctx, setWorkingMessage };
}

describe("IpythonKernelProvisioner", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prometheus-provisioner-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("memoizes concurrent ensure() calls into one startup", async () => {
		const { countRuns, spawnOptions } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, spawnOptions);

		const [a, b] = await Promise.allSettled([provisioner.ensure(), provisioner.ensure()]);
		expect(a.status).toBe("rejected");
		expect(b.status).toBe("rejected");
		expect(countRuns()).toBe(1);
	});

	it("retries after a failed startup instead of caching the rejection", async () => {
		const { countRuns, spawnOptions } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, spawnOptions);

		await expect(provisioner.ensure()).rejects.toThrow(/Kernel exited before resolving ports/);
		await expect(provisioner.ensure()).rejects.toThrow(/Kernel exited before resolving ports/);
		expect(countRuns()).toBe(2);
	});

	it("prewarm() swallows the failure and the next ensure() starts fresh", async () => {
		const { countRuns, spawnOptions } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, spawnOptions);

		provisioner.prewarm();
		expect(provisioner.manager).toBeUndefined();

		// Once the prewarm startup settles, ensure() must launch a second attempt.
		await vi.waitFor(async () => {
			await expect(provisioner.ensure()).rejects.toThrow();
			expect(countRuns()).toBeGreaterThanOrEqual(2);
		});
	});

	it("replays the current startup stage to listeners attaching mid-flight", async () => {
		const { spawnOptions } = writeFakePython({ sleepSeconds: 1 });
		const provisioner = new IpythonKernelProvisioner(tempDir, spawnOptions);

		provisioner.prewarm();
		const messages: string[] = [];
		const joined = provisioner.ensure((message) => messages.push(message));
		expect(messages).toContain("Starting IPython kernel...");
		await expect(joined).rejects.toThrow();
	});

	it("dispose() settles a startup that is still in flight", async () => {
		const { spawnOptions } = writeFakePython();
		const provisioner = new IpythonKernelProvisioner(tempDir, spawnOptions);

		provisioner.prewarm();
		await provisioner.dispose();
		expect(provisioner.manager).toBeUndefined();
	});

	it("dispose() before the boot slot prevents the kernel from spawning", async () => {
		const { countRuns, spawnOptions } = writeFakePython();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const provisioner = new IpythonKernelProvisioner(tempDir, { ...spawnOptions, readyGate: gate });

		const started = provisioner.ensure().catch(() => {});
		const disposed = provisioner.dispose(); // aborts while the boot waits on readyGate
		release();
		await Promise.all([started, disposed]);
		expect(countRuns()).toBe(0); // disposed boot must never spawn a kernel
	});

	it("aborting the startup owner before the boot slot prevents the kernel from spawning", async () => {
		const { countRuns, spawnOptions } = writeFakePython();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const provisioner = new IpythonKernelProvisioner(tempDir, { ...spawnOptions, readyGate: gate });
		const controller = new AbortController();

		const started = provisioner.ensure(undefined, controller.signal);
		controller.abort();
		await expect(started).rejects.toThrow("IPython execution aborted");
		release();
		await new Promise((r) => setTimeout(r, 50));

		expect(countRuns()).toBe(0);
		expect(provisioner.manager).toBeUndefined();
	});

	it("waits for readyGate before starting the kernel", async () => {
		const { countRuns, spawnOptions } = writeFakePython();
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const provisioner = new IpythonKernelProvisioner(tempDir, { ...spawnOptions, readyGate: gate });

		const started = provisioner.ensure().catch(() => {});
		await new Promise((r) => setTimeout(r, 50));
		expect(countRuns()).toBe(0); // gated: must not spawn the kernel yet

		release();
		await started;
		expect(countRuns()).toBe(1);
	});

	it("listNamespaceNames() returns null when no kernel is running", async () => {
		const provisioner = new IpythonKernelProvisioner(tempDir, {});
		expect(await provisioner.listNamespaceNames()).toBeNull();
	});

	it("does not dispose a running kernel when an ensure caller is aborted", async () => {
		const provisioner = new IpythonKernelProvisioner(tempDir, {});
		const dispose = vi.fn(async () => {});
		const manager = { dispose, isRunning: true } as unknown as KernelManager;
		Object.assign(
			provisioner as unknown as {
				managerPromise: Promise<KernelManager>;
				startedManager: KernelManager;
			},
			{
				managerPromise: Promise.resolve(manager),
				startedManager: manager,
			},
		);
		const controller = new AbortController();
		controller.abort();

		await expect(provisioner.ensure(undefined, controller.signal)).rejects.toThrow("IPython execution aborted");
		expect(dispose).not.toHaveBeenCalled();
		expect(provisioner.manager).toBe(manager);
	});

	it("removes startup progress listeners when an ensure caller is aborted", async () => {
		const provisioner = new IpythonKernelProvisioner(tempDir, {});
		Object.assign(
			provisioner as unknown as {
				managerPromise: Promise<KernelManager>;
			},
			{
				managerPromise: new Promise<KernelManager>(() => {}),
			},
		);
		const controller = new AbortController();
		const onProgress = vi.fn();

		const ensurePromise = provisioner.ensure(onProgress, controller.signal).catch(() => undefined);
		controller.abort();
		await ensurePromise;

		const internals = provisioner as unknown as {
			startupListeners: Set<KernelBootstrapProgressHandler>;
		};
		expect(internals.startupListeners.has(onProgress)).toBe(false);
	});

	it("applies shell settings to bash cells after leading blank lines", async () => {
		const execute = vi.fn<KernelManager["execute"]>().mockResolvedValueOnce(okExecuteResult());
		const manager = { execute } as unknown as KernelManager;
		const ensure = vi.fn(async () => manager);
		const kill = vi.fn(async () => {});
		const provisioner = { ensure, kill } as unknown as IpythonKernelProvisioner;
		const tool = createIpythonToolDefinition(tempDir, {
			provisioner,
			commandPrefix: "export TEST_PREFIX=1",
			shellPath: "/custom/bash",
		});

		await tool.execute(
			"tool-call",
			{ code: "\n \r\n\t%%bash\r\necho body" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(execute).toHaveBeenCalledWith(
			"\n \r\n\t%%script /custom/bash\r\nexport TEST_PREFIX=1\necho body",
			expect.objectContaining({ signal: undefined, onStream: expect.any(Function) }),
		);
	});

	it("double-quotes a shell path with spaces so IPython's arg_split keeps it in one token", async () => {
		const execute = vi.fn<KernelManager["execute"]>().mockResolvedValueOnce(okExecuteResult());
		const manager = { execute } as unknown as KernelManager;
		const provisioner = {
			ensure: vi.fn(async () => manager),
			kill: vi.fn(async () => {}),
		} as unknown as IpythonKernelProvisioner;
		const tool = createIpythonToolDefinition(tempDir, {
			provisioner,
			shellPath: "C:\\Program Files\\Git\\bin\\bash.exe",
		});

		await tool.execute("tool-call", { code: "%%bash\necho hi" }, undefined, undefined, {} as ExtensionContext);

		expect(execute).toHaveBeenCalledWith(
			'%%script "C:\\Program Files\\Git\\bin\\bash.exe"\necho hi',
			expect.anything(),
		);
	});

	it("lets the user wait when an interrupted kernel is still busy", async () => {
		const execute = vi
			.fn<KernelManager["execute"]>()
			.mockRejectedValueOnce(new KernelBusyAfterInterruptError())
			.mockResolvedValueOnce(okExecuteResult());
		const manager = { execute } as unknown as KernelManager;
		const ensure = vi.fn(async () => manager);
		const kill = vi.fn(async () => {});
		const provisioner = { ensure, kill } as unknown as IpythonKernelProvisioner;
		const select = vi.fn(async () => "Wait and preserve state");
		const { ctx, setWorkingMessage } = createBusyKernelContext(select, { throwWorkingMessage: true });
		const tool = createIpythonToolDefinition(tempDir, { provisioner });

		const result = await tool.execute("tool-call", { code: "x = 1" }, undefined, undefined, ctx);

		expect(result.details.status).toBe("ok");
		expect(result.details.kernelRestarted).toBe(false);
		expect(ensure).toHaveBeenCalledTimes(2);
		expect(kill).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledWith(
			expect.stringContaining("previous cell has not stopped"),
			["Wait and preserve state", "Kill kernel and restart"],
			{
				signal: undefined,
			},
		);
		expect(setWorkingMessage).toHaveBeenCalledWith("Waiting for IPython kernel...");
		expect(setWorkingMessage).toHaveBeenLastCalledWith(undefined);
	});

	it("lets the user kill and restart a busy interrupted kernel", async () => {
		const busyManager = {
			execute: vi.fn<KernelManager["execute"]>().mockRejectedValueOnce(new KernelBusyAfterInterruptError()),
		} as unknown as KernelManager;
		const freshManager = {
			execute: vi.fn<KernelManager["execute"]>().mockResolvedValueOnce(okExecuteResult()),
		} as unknown as KernelManager;
		const ensure = vi.fn(async () => {
			return ensure.mock.calls.length === 1 ? busyManager : freshManager;
		});
		const kill = vi.fn(async () => {});
		const provisioner = { ensure, kill } as unknown as IpythonKernelProvisioner;
		const select = vi.fn(async () => "Kill kernel and restart");
		const { ctx, setWorkingMessage } = createBusyKernelContext(select, { throwWorkingMessage: true });
		const tool = createIpythonToolDefinition(tempDir, { provisioner });

		const result = await tool.execute("tool-call", { code: "x = 1" }, undefined, undefined, ctx);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(result.details.status).toBe("ok");
		expect(result.details.kernelRestarted).toBe(true);
		expect(text).toContain("<ipython_kernel_reset>");
		expect(text).toContain("Variables, imports, async tasks, and open resources");
		expect(text).toContain("ok");
		expect(ensure).toHaveBeenCalledTimes(2);
		expect(kill).toHaveBeenCalledTimes(1);
		expect(freshManager.execute).toHaveBeenCalledWith("x = 1", expect.objectContaining({ signal: undefined }));
		expect(setWorkingMessage).toHaveBeenCalledWith("Restarting IPython kernel...");
		expect(setWorkingMessage).toHaveBeenLastCalledWith(undefined);
	});

	it("does not delete the on-disk snapshot (the kernel survives compaction)", async () => {
		const snapshotDir = join(tempDir, "artifacts");
		const provisioner = new IpythonKernelProvisioner(tempDir, { snapshotDir });
		const dill = join(snapshotDir, "kernel-state.dill");
		const manifest = join(snapshotDir, "kernel-state.json");
		mkdirSync(snapshotDir, { recursive: true });
		writeFileSync(dill, "payload");
		writeFileSync(manifest, "{}");

		// listing the namespace must never touch the on-disk snapshot
		await provisioner.listNamespaceNames();

		expect(existsSync(dill)).toBe(true);
		expect(existsSync(manifest)).toBe(true);
	});
});

describe("KernelManager session cleanup during startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prometheus-kernel-cleanup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("disposes a kernel that is still booting when its session is cleaned up", async () => {
		// Never writes connection ports - stays in the booting phase until killed.
		const { spawnOptions } = writeFakePython({ sleepSeconds: 30 });
		const sessionId = `provisioner-test-${Date.now()}`;
		const manager = new KernelManager({ ...spawnOptions, cwd: tempDir, sessionId });

		try {
			const startup = manager.start();
			cleanupSessionResources(sessionId);
			await expect(startup).rejects.toThrow(/Kernel exited before resolving ports|disposed during startup/);
			expect(manager.isRunning).toBe(false);
		} finally {
			await manager.dispose();
		}
	});
});

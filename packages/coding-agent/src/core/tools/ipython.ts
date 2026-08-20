// TODO: reconsider whether the persistent kernel is needed once RLM-1 weights land.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.js";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { PermissionAction, ProcessWrapper } from "../execution-policy.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
	type ExecuteResult,
	FILE_MUTATION_DISPLAY_MIME,
	FILE_READ_DISPLAY_MIME,
	type HostRequestHandlers,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelDiffDisplay,
	KernelManager,
	type KernelSentAgentMessage,
} from "../kernel/index.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import { WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE } from "../kernel/windows-plan-policy.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { parseIpythonBashCell } from "./ipython-cell-code.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

/**
 * Kernel-side file-mutation and file-read ledger.
 *
 * The agent's only tool is this kernel, so the host has no tool-argument boundary
 * to learn what the model did to the filesystem — an `await edit(...)` reports a
 * diff, but `open(p, "w")`, `pathlib.write_text`, and `shutil.move` report nothing,
 * and a plain `open(p).read()` / `Path(p).read_text()` reports nothing either.
 * `sys.addaudithook` is the equivalent boundary for a single-Python-tool harness:
 * CPython raises these events from inside the C implementations, so every Python
 * caller is covered without patching any module.
 *
 * The hook only records into a set (no I/O, so no re-entrancy) and a `post_run_cell`
 * callback flushes it once per cell as a `display_data` payload, reusing the same
 * channel the `edit` and `attach-image` skills already use. Reads flush under a
 * separate MIME so a client that only understands mutations keeps working unchanged.
 *
 * ponytail: paths are filtered with abspath, not realpath, so a symlink pointing
 * outside the cwd is still recorded as inside it. This list is a summary hint, not
 * a security boundary — switch to realpath (and add a re-entrancy guard, since it
 * hits the filesystem) only if it ever gates an action.
 */
const FS_LEDGER_BOOTSTRAP_CODE = `
import os as _prometheus_ledger_os
import sys as _prometheus_ledger_sys

if not getattr(_prometheus_ledger_sys, "_prometheus_fs_ledger_installed", False):
    _prometheus_ledger_sys._prometheus_fs_ledger_installed = True
    _PROMETHEUS_FS_MUTATIONS = set()
    _PROMETHEUS_FS_READS = set()
    # Cap so a runaway loop cannot grow either set or its flushed payload without bound.
    _PROMETHEUS_FS_MUTATIONS_CAP = 200
    _PROMETHEUS_FS_READS_CAP = 200
    # Single path argument.
    _PROMETHEUS_FS_EVENTS_ONE = frozenset({
        "os.remove", "os.rmdir", "os.mkdir", "os.truncate", "os.chmod", "os.utime",
    })
    # (src, dst): both ends change.
    _PROMETHEUS_FS_EVENTS_TWO = frozenset({"os.rename", "os.replace", "os.link", "os.symlink"})
    # (src, dst): only dst is written.
    _PROMETHEUS_FS_EVENTS_DST = frozenset({"shutil.copyfile", "shutil.copymode", "shutil.copystat"})
    _PROMETHEUS_FS_EVENTS_ALL = (
        _PROMETHEUS_FS_EVENTS_ONE | _PROMETHEUS_FS_EVENTS_TWO | _PROMETHEUS_FS_EVENTS_DST | {"open"}
    )

    def _prometheus_ledger_record(path, bucket, cap):
        if path is None or isinstance(path, int):
            return
        try:
            path = _prometheus_ledger_os.fsdecode(path)
        except Exception:
            return
        # abspath is pure string work plus getcwd; it never re-enters an audited event.
        path = _prometheus_ledger_os.path.abspath(path)
        cwd = _prometheus_ledger_os.getcwd()
        if path != cwd and not path.startswith(cwd + _prometheus_ledger_os.sep):
            return
        if len(bucket) < cap:
            bucket.add(path)

    def _prometheus_ledger_audit(event, args):
        # Fast reject: this runs on every audited event in the kernel, including
        # every import and compile, so the membership test must come first.
        if event not in _PROMETHEUS_FS_EVENTS_ALL:
            return
        try:
            if event == "open":
                mode, flags = args[1], args[2]
                if isinstance(mode, str):
                    is_write = any(c in mode for c in ("w", "a", "x", "+"))
                elif isinstance(flags, int):
                    write_flags = (
                        _prometheus_ledger_os.O_WRONLY
                        | _prometheus_ledger_os.O_RDWR
                        | _prometheus_ledger_os.O_APPEND
                        | _prometheus_ledger_os.O_CREAT
                        | _prometheus_ledger_os.O_TRUNC
                    )
                    is_write = bool(flags & write_flags)
                else:
                    return
                if is_write:
                    _prometheus_ledger_record(args[0], _PROMETHEUS_FS_MUTATIONS, _PROMETHEUS_FS_MUTATIONS_CAP)
                else:
                    _prometheus_ledger_record(args[0], _PROMETHEUS_FS_READS, _PROMETHEUS_FS_READS_CAP)
            elif event in _PROMETHEUS_FS_EVENTS_TWO:
                _prometheus_ledger_record(args[0], _PROMETHEUS_FS_MUTATIONS, _PROMETHEUS_FS_MUTATIONS_CAP)
                _prometheus_ledger_record(args[1], _PROMETHEUS_FS_MUTATIONS, _PROMETHEUS_FS_MUTATIONS_CAP)
            elif event in _PROMETHEUS_FS_EVENTS_DST:
                _prometheus_ledger_record(args[1], _PROMETHEUS_FS_MUTATIONS, _PROMETHEUS_FS_MUTATIONS_CAP)
            else:
                _prometheus_ledger_record(args[0], _PROMETHEUS_FS_MUTATIONS, _PROMETHEUS_FS_MUTATIONS_CAP)
        except Exception:
            # An audit hook that raises breaks the operation it is observing.
            pass

    def _prometheus_ledger_flush(*_args, **_kwargs):
        if not _PROMETHEUS_FS_MUTATIONS and not _PROMETHEUS_FS_READS:
            return
        try:
            from IPython.display import display as _prometheus_ledger_display

            if _PROMETHEUS_FS_MUTATIONS:
                paths = sorted(_PROMETHEUS_FS_MUTATIONS)
                _PROMETHEUS_FS_MUTATIONS.clear()
                _prometheus_ledger_display(
                    {"${FILE_MUTATION_DISPLAY_MIME}": {"paths": paths}},
                    raw=True,
                )
            if _PROMETHEUS_FS_READS:
                paths = sorted(_PROMETHEUS_FS_READS)
                _PROMETHEUS_FS_READS.clear()
                _prometheus_ledger_display(
                    {"${FILE_READ_DISPLAY_MIME}": {"paths": paths}},
                    raw=True,
                )
        except Exception:
            pass

    _prometheus_ledger_sys.addaudithook(_prometheus_ledger_audit)
    get_ipython().events.register("post_run_cell", _prometheus_ledger_flush)
`.trim();

const RLM_BOOTSTRAP_BASE_CODE = `
import asyncio
import os as _prometheus_os

_prometheus_os.environ["NO_COLOR"] = "1"
get_ipython().colors = "nocolor"

${FS_LEDGER_BOOTSTRAP_CODE}

try:
    import nest_asyncio as _prometheus_nest_asyncio
    _prometheus_nest_asyncio.apply()
except Exception:
    pass

try:
    import rlm as _prometheus_rlm_module
    rlm = _prometheus_rlm_module.rlm
    from rlm import lsp

    # Nested: a kernel venv holding a runtime older than search() must lose only
    # search, not rlm and lsp along with it.
    try:
        from rlm import search
    except Exception as _prometheus_search_error:
        def search(*_args, **_kwargs):
            raise RuntimeError(
                "search() needs a current prometheus-runtime in this kernel venv. "
                f"Import error: {_prometheus_search_error}"
            )

    def _prometheus_lsp_housekeeping(*_args, **_kwargs):
        try:
            asyncio.get_running_loop().create_task(lsp.shutdown_idle())
        except Exception:
            pass

    get_ipython().events.register("post_run_cell", _prometheus_lsp_housekeeping)
except Exception as _prometheus_rlm_error:
    _PROMETHEUS_RLM_IMPORT_ERROR = str(_prometheus_rlm_error)

    class _PrometheusMissingRlm:
        def _raise_missing(self):
            raise RuntimeError(
                "prometheus-runtime is not installed in this IPython kernel. "
                "Remove ~/.prometheus/agent/kernel-venv so prometheus can rebuild it, or set "
                "PROMETHEUS_KERNEL_PYTHON to a kernel environment with prometheus-runtime installed. "
                f"Import error: {_PROMETHEUS_RLM_IMPORT_ERROR}"
            )

        async def run(self, prompt, **kwargs):
            self._raise_missing()

        async def find_models(self, query="", limit=8):
            self._raise_missing()

        async def list_subagents(self):
            self._raise_missing()

        async def delete_subagent(self, target):
            self._raise_missing()

        async def __call__(self, prompt, **kwargs):
            return await self.run(prompt, **kwargs)

    rlm = _PrometheusMissingRlm()
    lsp = _PrometheusMissingRlm()
    search = _PrometheusMissingRlm()
`.trim();

export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return `${RLM_BOOTSTRAP_BASE_CODE}\n\n${WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE}`;
	}

	return `
${RLM_BOOTSTRAP_BASE_CODE}

import importlib as _prometheus_importlib
import inspect as _prometheus_inspect
import sys as _prometheus_sys
import types as _prometheus_types

class _PrometheusCallableSkillModule(_prometheus_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prometheus_inspect.isawaitable(result):
            return await result
        return result

class _PrometheusUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prometheus_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this IPython kernel. "
            f"Import error: {self._prometheus_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prometheus_import_error}>"

def _prometheus_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    if isinstance(module, _PrometheusCallableSkillModule):
        return module
    wrapped = _PrometheusCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _prometheus_inspect.signature(run)
    except Exception:
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prometheus_sys.modules[module.__name__] = wrapped
    return wrapped

_PROMETHEUS_SKILL_IMPORT_ERRORS = {}

for _prometheus_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_prometheus_skill_name] = _prometheus_wrap_skill_module(
            _prometheus_importlib.import_module(_prometheus_skill_name)
        )
    except Exception as _prometheus_skill_error:
        _PROMETHEUS_SKILL_IMPORT_ERRORS[_prometheus_skill_name] = str(_prometheus_skill_error)
        globals()[_prometheus_skill_name] = _PrometheusUnavailableSkill(
            _prometheus_skill_name,
            str(_prometheus_skill_error),
        )

${WINDOWS_PLAN_POLICY_BOOTSTRAP_CODE}
`.trim();
}

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
const BUSY_KERNEL_PROMPT = [
	"Interrupted IPython cell is still running",
	"Ctrl+C sent an interrupt, but the previous cell has not stopped yet. A new IPython command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts IPython and loses in-memory variables, imports, and running tasks.",
].join("\n");
const KERNEL_RESTART_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted after a previous interrupted cell kept running. Variables, imports, async tasks, and open resources from before the restart are no longer available; recreate them before using them.",
	"</ipython_kernel_reset>",
].join("\n");

function createAbortError(): Error {
	return new Error("IPython execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(createAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function createLinkedAbortSignal(sources: readonly (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const cleanups: Array<() => void> = [];
	const abort = () => controller.abort();
	for (const source of sources) {
		if (!source) {
			continue;
		}
		if (source.aborted) {
			controller.abort();
			continue;
		}
		const listener = () => abort();
		source.addEventListener("abort", listener, { once: true });
		cleanups.push(() => source.removeEventListener("abort", listener));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		},
	};
}

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {
		// Stale UI context; cosmetic only.
	}
}

export type IpythonToolInput = Static<typeof ipythonSchema>;

export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	fullOutputPaths?: ExecuteResult["fullOutputPaths"];
	/** Diffs streamed from file edits, rendered by the IPython cell. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/**
	 * Paths under the kernel cwd this cell mutated through Python-level file APIs,
	 * from the audit-hook ledger. `%%bash` subprocess writes are not visible to it.
	 */
	mutatedPaths?: string[];
	/** Paths under the kernel cwd this cell read through Python-level file APIs, same ledger. */
	readPaths?: string[];
	/** True when this result came after killing and restarting a busy kernel. */
	kernelRestarted?: boolean;
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface IpythonToolOptions {
	/** Python override. Must have `ipykernel` installed. */
	python?: string;
	env?: Record<string, string>;
	/** OS-enforced wrapper applied to the persistent kernel process. */
	processWrapper?: ProcessWrapper;
	authorizeCommand?: (command: string) => PermissionAction;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Optional explicit shell path for bare %%bash cells. */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/** Filled with the live KernelManager after the first kernel start; cleared on construction. */
	kernelManagerRef?: { current?: KernelManager };
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
	/** Shared provisioner owning the kernel lifecycle. When provided, the remaining options are ignored. */
	provisioner?: IpythonKernelProvisioner;
}

/**
 * `%%bash` makes IPython resolve "bash" on PATH. On Windows the first hit is
 * normally `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` — the WSL launcher —
 * so cells run in a Linux namespace where the kernel's Windows cwd doesn't
 * exist and every path the agent knows is wrong. The bash tool already resolves
 * a real Windows bash (Git Bash first) via getShellConfig; pin `%%bash` cells to
 * the same one so both tools mean the same shell.
 *
 * Memoized: resolution shells out to `where`, and the answer can't change within
 * a process.
 */
let cachedWindowsShellPath: string | null | undefined;
function defaultShellPath(): string | undefined {
	if (process.platform !== "win32") return undefined;
	if (cachedWindowsShellPath === undefined) {
		try {
			cachedWindowsShellPath = getShellConfig().shell;
		} catch {
			// No bash at all: leave %%bash alone so the failure stays IPython's own.
			cachedWindowsShellPath = null;
		}
	}
	return cachedWindowsShellPath ?? undefined;
}

/**
 * IPython splits a `%%script` argument line with `arg_split`, which on Windows
 * runs shlex in non-posix mode: single quotes are kept as literal characters, so
 * `'C:\Program Files\...'` becomes two bogus tokens. Double quotes are the one
 * form both modes strip — hence a double-quoted argument rather than the usual
 * POSIX single-quoting.
 */
function quoteScriptMagicArgument(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/"/g, "")}"`;
}

function applyShellSettingsToBashMagicCell(
	code: string,
	options: Pick<IpythonToolOptions, "commandPrefix" | "shellPath"> | undefined,
): string {
	const commandPrefix = options?.commandPrefix;
	const shellPath = (options?.shellPath?.trim() || defaultShellPath())?.trim();
	if (!commandPrefix && !shellPath) return code;

	const bashCell = parseIpythonBashCell(code);
	if (!bashCell) return code;

	const firstLine =
		shellPath && bashCell.magicArguments.trim().length === 0
			? `${bashCell.indent}%%script ${quoteScriptMagicArgument(shellPath)}`
			: `${bashCell.indent}%%bash${bashCell.magicArguments}`;
	const nextBody = commandPrefix ? `${commandPrefix}${bashCell.body ? `\n${bashCell.body}` : ""}` : bashCell.body;
	return `${bashCell.leadingWhitespace}${firstLine}${bashCell.lineBreak || "\n"}${nextBody}`;
}

/**
 * Run a plain %%bash cell outside the persistent kernel. Each call owns its own
 * child process, so sibling tool calls can execute concurrently. Bash magics
 * with arguments still use IPython because options such as --out mutate the
 * kernel namespace.
 */
async function executeConcurrentBashCell(
	cwd: string,
	body: string,
	options: IpythonToolOptions | undefined,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
): Promise<ExecuteResult> {
	const startedAt = Date.now();
	if (signal?.aborted) {
		return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
	}

	const command = options?.commandPrefix ? `${options.commandPrefix}${body ? `\n${body}` : ""}` : body;
	const shellConfig = getShellConfig(options?.shellPath?.trim() || defaultShellPath());
	const wrapped = options?.processWrapper?.(shellConfig.shell, [...shellConfig.args, command]) ?? {
		command: shellConfig.shell,
		args: [...shellConfig.args, command],
	};
	const child = spawn(wrapped.command, wrapped.args, {
		cwd,
		detached: process.platform !== "win32",
		env: { ...getShellEnv(), ...options?.env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	if (child.pid) trackDetachedChildPid(child.pid);

	let stdout = "";
	let stderr = "";
	const append = (chunk: Buffer, name: "stdout" | "stderr") => {
		const text = chunk.toString();
		if (name === "stdout") stdout += text;
		else stderr += text;
		onStream(text, name);
	};
	child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
	child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));

	const abort = () => {
		if (child.pid) killProcessTree(child.pid);
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const exitCode = await waitForChildProcess(child);
		if (signal?.aborted) {
			return { stdout, stderr, status: "aborted", durationMs: Date.now() - startedAt };
		}
		if (exitCode !== 0) {
			const message = `Command exited with code ${exitCode ?? "unknown"}`;
			return {
				stdout,
				stderr,
				status: "error",
				error: { ename: "ShellError", evalue: message, traceback: [message] },
				durationMs: Date.now() - startedAt,
			};
		}
		return { stdout, stderr, status: "ok", durationMs: Date.now() - startedAt };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			stdout,
			stderr,
			status: signal?.aborted ? "aborted" : "error",
			...(signal?.aborted ? {} : { error: { ename: "ShellError", evalue: message, traceback: [message] } }),
			durationMs: Date.now() - startedAt,
		};
	} finally {
		signal?.removeEventListener("abort", abort);
		if (child.pid) untrackDetachedChildPid(child.pid);
	}
}

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's IPython kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IpythonKernelProvisioner {
	private managerPromise?: Promise<KernelManager>;
	private startedManager?: KernelManager;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<IpythonToolOptions, "provisioner">,
	) {
		if (options?.kernelManagerRef) {
			options.kernelManagerRef.current = undefined;
		}
	}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelManager | undefined {
		return this.startedManager;
	}

	/** Result of reviving a prior session's namespace on the last kernel start, if any. */
	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	/** Start the kernel in the background. Failures are swallowed here and surface on the next ensure(). */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(): Promise<void> {
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		if (!pending) return;
		try {
			const m = await pending;
			await m.dispose();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelManager> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError());
		}
		let cleanupProgressListener: (() => void) | undefined;
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			cleanupProgressListener = () => {
				this.startupListeners.delete(onProgress);
				signal?.removeEventListener("abort", cleanupProgressListener!);
			};
			signal?.addEventListener("abort", cleanupProgressListener, { once: true });
			// Joining an in-flight startup: replay the current stage.
			if (this.managerPromise && this.lastStartupMessage) {
				onProgress(this.lastStartupMessage);
			}
		}
		if (!this.managerPromise) {
			const startup = this.startKernel(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
					this.settleStartup();
				},
				() => {
					// Clear the memo so the next ensure() retries instead of
					// rethrowing a cached rejection forever.
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
					this.settleStartup();
				},
			);
		}
		return raceWithAbort(this.managerPromise, signal).finally(() => {
			cleanupProgressListener?.();
		});
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of [...this.startupListeners]) {
			listener(message);
		}
	}

	private async startKernel(signal?: AbortSignal): Promise<KernelManager> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		const startupSignal = startupAbort.signal;
		// Wait for a previous provisioner (e.g. on /reload) to finish disposing — and
		// flushing its final snapshot — before we read that snapshot back, so the two
		// kernels can't race over the same on-disk file. Guarded so the common
		// no-gate path stays synchronous (callers rely on prompt startup progress).
		try {
			if (this.options?.readyGate) {
				await raceWithAbort(
					this.options.readyGate.catch(() => {}),
					startupSignal,
				);
			}
			const snapshotDir = this.options?.snapshotDir;
			const m = new KernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				env: this.options?.env,
				processWrapper: this.options?.processWrapper,
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
			});
			let pendingRestore: RestoreResult | undefined;
			try {
				// Emitted synchronously (before the permit await) so a listener attaching
				// mid-flight can replay the current stage.
				this.emitStartupProgress("Starting IPython kernel...");
				// Only the process spawn + port resolve contends for OS resources under a
				// fan-out, and it is bounded by start()'s own timeouts — so the permit
				// covers only start(). Restore/bootstrap run per-kernel afterwards and are
				// unbounded execute()s; holding the global permit across them could pin it
				// forever on a wedged bootstrap and starve every other session's boot.
				await withKernelBootPermit(() => {
					// Disposed while queued for the permit — don't spawn a kernel nobody wants.
					if (startupSignal.aborted) throw new Error("Kernel provisioner disposed before start");
					return m.start({
						onBootstrapProgress: (message) => this.emitStartupProgress(message),
						signal: startupSignal,
					});
				}, startupSignal);
				// Revive a prior session's namespace before the bootstrap, so the bootstrap
				// then overwrites live handles (rlm, skills) on top of anything restored.
				if (snapshotDir) {
					const snapshotExisted = existsSync(snapshotPathIn(snapshotDir));
					this.emitStartupProgress("Restoring IPython state...");
					const restore = await raceWithAbort(m.restoreState(), startupSignal);
					if (snapshotExisted) {
						pendingRestore = restore ?? { restored: [], failed: [], path: snapshotPathIn(snapshotDir) };
					}
				}
				this.emitStartupProgress("Preparing IPython runtime...");
				const bootstrap = await m.execute(buildRlmBootstrapCode(this.options?.pythonSkills), {
					signal: startupSignal,
				});
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the IPython kernel:\n${details}`);
				}
			} catch (error) {
				// Never leak the kernel's ZMQ sockets / temp dir if startup fails after spawn.
				void m.dispose();
				throw error;
			}
			// Only tell the model what was revived once the kernel is actually usable —
			// a notice claiming restored state must never outlive a failed bootstrap.
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			if (this.options?.kernelManagerRef) {
				this.options.kernelManagerRef.current = m;
			}
			return m;
		} finally {
			startupAbort.cleanup();
		}
	}
}

async function chooseBusyKernelAction(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
): Promise<"wait" | "kill" | "cancel"> {
	if (!ctx?.hasUI) {
		return "cancel";
	}
	const choice = await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], {
		signal,
	});
	if (choice === BUSY_KERNEL_WAIT_CHOICE) {
		return "wait";
	}
	if (choice === BUSY_KERNEL_KILL_CHOICE) {
		return "kill";
	}
	return "cancel";
}

async function executeWithBusyKernelChoice(
	provisioner: IpythonKernelProvisioner,
	reportStartupProgress: KernelBootstrapProgressHandler,
	toolCallId: string,
	code: string,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
	onWorkingMessage: (message?: string) => void,
	onLateSentAgentMessage: ((toolCallId: string, message: KernelSentAgentMessage) => void) | undefined,
	ctx: ExtensionContext | undefined,
): Promise<{ result: ExecuteResult; kernelRestarted: boolean }> {
	let kernelRestarted = false;
	while (true) {
		const m = await provisioner.ensure(reportStartupProgress, signal);
		try {
			return {
				result: await m.execute(code, {
					signal,
					onStream,
					onLateSentAgentMessage: onLateSentAgentMessage
						? (message) => onLateSentAgentMessage(toolCallId, message)
						: undefined,
				}),
				kernelRestarted,
			};
		} catch (error) {
			if (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {
				throw error;
			}
			const action = await chooseBusyKernelAction(ctx, signal);
			if (action === "wait") {
				onWorkingMessage("Waiting for IPython kernel...");
				continue;
			}
			if (action === "kill") {
				onWorkingMessage("Restarting IPython kernel...");
				await provisioner.kill();
				kernelRestarted = true;
				continue;
			}
			throw error;
		}
	}
}

/** Turn kernel image attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

export function createIpythonToolDefinition(
	cwd: string,
	options?: IpythonToolOptions,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const provisioner = options?.provisioner ?? new IpythonKernelProvisioner(cwd, options);

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python scratchpad code and `%%bash` shell cells. Plain `%%bash` calls run in independent processes so sibling calls can execute concurrently; Python calls share a persistent IPython namespace and serialize. Variables, imports, and loaded data persist across Python calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment. To find code, call the preloaded `search(pattern, path='.', glob=..., ignore_case=..., files_only=...)` (ripgrep-backed, gitignore-aware, bounded) instead of walking the tree with `rglob`/`os.walk` and reading files — a hand-rolled scan descends into dependency and build directories and can wedge the kernel for minutes.",
		promptSnippet:
			"ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration; preloaded `search()` for ripgrep-backed content search",
		// Plain %%bash cells own independent child processes. Python cells still serialize
		// inside KernelManager because the persistent Jupyter namespace is single-threaded.
		executionMode: "parallel",
		parameters: ipythonSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				setToolWorkingMessage(message);
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { status: "starting" },
				});
			};

			try {
				const bashCell = parseIpythonBashCell(params.code);
				if (bashCell && options?.authorizeCommand) {
					const action = options.authorizeCommand(bashCell.body);
					if (action === "deny") throw new Error("Command is denied by the current permission rules");
					if (action === "ask") {
						const approved =
							ctx?.hasUI === true &&
							(await ctx.ui.confirm("Command approval", `Allow this command once?\n\n${bashCell.body}`, {
								signal,
							}));
						if (!approved) throw new Error("Command approval was rejected or unavailable");
					}
				}
				const onStream = (chunk: string) => {
					onUpdate?.({
						content: [{ type: "text", text: chunk }],
						details: { status: "ok" },
					});
				};
				const concurrentBash = bashCell && bashCell.magicArguments.trim().length === 0;
				const { result: r, kernelRestarted } = concurrentBash
					? {
							result: await executeConcurrentBashCell(cwd, bashCell.body, options, signal, onStream),
							kernelRestarted: false,
						}
					: await executeWithBusyKernelChoice(
							provisioner,
							reportStartupProgress,
							toolCallId,
							applyShellSettingsToBashMagicCell(params.code, options),
							signal,
							onStream,
							setToolWorkingMessage,
							options?.onLateSentAgentMessage,
							ctx,
						);

				let text = r.stdout;
				if (r.stderr) text += (text ? "\n" : "") + r.stderr;
				if (r.result) text += (text ? "\n" : "") + r.result;
				if (r.status === "error" && r.error) {
					text += (text ? "\n" : "") + r.error.traceback.join("\n");
				}
				if (kernelRestarted) {
					text = text ? `${KERNEL_RESTART_NOTICE}\n\n${text}` : KERNEL_RESTART_NOTICE;
				}

				const imageBlocks = imageBlocksFromAttachments(r.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						errorEname: r.error?.ename,
						stdout: r.stdout,
						stderr: r.stderr,
						result: r.result,
						fullOutputPaths: r.fullOutputPaths,
						diffs: r.diffs,
						attachments: r.attachments,
						sentAgentMessages: r.sentAgentMessages,
						mutatedPaths: r.mutatedPaths,
						readPaths: r.readPaths,
						kernelRestarted,
						error: r.error,
					},
					isError: r.status === "error" || r.status === "aborted",
				};
			} finally {
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createIpythonTool(cwd: string, options?: IpythonToolOptions): AgentTool<typeof ipythonSchema> {
	return wrapToolDefinition(createIpythonToolDefinition(cwd, options));
}

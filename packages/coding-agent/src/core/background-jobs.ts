import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { getShellConfig, getShellEnv, killProcessTree, sanitizeBinaryOutput } from "../utils/shell.js";
import type { CustomMessage } from "./messages.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 5 * 60_000;

export const BACKGROUND_JOB_FINISHED_CUSTOM_TYPE = "background_job_finished";
export const BACKGROUND_JOB_FINISHED_PREVIEW_LABEL = "Background job finished";

export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled" | "orphaned";

export interface BackgroundJobProgress {
	percent?: number;
	current?: number;
	total?: number;
	message?: string;
}

export interface BackgroundJobSnapshot {
	id: string;
	command: string;
	cwd: string;
	status: BackgroundJobStatus;
	pid?: number;
	startedAt: string;
	finishedAt?: string;
	elapsedMs?: number;
	exitCode?: number;
	signal?: string;
	revision: number;
	detached: boolean;
	progress?: BackgroundJobProgress;
	outputBytes: number;
}

export interface BackgroundJobWaitResult {
	job: BackgroundJobSnapshot;
	changed: boolean;
	timedOut: boolean;
}

export interface BackgroundJobFinishedDetails {
	jobId: string;
	command: string;
	status: BackgroundJobStatus;
	exitCode?: number;
	signal?: string;
}

export function createBackgroundJobFinishedMessage(
	job: BackgroundJobSnapshot,
	tail: string,
): CustomMessage<BackgroundJobFinishedDetails> {
	const outcome = job.status === "completed" ? "completed" : job.status === "cancelled" ? "was cancelled" : "failed";
	const exitInfo =
		job.exitCode !== undefined ? ` (exit code ${job.exitCode})` : job.signal ? ` (signal ${job.signal})` : "";
	const text = `Background job ${outcome}${exitInfo}: \`${job.command}\`\n\n<background_job_output>\n${tail || "(no output)"}\n</background_job_output>`;
	return {
		role: "custom",
		customType: BACKGROUND_JOB_FINISHED_CUSTOM_TYPE,
		content: text,
		display: true,
		details: {
			jobId: job.id,
			command: job.command,
			status: job.status,
			exitCode: job.exitCode,
			signal: job.signal,
		},
		timestamp: Date.now(),
	};
}

interface BackgroundJobRecord extends BackgroundJobSnapshot {
	output: string;
	process?: ChildProcessWithoutNullStreams;
	waiters: Set<() => void>;
	notifiedFinish?: boolean;
}

export interface BackgroundJobManagerOptions {
	artifactDir: string;
	cwd: string;
	shellPath?: string;
	maxOutputBytes?: number;
	processWrapper?: (command: string, args: string[]) => { command: string; args: string[] };
	/** Called once when a job reaches a terminal state (completed, failed, cancelled, or orphan-confirmed-dead). */
	onFinish?: (job: BackgroundJobSnapshot) => void;
}

export interface StartBackgroundJobOptions {
	cwd?: string;
	env?: Record<string, string>;
	detached?: boolean;
}

function isTerminal(status: BackgroundJobStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function processIsAlive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function parseProgress(chunk: string): BackgroundJobProgress | undefined {
	const structured = /(?:PROMETHEUS_PROGRESS|JCODE_PROGRESS)\s+([^\r\n]+)/g;
	let latest: BackgroundJobProgress | undefined;
	let match = structured.exec(chunk);
	while (match !== null) {
		try {
			const value = JSON.parse(match[1]) as Record<string, unknown>;
			latest = {
				...(typeof value.percent === "number" ? { percent: Math.max(0, Math.min(100, value.percent)) } : {}),
				...(typeof value.current === "number" ? { current: value.current } : {}),
				...(typeof value.total === "number" ? { total: value.total } : {}),
				...(typeof value.message === "string" ? { message: value.message } : {}),
			};
		} catch {
			// Ignore malformed progress markers; ordinary process output is still retained.
		}
		match = structured.exec(chunk);
	}
	if (latest) return latest;

	const ratio = /(?:^|\s)(\d+)\s*\/\s*(\d+)(?:\s|$)/.exec(chunk);
	if (ratio) {
		const current = Number(ratio[1]);
		const total = Number(ratio[2]);
		if (total > 0 && current <= total) return { current, total, percent: (current / total) * 100 };
	}
	const percent = /(?:^|\s)(\d{1,3}(?:\.\d+)?)%(?:\s|$)/.exec(chunk);
	if (percent) return { percent: Math.max(0, Math.min(100, Number(percent[1]))) };
	return undefined;
}

function publicSnapshot(record: BackgroundJobRecord): BackgroundJobSnapshot {
	const {
		output: _output,
		process: _process,
		waiters: _waiters,
		notifiedFinish: _notifiedFinish,
		...snapshot
	} = record;
	const end = snapshot.finishedAt ? Date.parse(snapshot.finishedAt) : Date.now();
	return {
		...snapshot,
		elapsedMs: Math.max(0, end - Date.parse(snapshot.startedAt)),
		progress: snapshot.progress ? { ...snapshot.progress } : undefined,
	};
}

export class BackgroundJobManager {
	private readonly jobsDir: string;
	private readonly cwd: string;
	private readonly shellPath?: string;
	private readonly maxOutputBytes: number;
	private processWrapper?: BackgroundJobManagerOptions["processWrapper"];
	private readonly onFinish?: BackgroundJobManagerOptions["onFinish"];
	private readonly records = new Map<string, BackgroundJobRecord>();
	private disposed = false;

	constructor(options: BackgroundJobManagerOptions) {
		this.jobsDir = join(options.artifactDir, "jobs");
		this.cwd = resolve(options.cwd);
		this.shellPath = options.shellPath;
		this.maxOutputBytes = Math.max(4096, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
		this.processWrapper = options.processWrapper;
		this.onFinish = options.onFinish;
		mkdirSync(this.jobsDir, { recursive: true });
		this.restoreMetadata();
	}

	start(command: string, options: StartBackgroundJobOptions = {}): BackgroundJobSnapshot {
		if (this.disposed) throw new Error("Background job manager is disposed");
		if (typeof command !== "string" || !command.trim()) throw new Error("Background job command must not be empty");
		const cwd = resolve(options.cwd ?? this.cwd);
		if (!existsSync(cwd)) throw new Error(`Background job cwd does not exist: ${cwd}`);
		const id = `job-${randomUUID().slice(0, 8)}`;
		const shell = getShellConfig(this.shellPath);
		const processCommand = this.processWrapper?.(shell.shell, [...shell.args, command]) ?? {
			command: shell.shell,
			args: [...shell.args, command],
		};
		const child = spawn(processCommand.command, processCommand.args, {
			cwd,
			env: { ...getShellEnv(), ...options.env },
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const record: BackgroundJobRecord = {
			id,
			command,
			cwd,
			status: "running",
			pid: child.pid,
			startedAt: new Date().toISOString(),
			revision: 1,
			detached: options.detached === true,
			outputBytes: 0,
			output: "",
			process: child,
			waiters: new Set(),
		};
		this.records.set(id, record);
		this.persist(record);
		child.stdout.on("data", (data: Buffer) => this.append(record, data.toString("utf8")));
		child.stderr.on("data", (data: Buffer) => this.append(record, data.toString("utf8")));
		child.on("error", (error) => {
			this.append(record, `${error.message}\n`);
			this.finish(record, "failed");
		});
		child.on("exit", (code, signal) => {
			record.exitCode = code ?? undefined;
			record.signal = signal ?? undefined;
			this.finish(record, code === 0 ? "completed" : record.status === "cancelled" ? "cancelled" : "failed");
		});
		return publicSnapshot(record);
	}

	list(): BackgroundJobSnapshot[] {
		for (const record of this.records.values()) this.refreshOrphan(record);
		return [...this.records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(publicSnapshot);
	}

	setProcessWrapper(processWrapper: BackgroundJobManagerOptions["processWrapper"]): void {
		this.processWrapper = processWrapper;
	}

	get(id: string): BackgroundJobSnapshot {
		const record = this.require(id);
		this.refreshOrphan(record);
		return publicSnapshot(record);
	}

	tail(id: string, maxChars = 16_000): string {
		const record = this.require(id);
		const bounded = Math.max(0, Math.min(this.maxOutputBytes, maxChars));
		return bounded === 0 ? "" : record.output.slice(-bounded);
	}

	write(id: string, input: string): BackgroundJobSnapshot {
		const record = this.require(id);
		if (record.status !== "running" || !record.process?.stdin.writable) {
			throw new Error(`Background job ${id} is not accepting input`);
		}
		record.process.stdin.write(input);
		return publicSnapshot(record);
	}

	cancel(id: string): BackgroundJobSnapshot {
		const record = this.require(id);
		if (!isTerminal(record.status)) {
			record.status = "cancelled";
			record.finishedAt = new Date().toISOString();
			record.revision++;
			if (record.pid) killProcessTree(record.pid);
			this.persist(record);
			this.wake(record);
		}
		return publicSnapshot(record);
	}

	async wait(
		id: string,
		sinceRevision?: number,
		timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
	): Promise<BackgroundJobWaitResult> {
		const record = this.require(id);
		this.refreshOrphan(record);
		const baseline = sinceRevision ?? record.revision;
		if (isTerminal(record.status) || record.revision > baseline) {
			return { job: publicSnapshot(record), changed: record.revision > baseline, timedOut: false };
		}
		const boundedTimeout = Math.max(0, Math.min(MAX_WAIT_TIMEOUT_MS, timeoutMs));
		let timedOut = false;
		await new Promise<void>((resolveWait) => {
			const wake = () => {
				clearTimeout(timer);
				clearInterval(orphanPoll);
				record.waiters.delete(wake);
				resolveWait();
			};
			const timer = setTimeout(() => {
				timedOut = true;
				wake();
			}, boundedTimeout);
			const orphanPoll = setInterval(() => this.refreshOrphan(record), 250);
			orphanPoll.unref();
			record.waiters.add(wake);
		});
		this.refreshOrphan(record);
		return { job: publicSnapshot(record), changed: record.revision > baseline, timedOut };
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const record of this.records.values()) {
			if (record.status === "running" && !record.detached) this.cancel(record.id);
		}
	}

	private append(record: BackgroundJobRecord, raw: string): void {
		if (isTerminal(record.status)) return;
		const chunk = sanitizeBinaryOutput(raw);
		record.output = `${record.output}${chunk}`;
		if (Buffer.byteLength(record.output, "utf8") > this.maxOutputBytes) {
			record.output = record.output.slice(-this.maxOutputBytes);
		}
		record.outputBytes = Buffer.byteLength(record.output, "utf8");
		const progress = parseProgress(chunk);
		if (progress) record.progress = progress;
		record.revision++;
		this.persist(record);
		this.wake(record);
	}

	private finish(record: BackgroundJobRecord, status: BackgroundJobStatus): void {
		if (isTerminal(record.status) && record.status !== "cancelled") return;
		record.status = record.status === "cancelled" ? "cancelled" : status;
		record.finishedAt ??= new Date().toISOString();
		record.process = undefined;
		record.revision++;
		this.persist(record);
		this.wake(record);
		this.notifyFinish(record);
	}

	private notifyFinish(record: BackgroundJobRecord): void {
		if (record.notifiedFinish || this.disposed) return;
		record.notifiedFinish = true;
		this.onFinish?.(publicSnapshot(record));
	}

	private wake(record: BackgroundJobRecord): void {
		for (const wake of [...record.waiters]) wake();
	}

	private require(id: string): BackgroundJobRecord {
		const record = this.records.get(id);
		if (!record) throw new Error(`Unknown background job: ${id}`);
		return record;
	}

	private metadataPath(id: string): string {
		return join(this.jobsDir, `${id}.json`);
	}

	private outputPath(id: string): string {
		return join(this.jobsDir, `${id}.log`);
	}

	private persist(record: BackgroundJobRecord): void {
		writeFileSync(this.metadataPath(record.id), `${JSON.stringify(publicSnapshot(record), null, 2)}\n`, "utf8");
		writeFileSync(this.outputPath(record.id), record.output, "utf8");
	}

	private restoreMetadata(): void {
		for (const file of readdirSync(this.jobsDir)) {
			if (!file.startsWith("job-") || !file.endsWith(".json")) continue;
			try {
				const snapshot = JSON.parse(readFileSync(join(this.jobsDir, file), "utf8")) as BackgroundJobSnapshot;
				if (!snapshot.id || !snapshot.command || !snapshot.cwd || !snapshot.startedAt) continue;
				const outputPath = this.outputPath(snapshot.id);
				const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8").slice(-this.maxOutputBytes) : "";
				const status = snapshot.status === "running" ? "orphaned" : snapshot.status;
				this.records.set(snapshot.id, {
					...snapshot,
					status,
					output,
					outputBytes: Buffer.byteLength(output, "utf8"),
					waiters: new Set(),
				});
			} catch {
				// A corrupt job record is isolated to that job.
			}
		}
	}

	private refreshOrphan(record: BackgroundJobRecord): void {
		if (record.status !== "orphaned" || processIsAlive(record.pid)) return;
		record.status = "failed";
		record.finishedAt ??= new Date().toISOString();
		record.revision++;
		this.persist(record);
		this.wake(record);
		this.notifyFinish(record);
	}
}

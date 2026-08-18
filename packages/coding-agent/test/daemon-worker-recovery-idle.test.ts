import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";
import { WorkerRecoveryJournal } from "../src/modes/daemon/worker-recovery-journal.js";
import { rmTempDir, testSocketPath } from "./utilities.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();
const daemonSockets = new Set<string>();
const SLOW_PLATFORM_FACTOR = process.platform === "win32" ? 3 : 1;
const childDiagnostics = new WeakMap<ChildProcess, { stdout: string; stderr: string }>();

afterEach(async () => {
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.request({ type: "shutdown" }, 2000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) {
		rmTempDir(directory);
	}
});

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-worker-recovery-idle-"));
	tempDirs.push(directory);
	return directory;
}

function supervisorEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		[ENV_AGENT_DIR]: agentDir,
		TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
	};
	// Running the suite inside a Prometheus session inherits that session's
	// worker role, which would start this supervisor as a worker daemon.
	for (const name of Object.keys(environment)) {
		if (name.startsWith("PROMETHEUS_INTERNAL_")) {
			delete environment[name];
		}
	}
	return environment;
}

function spawnSupervisor(agentDir: string, socketPath: string, cwd: string): ChildProcess {
	daemonSockets.add(socketPath);
	const child = spawn(process.execPath, [tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath], {
		cwd,
		env: supervisorEnvironment(agentDir),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	const diagnostics = { stdout: "", stderr: "" };
	childDiagnostics.set(child, diagnostics);
	child.stdout?.on("data", (chunk: Buffer) => {
		diagnostics.stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		diagnostics.stderr += chunk.toString("utf8");
	});
	return child;
}

async function connectEventually(socketPath: string, child: ChildProcess): Promise<DaemonClient> {
	const deadline = Date.now() + 15_000 * SLOW_PLATFORM_FACTOR;
	let lastError: unknown;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new Error(`Supervisor exited before becoming ready (code ${child.exitCode})`);
		}
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(250);
			await client.waitForHello(1000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	const diagnostics = childDiagnostics.get(child);
	throw new Error(
		`Could not connect to the supervisor: ${String(lastError)}\n` +
			`stdout:\n${diagnostics?.stdout ?? ""}\nstderr:\n${diagnostics?.stderr ?? ""}`,
	);
}

function requireSummary(responseData: unknown): SessionSummary {
	if (!responseData || typeof responseData !== "object") {
		throw new Error("Missing daemon session summary");
	}
	return responseData as SessionSummary;
}

function readWorkerDescriptor(agentDir: string): DaemonWorkerDescriptor {
	const workersRoot = join(agentDir, "daemon-workers");
	for (const directory of readdirSync(workersRoot)) {
		const descriptorDirectory = join(workersRoot, directory);
		for (const name of readdirSync(descriptorDirectory)) {
			if (name.endsWith(".json")) {
				return JSON.parse(readFileSync(join(descriptorDirectory, name), "utf8")) as DaemonWorkerDescriptor;
			}
		}
	}
	throw new Error("Worker descriptor was not persisted");
}

async function waitForProcessGone(pid: number): Promise<void> {
	const deadline = Date.now() + (process.platform === "win32" ? 45_000 : 10_000);
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") {
				return;
			}
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Worker ${pid} remained alive after daemon shutdown`);
}

async function waitForCondition(predicate: () => boolean, failureMessage: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(failureMessage);
}

/**
 * A local OpenAI-compatible endpoint, so a worker process can run a real turn
 * without a provider account. It answers one short streamed completion.
 */
async function startFakeModelServer(): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createServer((request, response) => {
		if (request.method === "GET") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "fake-1" }] }));
			return;
		}
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
			const chunk = (delta: object, finishReason: string | null) =>
				`data: ${JSON.stringify({
					id: "chatcmpl-fake",
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "fake-1",
					choices: [{ index: 0, delta, finish_reason: finishReason }],
				})}\n\n`;
			response.write(chunk({ role: "assistant", content: "" }, null));
			response.write(chunk({ content: "hello" }, null));
			response.write(chunk({}, "stop"));
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Fake model server did not bind a port");
	}
	return {
		port: address.port,
		close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
	};
}

function writeFakeProviderExtension(agentDir: string, port: number): void {
	const extensionsDir = join(agentDir, "extensions");
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(
		join(extensionsDir, "fake-provider.ts"),
		`export default function (pi: { registerProvider: (id: string, config: unknown) => void }) {
	pi.registerProvider("localfake", {
		name: "Local Fake",
		baseUrl: "http://127.0.0.1:${port}/v1",
		apiKey: "sk-fake",
		api: "openai-completions",
		models: [
			{
				id: "fake-1",
				name: "Fake",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
}
`,
		"utf8",
	);
}

describe("worker recovery checkpoints", () => {
	it("settles the journal to idle after the work a session was doing ends", { timeout: 90_000 }, async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionDir = join(agentDir, "sessions");
		const socketPath = testSocketPath(
			join(tmpdir(), `prime-recovery-idle-${process.pid}-${randomUUID().slice(0, 8)}.sock`),
		);
		mkdirSync(projectDir, { recursive: true });
		const { port, close: closeModelServer } = await startFakeModelServer();
		writeFakeProviderExtension(agentDir, port);
		const sessionManager = SessionManager.create(projectDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "recovery journal fixture", timestamp: 1 });
		sessionManager.flushNow();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Fixture session was not materialized");
		}

		const supervisor = spawnSupervisor(agentDir, socketPath, projectDir);
		const client = await connectEventually(socketPath, supervisor);
		const created = await client.request({
			type: "create",
			sessionPath: sessionFile,
			config: {
				cwd: projectDir,
				agentDir,
				sessionDir,
				noTools: true,
				provider: "localfake",
				model: "fake-1",
			},
		});
		expect(created.success).toBe(true);
		const summary = requireSummary(created.success ? created.data : undefined);
		const activeSessionId = summary.activeSessionId ?? summary.id;

		const prompted = await client.request({ type: "prompt", activeSessionId, message: "say hello" }, 30_000);
		expect(prompted.success).toBe(true);

		const descriptor = readWorkerDescriptor(agentDir);
		const journalPath = descriptor.recoveryJournalPath;
		if (!journalPath) {
			throw new Error("Worker did not persist its recovery journal path");
		}
		await waitForCondition(
			() => readFileSync(journalPath, "utf8").includes('"operation":"agent_end"'),
			"Worker never checkpointed the end of the turn",
		);
		// The events that end a run fire while its teardown is still unwinding,
		// so the journal has to converge on the settled state afterwards.
		await waitForCondition(
			() => WorkerRecoveryJournal.readLatest(journalPath).every((record) => !record.busy),
			"Recovery journal kept an idle session marked busy",
		);

		// Leave nothing holding the temp workspace open for the cleanup below.
		await client.request({ type: "shutdown" }, 5000).catch(() => undefined);
		client.close();
		if (summary.workerPid) {
			await waitForProcessGone(summary.workerPid);
		}
		await closeModelServer();
	});
});

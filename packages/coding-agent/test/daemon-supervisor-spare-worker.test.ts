import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SpawnedFixture {
	child: { exitCode: null | number; signalCode: null | string; unref: ReturnType<typeof vi.fn> };
	childClosed: Promise<void>;
	startupGate: { destroy: ReturnType<typeof vi.fn> };
	workerId: string;
	cwd?: string;
}

interface SupervisorInternals {
	spareWorker?: SpawnedFixture & { cwd: string };
	shuttingDown: boolean;
	updateRestartPhase?: string;
	log: ReturnType<typeof vi.fn>;
	spawnWorkerProcess(cwd: string, launchEnv?: Record<string, string>): SpawnedFixture;
	primeSpareWorker(cwd: string): void;
	takeSpareWorker(cwd: string): (SpawnedFixture & { cwd: string }) | undefined;
	discardSpareWorker(): void;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A supervisor whose spawn is replaced by a record of what it was asked for. */
function makeSupervisor(): { supervisor: SupervisorInternals; spawned: SpawnedFixture[] } {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-spare-"));
	tempDirs.push(directory);
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.log = vi.fn();
	const spawned: SpawnedFixture[] = [];
	supervisor.spawnWorkerProcess = vi.fn((cwd: string) => {
		const fixture: SpawnedFixture = {
			child: { exitCode: null, signalCode: null, unref: vi.fn() },
			childClosed: new Promise<void>(() => {}),
			startupGate: { destroy: vi.fn() },
			workerId: `worker-${spawned.length}`,
			cwd,
		};
		spawned.push(fixture);
		return fixture;
	});
	return { supervisor, spawned };
}

describe("daemon supervisor spare worker", () => {
	it("hands the primed process to a create in the same directory, once", () => {
		const { supervisor, spawned } = makeSupervisor();

		supervisor.primeSpareWorker("/tmp/project");
		expect(spawned).toHaveLength(1);
		// A spare must never hold the supervisor's event loop open.
		expect(spawned[0]?.child.unref).toHaveBeenCalled();

		const claimed = supervisor.takeSpareWorker("/tmp/project");
		expect(claimed?.workerId).toBe("worker-0");
		expect(supervisor.takeSpareWorker("/tmp/project")).toBeUndefined();
	});

	it("does not hand a spare to a create in a different directory", () => {
		const { supervisor } = makeSupervisor();

		supervisor.primeSpareWorker("/tmp/project");

		expect(supervisor.takeSpareWorker("/tmp/other")).toBeUndefined();
		// The claim attempt must not have consumed it either.
		expect(supervisor.takeSpareWorker("/tmp/project")?.workerId).toBe("worker-0");
	});

	it("holds only one spare, replacing it when the directory changes", () => {
		const { supervisor, spawned } = makeSupervisor();

		supervisor.primeSpareWorker("/tmp/project");
		supervisor.primeSpareWorker("/tmp/project");
		expect(spawned).toHaveLength(1);

		supervisor.primeSpareWorker("/tmp/other");
		expect(spawned).toHaveLength(2);
		// Cancelled by closing its gate without the commit marker.
		expect(spawned[0]?.startupGate.destroy).toHaveBeenCalled();
		expect(supervisor.spareWorker?.workerId).toBe("worker-1");
	});

	it("refuses a spare that died while it waited", () => {
		const { supervisor, spawned } = makeSupervisor();

		supervisor.primeSpareWorker("/tmp/project");
		const fixture = spawned[0];
		if (!fixture) throw new Error("expected a spawned spare");
		fixture.child.exitCode = 1;

		expect(supervisor.takeSpareWorker("/tmp/project")).toBeUndefined();
	});

	it("primes nothing while shutting down or preparing an update restart", () => {
		const { supervisor, spawned } = makeSupervisor();

		supervisor.shuttingDown = true;
		supervisor.primeSpareWorker("/tmp/project");
		supervisor.shuttingDown = false;
		supervisor.updateRestartPhase = "draining";
		supervisor.primeSpareWorker("/tmp/project");

		expect(spawned).toHaveLength(0);
	});

	it("cancels the spare on discard", () => {
		const { supervisor, spawned } = makeSupervisor();

		supervisor.primeSpareWorker("/tmp/project");
		supervisor.discardSpareWorker();

		expect(spawned[0]?.startupGate.destroy).toHaveBeenCalled();
		expect(supervisor.spareWorker).toBeUndefined();
		// Discarding twice is a no-op, not a second destroy on a released handle.
		supervisor.discardSpareWorker();
		expect(spawned[0]?.startupGate.destroy).toHaveBeenCalledTimes(1);
	});
});

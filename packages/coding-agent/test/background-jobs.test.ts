import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundJobManager } from "../src/core/background-jobs.js";

const managers: BackgroundJobManager[] = [];

function createManager(maxOutputBytes?: number): BackgroundJobManager {
	const root = mkdtempSync(join(tmpdir(), "prime-background-jobs-"));
	const manager = new BackgroundJobManager({ artifactDir: root, cwd: root, maxOutputBytes });
	managers.push(manager);
	return manager;
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

describe("BackgroundJobManager", () => {
	it("starts, tails, waits for, and persists a command", async () => {
		const manager = createManager();
		const started = manager.start("printf 'PROMETHEUS_PROGRESS {\"percent\":25}\n'; sleep 0.05; printf 'done\n'");
		const changed = await manager.wait(started.id, started.revision, 2_000);
		expect(changed.changed).toBe(true);

		let current = changed.job;
		while (current.status === "running") {
			current = (await manager.wait(current.id, current.revision, 2_000)).job;
		}
		expect(current.status).toBe("completed");
		expect(manager.tail(current.id)).toContain("done");
		expect(manager.get(current.id).progress?.percent).toBe(25);
	});

	it("bounds output in memory and on disk", async () => {
		const manager = createManager(4096);
		const started = manager.start("for i in $(seq 1 800); do printf '0123456789'; done");
		let current = started;
		while (current.status === "running") {
			current = (await manager.wait(current.id, current.revision, 2_000)).job;
		}
		const tail = manager.tail(current.id, 10_000);
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(4096);
		const metadataPath = join((manager as unknown as { jobsDir: string }).jobsDir, `${current.id}.log`);
		expect(Buffer.byteLength(readFileSync(metadataPath, "utf8"))).toBeLessThanOrEqual(4096);
	});

	it("cancels owned jobs on disposal", async () => {
		const manager = createManager();
		const started = manager.start("sleep 10");
		await manager.dispose();
		expect(manager.get(started.id).status).toBe("cancelled");
	});
});

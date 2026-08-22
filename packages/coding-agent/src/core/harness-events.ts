import { appendFileSync, chmodSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 1_000;

export type HarnessEvent =
	| { type: "prompt_exposure"; entryIds: string[] }
	| { type: "auto_refine_review"; trigger: string; shouldRefine: boolean }
	| { type: "refinement"; refinementId: string; appliedIds: string[]; failedIds: string[]; rollbackOf?: string }
	| { type: "dropped_events"; count: number };

export class HarnessEventWriter {
	private readonly path: string;
	private readonly rotatedPath: string;
	private queue: HarnessEvent[] = [];
	private scheduled = false;
	private droppedEvents = 0;

	constructor(sessionDir: string) {
		this.path = join(sessionDir, "harness-events.jsonl");
		this.rotatedPath = `${this.path}.1`;
	}

	enqueue(event: HarnessEvent): void {
		if (this.queue.length >= MAX_QUEUED_EVENTS) {
			this.droppedEvents++;
			return;
		}
		this.queue.push(event);
		if (this.scheduled) return;
		this.scheduled = true;
		setImmediate(() => this.flush());
	}

	flush(): void {
		this.scheduled = false;
		if (this.queue.length === 0 && this.droppedEvents === 0) return;
		const events = this.queue.splice(0);
		if (this.droppedEvents > 0) {
			events.unshift({ type: "dropped_events", count: this.droppedEvents });
			this.droppedEvents = 0;
		}
		try {
			const payload = `${events
				.map((event) => JSON.stringify({ timestamp: new Date().toISOString(), ...event }))
				.join("\n")}\n`;
			if (existsSync(this.path) && statSync(this.path).size + Buffer.byteLength(payload) > MAX_EVENT_FILE_BYTES) {
				if (existsSync(this.rotatedPath)) unlinkSync(this.rotatedPath);
				renameSync(this.path, this.rotatedPath);
			}
			appendFileSync(this.path, payload, { encoding: "utf8", mode: 0o600 });
			if (process.platform !== "win32") chmodSync(this.path, 0o600);
		} catch {
			// Harness observability must never block or fail the agent session.
		}
	}
}

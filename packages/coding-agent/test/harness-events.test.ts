import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessEventWriter } from "../src/core/harness-events.js";

let directory: string | undefined;

afterEach(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
});

describe("local harness events", () => {
	it("writes identifiers without harness content", () => {
		directory = mkdtempSync(join(tmpdir(), "prometheus-harness-events-"));
		const writer = new HarnessEventWriter(directory);
		writer.enqueue({ type: "prompt_exposure", entryIds: ["local:memory_id"] });
		writer.flush();

		const text = readFileSync(join(directory, "harness-events.jsonl"), "utf8");
		expect(text).toContain("local:memory_id");
		expect(text).not.toContain("entry body");
	});
});

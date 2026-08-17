import { readFileSync, rmSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";

describe("OutputAccumulator head and tail retention", () => {
	it("keeps UTF-8-safe ends and spills the complete raw channel", async () => {
		const raw = `${"α".repeat(80)}\nmiddle\n${"終".repeat(100)}`;
		const output = new OutputAccumulator({ maxBytes: 120, tempFilePrefix: "prometheus-kernel-stdout" });
		const bytes = Buffer.from(raw, "utf8");
		for (let offset = 0; offset < bytes.length; offset += 7) {
			output.append(bytes.subarray(offset, offset + 7));
		}
		output.finish();
		const snapshot = output.snapshotHeadTail({ persistIfTruncated: true });
		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.content).toContain("middle removed");
		expect(snapshot.content).toMatch(/^α+/);
		expect(snapshot.content).toMatch(/終+$/);
		expect(Buffer.byteLength(snapshot.content, "utf8")).toBeLessThanOrEqual(120);
		expect(snapshot.fullOutputPath).toBeDefined();
		await output.closeTempFile();
		const spillPath = snapshot.fullOutputPath as string;
		try {
			expect(readFileSync(spillPath, "utf8")).toBe(raw);
			if (process.platform !== "win32") expect(statSync(spillPath).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(spillPath, { force: true });
		}
	});

	it("does not create a spill file for small output", async () => {
		const output = new OutputAccumulator({ maxBytes: 120, tempFilePrefix: "prometheus-kernel-stdout" });
		output.append(Buffer.from("small", "utf8"));
		output.finish();
		const snapshot = output.snapshotHeadTail({ persistIfTruncated: true });
		expect(snapshot).toMatchObject({ content: "small", fullOutputPath: undefined });
		await output.closeTempFile();
	});
});

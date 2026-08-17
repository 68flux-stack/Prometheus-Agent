import { describe, expect, it } from "vitest";
import { truncateHeadTail } from "../src/core/tools/truncate.js";

describe("head and tail truncation", () => {
	it("keeps setup context and the final exception", () => {
		const content = `setup:${"x".repeat(400)}\nRuntimeError: final failure`;
		const result = truncateHeadTail(content, { maxBytes: 160, maxLines: Number.MAX_SAFE_INTEGER });

		expect(result.truncated).toBe(true);
		expect(result.content).toContain("setup:");
		expect(result.content).toContain("RuntimeError: final failure");
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(160);
	});

	it("does not split multibyte characters", () => {
		const result = truncateHeadTail(`${"開始".repeat(100)}終了`, {
			maxBytes: 101,
			maxLines: Number.MAX_SAFE_INTEGER,
		});
		expect(result.content).not.toContain("�");
		expect(result.content).toContain("終了");
	});
});

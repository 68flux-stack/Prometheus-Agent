import { describe, expect, it } from "vitest";
import { RlmTreeLimitCoordinator } from "../src/core/rlm-child-limits.js";

function coordinator(overrides: Partial<ConstructorParameters<typeof RlmTreeLimitCoordinator>[0]> = {}) {
	return new RlmTreeLimitCoordinator({
		maxChildren: 2,
		maxConcurrentChildren: 1,
		cancelChildrenOnBudgetExceeded: false,
		...overrides,
	});
}

describe("RLM root-tree child limits", () => {
	it("rejects concurrent admission and releases capacity exactly once", () => {
		const limits = coordinator();
		const release = limits.admit();
		expect(() => limits.admit()).toThrow("concurrent child limit");
		release(true);
		release(true);
		expect(limits.status()).toMatchObject({ totalChildren: 1, concurrentChildren: 0 });
	});

	it("rolls back total admission when startup fails", () => {
		const limits = coordinator();
		limits.admit()(false);
		expect(limits.status()).toMatchObject({ totalChildren: 0, concurrentChildren: 0 });
	});

	it("stops new admissions after the optional cost threshold", () => {
		const limits = coordinator({ childBudgetUsd: 1 });
		expect(limits.attributeCost(1.25)).toBe(true);
		expect(() => limits.admit()).toThrow("cost threshold");
	});

	it("shares totals across nested descendants and reconstructs lifetime state", () => {
		const limits = new RlmTreeLimitCoordinator(
			{ maxChildren: 3, maxConcurrentChildren: 2, cancelChildrenOnBudgetExceeded: false },
			{ totalChildren: 1, childCostUsd: 0.25 },
		);
		const releaseChild = limits.admit();
		const releaseGrandchild = limits.admit();
		expect(limits.status()).toMatchObject({ totalChildren: 3, concurrentChildren: 2, childCostUsd: 0.25 });
		expect(() => limits.admit()).toThrow("child limit");
		releaseGrandchild(true);
		releaseChild(true);
		expect(limits.status().concurrentChildren).toBe(0);
	});
});

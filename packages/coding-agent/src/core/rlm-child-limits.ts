export interface RlmChildLimitConfig {
	maxChildren: number;
	maxConcurrentChildren: number;
	childBudgetUsd?: number;
	cancelChildrenOnBudgetExceeded: boolean;
}

export interface RlmChildLimitStatus extends RlmChildLimitConfig {
	totalChildren: number;
	concurrentChildren: number;
	childCostUsd: number;
}

export class RlmTreeLimitCoordinator {
	private totalChildren = 0;
	private concurrentChildren = 0;
	private childCostUsd = 0;

	constructor(
		private config: RlmChildLimitConfig,
		initial?: Pick<RlmChildLimitStatus, "totalChildren" | "childCostUsd">,
		private readonly onChange?: (status: RlmChildLimitStatus) => void,
	) {
		this.totalChildren = initial?.totalChildren ?? 0;
		this.childCostUsd = initial?.childCostUsd ?? 0;
	}

	update(config: RlmChildLimitConfig): void {
		this.config = config;
		this.notify();
	}

	admit(): (committed?: boolean) => void {
		if (this.totalChildren >= this.config.maxChildren) {
			throw new Error(
				`RLM child limit reached (${this.totalChildren}/${this.config.maxChildren} descendants admitted)`,
			);
		}
		if (this.concurrentChildren >= this.config.maxConcurrentChildren) {
			throw new Error(
				`RLM concurrent child limit reached (${this.concurrentChildren}/${this.config.maxConcurrentChildren} descendants running)`,
			);
		}
		if (this.config.childBudgetUsd !== undefined && this.childCostUsd >= this.config.childBudgetUsd) {
			throw new Error(
				`RLM child cost threshold reached ($${this.childCostUsd.toFixed(4)}/$${this.config.childBudgetUsd.toFixed(4)})`,
			);
		}
		this.totalChildren++;
		this.concurrentChildren++;
		this.notify();
		let released = false;
		return (committed = true) => {
			if (released) return;
			released = true;
			this.concurrentChildren = Math.max(0, this.concurrentChildren - 1);
			if (!committed) this.totalChildren = Math.max(0, this.totalChildren - 1);
			this.notify();
		};
	}

	attributeCost(costUsd: number): boolean {
		if (Number.isFinite(costUsd) && costUsd > 0) this.childCostUsd += costUsd;
		this.notify();
		return this.config.childBudgetUsd !== undefined && this.childCostUsd >= this.config.childBudgetUsd;
	}

	status(): RlmChildLimitStatus {
		return {
			...this.config,
			totalChildren: this.totalChildren,
			concurrentChildren: this.concurrentChildren,
			childCostUsd: this.childCostUsd,
		};
	}

	private notify(): void {
		try {
			this.onChange?.(this.status());
		} catch {
			// Limit enforcement remains active when persistence is temporarily unavailable.
		}
	}
}

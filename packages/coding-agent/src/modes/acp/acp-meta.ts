/**
 * Namespaced `_meta` payloads for prometheus capabilities that ACP has no
 * native concept for (IPython cell semantics, RLM subagents, autonomous gates,
 * goals, heartbeats, continual harness state).
 *
 * ACP reserves `_meta` on capability objects, notifications, tool calls, and
 * content blocks precisely so agents can carry non-standard data. Vanilla ACP
 * clients ignore these keys; a prometheus-aware client (or the verifiers
 * harness) reads them. Never add non-standard fields to an ACP object root.
 */

/** Reverse-domain namespace for every prometheus `_meta` payload. */
export const PROMETHEUS_META_NAMESPACE = "ai.primeintellect.prometheus";

export interface PrometheusSubagentMeta {
	id: string;
	sessionName?: string;
	status: string;
	model?: string;
	depth?: number;
	tokenCount?: number;
	error?: string;
}

export interface PrometheusAutonomousMeta {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	gateAttempt?: number;
	gateFailure?: string;
	limitReason?: string;
}

export interface PrometheusIpythonAttachmentMeta {
	mimeType?: string;
	path?: string;
	bytes?: number;
}

export interface PrometheusIpythonMeta {
	/** Media the cell loaded into context, as reported by the ipython tool. */
	attachments?: PrometheusIpythonAttachmentMeta[];
	/** Number of diffs the cell displayed. */
	diffCount?: number;
}

export interface PrometheusGoalMeta {
	status: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed?: number;
}

export interface PrometheusRefinementMeta {
	status: "complete" | "failed";
	summary?: string;
	changes?: string[];
	error?: string;
}

export interface PrometheusAgentMessageMeta {
	toolCallId: string;
	target?: string;
	deliveryStatus?: string;
}

export interface PrometheusCwdMeta {
	/** The cwd the client asked for. */
	requested: string;
	/** The cwd prometheus is actually running in, fixed at startup. */
	actual: string;
}

export interface PrometheusSessionMeta {
	/** Present when a client-requested cwd differs from the agent's real cwd. */
	cwd?: PrometheusCwdMeta;
	/** Set when the session's heartbeat or cron schedule changed. */
	heartbeatsChanged?: boolean;
	goal?: PrometheusGoalMeta;
	refinement?: PrometheusRefinementMeta;
	agentMessage?: PrometheusAgentMessageMeta;
	sessionId?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	compaction?: { tokensBefore?: number; summary?: string };
	subagents?: PrometheusSubagentMeta[];
	autonomous?: PrometheusAutonomousMeta;
	ipython?: PrometheusIpythonMeta;
}

/** Wrap a prometheus payload in its reverse-domain `_meta` envelope. */
export function prometheusMeta(payload: PrometheusSessionMeta): Record<string, unknown> {
	return { [PROMETHEUS_META_NAMESPACE]: payload };
}

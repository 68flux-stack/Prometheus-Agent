/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSessionMessageReceipt, AgentSessionMessageSafetyStatus } from "../../core/agent-messages.js";
import type { BackgroundJobWaitResult } from "../../core/background-jobs.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { ExecutionMode } from "../../core/execution-policy.js";
import type { GoalState } from "../../core/goals.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { RlmMaxDepthStatus, SetRlmMaxDepthResult } from "../../core/rlm-max-depth.js";
import type { SessionActionSnapshot } from "../../core/session-action-store.js";
import type { SessionStats } from "../../core/session-stats.js";
import type { TodoListState } from "../../core/todo.js";
import type {
	AgentConnectionHeartbeat,
	AgentConnectionPluginDetail,
	AgentConnectionPluginList,
	AgentConnectionResourceSnapshot,
	AgentConnectionRuntimeFeatures,
	AgentConnectionSourceInfo,
} from "../agent-connection/types.js";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_runtime_features" }
	| { id?: string; type: "set_execution_mode"; mode: ExecutionMode }
	| { id?: string; type: "start_background_job"; command: string }
	| { id?: string; type: "tail_background_job"; jobId: string; maxChars?: number }
	| { id?: string; type: "wait_background_job"; jobId: string; sinceRevision: number; timeoutMs?: number }
	| { id?: string; type: "write_background_job"; jobId: string; input: string }
	| { id?: string; type: "cancel_background_job"; jobId: string }
	| { id?: string; type: "apply_subagent_worktree"; worktreeId: string }
	| { id?: string; type: "discard_subagent_worktree"; worktreeId: string }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "get_resource_snapshot" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "refine"; instructions?: string; rollbackId?: string; global?: boolean }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "get_system_prompt" }
	| { id?: string; type: "get_changelog" }
	| { id?: string; type: "get_logs_info" }
	| { id?: string; type: "get_rlm_max_depth" }
	| { id?: string; type: "set_rlm_max_depth"; maxDepth: number; global?: boolean }
	| { id?: string; type: "set_service_tier"; serviceTier: ServiceTier }
	| { id?: string; type: "import_session"; path: string; cwd?: string }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	// Like switch_session, but leaves the session being left running.
	| { id?: string; type: "open_session"; sessionPath: string }
	// Session files whose agent is working, including ones this client is not attached to.
	| { id?: string; type: "list_busy_sessions" }
	| { id?: string; type: "fork"; entryId: string; position?: "before" | "at" }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| {
			id?: string;
			type: "send_message";
			targetActiveSessionId: string;
			message: string;
	  }
	| { id?: string; type: "agent_messages_status" }
	| { id?: string; type: "agent_messages_pause" }
	| { id?: string; type: "agent_messages_resume" }
	| { id?: string; type: "agent_messages_clear" }

	// Scheduling
	| { id?: string; type: "list_schedules"; includeInactive?: boolean }
	| { id?: string; type: "add_schedule"; schedule: string; prompt: string }
	| { id?: string; type: "cancel_schedule"; jobId: string }
	| { id?: string; type: "list_heartbeats" }
	| { id?: string; type: "get_heartbeat" }
	| {
			id?: string;
			type: "set_heartbeat";
			schedule: string;
			prompt: string;
			deliveryMode?: AgentHeartbeatDeliveryMode;
	  }
	| { id?: string; type: "update_heartbeat"; action: AgentHeartbeatUpdateAction }
	| {
			id?: string;
			type: "manage_heartbeat";
			activeSessionId: string;
			jobId: string;
			action: AgentHeartbeatManagementAction;
	  }

	// Active session and subagent observation
	| { id?: string; type: "observe"; activeSessionId: string }
	| { id?: string; type: "unobserve"; activeSessionId: string }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Plugin / package management (capability-gated by the pluginManagement
	// runtime feature; daemon-backed connections reject these)
	| { id?: string; type: "plugin_list" }
	| { id?: string; type: "plugin_details"; source: string }
	| { id?: string; type: "plugin_install"; spec: string; local?: boolean }
	| { id?: string; type: "plugin_remove"; spec: string; local?: boolean }
	| { id?: string; type: "plugin_update"; spec?: string }
	| { id?: string; type: "plugin_marketplace_add"; source: string; local?: boolean; name?: string }
	| { id?: string; type: "plugin_marketplace_remove"; nameOrSource: string; local?: boolean }
	| { id?: string; type: "plugin_marketplace_update"; name?: string }
	| { id?: string; type: "plugin_set_enabled"; source: string; enabled: boolean; local?: boolean }
	| { id?: string; type: "plugin_set_hook_enabled"; extensionPath: string; event: string; enabled: boolean }
	| { id?: string; type: "reload" };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill" | "builtin";
	/** Source metadata for the owning resource */
	sourceInfo: AgentConnectionSourceInfo;
	/**
	 * How the command runs. "session" commands are parsed from prompt text by
	 * agent-session and are safe to send through as a normal prompt. Undefined
	 * (or "client") builtin commands are handled by a UI client instead; a
	 * client with no handler for one must not silently forward it as a chat
	 * message. Only meaningful for source "builtin" — extension/prompt/skill
	 * commands are always sent through as prompt text.
	 */
	execution?: "client" | "session";
	/** Alternate names that resolve to this same command (e.g. "clear" for "new"). */
	aliases?: readonly string[];
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	/** Workspace the session actually runs in. Clients must not assume their own. */
	cwd: string;
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	sessionActions: SessionActionSnapshot;
	goal: GoalState;
	todo?: TodoListState;
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command:
				| "get_runtime_features"
				| "set_execution_mode"
				| "start_background_job"
				| "write_background_job"
				| "cancel_background_job"
				| "apply_subagent_worktree"
				| "discard_subagent_worktree";
			success: true;
			data: AgentConnectionRuntimeFeatures;
	  }
	| {
			id?: string;
			type: "response";
			command: "tail_background_job";
			success: true;
			data: { output: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "wait_background_job";
			success: true;
			data: BackgroundJobWaitResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_resource_snapshot";
			success: true;
			data: AgentConnectionResourceSnapshot;
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "refine"; success: true; data: RefinementResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| {
			id?: string;
			type: "response";
			command: "get_system_prompt";
			success: true;
			data: { systemPrompt: string };
	  }
	| { id?: string; type: "response"; command: "get_changelog"; success: true; data: { markdown: string } }
	| {
			id?: string;
			type: "response";
			command: "get_logs_info";
			success: true;
			data: { dir: string; files: { name: string; sizeBytes: number }[] };
	  }
	| { id?: string; type: "response"; command: "get_rlm_max_depth"; success: true; data: RlmMaxDepthStatus }
	| { id?: string; type: "response"; command: "set_rlm_max_depth"; success: true; data: SetRlmMaxDepthResult }
	| { id?: string; type: "response"; command: "set_service_tier"; success: true }
	| { id?: string; type: "response"; command: "import_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "open_session"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "list_busy_sessions";
			success: true;
			data: { sessionFiles: string[] };
	  }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text?: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "send_message"; success: true; data: AgentSessionMessageReceipt }
	| {
			id?: string;
			type: "response";
			command: "agent_messages_status" | "agent_messages_pause" | "agent_messages_resume";
			success: true;
			data: AgentSessionMessageSafetyStatus;
	  }
	| { id?: string; type: "response"; command: "agent_messages_clear"; success: true; data: { cleared: number } }

	// Scheduling
	| { id?: string; type: "response"; command: "list_schedules"; success: true; data: { jobs: AgentCronJob[] } }
	| { id?: string; type: "response"; command: "add_schedule"; success: true; data: { job: AgentCronJob } }
	| { id?: string; type: "response"; command: "cancel_schedule"; success: true; data: { job: AgentCronJob } }
	| {
			id?: string;
			type: "response";
			command: "list_heartbeats";
			success: true;
			data: { heartbeats: AgentConnectionHeartbeat[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_heartbeat";
			success: true;
			data: { heartbeat: AgentCronJob | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_heartbeat" | "update_heartbeat" | "manage_heartbeat";
			success: true;
			data: { heartbeat: AgentCronJob | null };
	  }

	// Active session and subagent observation
	| { id?: string; type: "response"; command: "observe"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "unobserve"; success: true }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Plugins / packages
	| { id?: string; type: "response"; command: "plugin_list"; success: true; data: AgentConnectionPluginList }
	| { id?: string; type: "response"; command: "plugin_details"; success: true; data: AgentConnectionPluginDetail }
	| {
			id?: string;
			type: "response";
			command: "plugin_install";
			success: true;
			data: { name: string; source: string };
	  }
	| { id?: string; type: "response"; command: "plugin_remove"; success: true }
	| { id?: string; type: "response"; command: "plugin_update"; success: true }
	| {
			id?: string;
			type: "response";
			command: "plugin_marketplace_add";
			success: true;
			data: { name: string; pluginCount: number };
	  }
	| { id?: string; type: "response"; command: "plugin_marketplace_remove"; success: true }
	| {
			id?: string;
			type: "response";
			command: "plugin_marketplace_update";
			success: true;
			data: { updated: string[] };
	  }
	| { id?: string; type: "response"; command: "plugin_set_enabled"; success: true }
	| { id?: string; type: "response"; command: "plugin_set_hook_enabled"; success: true }
	| { id?: string; type: "response"; command: "reload"; success: true }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

export type RpcObservedSessionEvent =
	| { type: "observed_session_event"; activeSessionId: string; event: AgentEvent }
	| { type: "observed_session_closed"; activeSessionId: string; error?: string };

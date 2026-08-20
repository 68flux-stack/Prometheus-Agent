import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, ServiceTier, Transport } from "@earendil-works/pi-ai";
import type { AgentSessionMessageReceipt, AgentSessionMessageSafetyStatus } from "../../core/agent-messages.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { ExecutionMode } from "../../core/execution-policy.js";
import type { ExtensionUIContext } from "../../core/extensions/types.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import { type DeleteSessionFileResult, deleteSessionFile } from "../../core/session-file-actions.js";
import { SessionManager } from "../../core/session-manager.js";
import type { SessionStats } from "../../core/session-stats.js";
import { type SideQuestionRun, startSideQuestion } from "../../core/side-question.js";
import { waitForHeadlessCompletion } from "../headless-completion.js";
import { PluginOps } from "./plugin-ops.js";
import {
	createAgentConnectionCommands,
	createAgentConnectionResourceSnapshot,
	createAgentConnectionSnapshot,
	createAgentConnectionState,
} from "./snapshot.js";
import { createAgentConnectionToolDefinition } from "./tool-definition.js";
import type {
	AgentConnection,
	AgentConnectionBeforeSessionInvalidateListener,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionExecuteBashOptions,
	AgentConnectionExtensionUiResponse,
	AgentConnectionForkOptions,
	AgentConnectionHeartbeat,
	AgentConnectionModel,
	AgentConnectionModelCatalog,
	AgentConnectionModelCycleResult,
	AgentConnectionNavigateTreeOptions,
	AgentConnectionNavigateTreeResult,
	AgentConnectionNewSessionOptions,
	AgentConnectionPluginDetail,
	AgentConnectionPluginList,
	AgentConnectionPromptOptions,
	AgentConnectionQueueMode,
	AgentConnectionQueueState,
	AgentConnectionResourceSnapshot,
	AgentConnectionRuntimeFeatures,
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionScopedModel,
	AgentConnectionSessionContext,
	AgentConnectionSessionHeader,
	AgentConnectionSessionListCallbacks,
	AgentConnectionSessionTreeNode,
	AgentConnectionSessionWatcher,
	AgentConnectionSideQuestionTurn,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
	AgentConnectionSwitchSessionOptions,
	AgentConnectionToolDefinition,
	AgentConnectionUserMessage,
} from "./types.js";

export interface InProcessHeadlessExtensionOptions {
	uiContext?: ExtensionUIContext;
	shutdownHandler?: () => void;
}

export class InProcessAgentConnection implements AgentConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private readonly beforeSessionInvalidateListeners = new Set<AgentConnectionBeforeSessionInvalidateListener>();
	private readonly sideQuestionRuns = new Map<string, SideQuestionRun>();
	private headlessExtensionOptions: InProcessHeadlessExtensionOptions | undefined;
	private unsubscribeSessionEvents: (() => void) | undefined;

	constructor(private readonly runtimeHost: AgentSessionRuntime) {
		this.bindCurrentSessionEvents();
		if (typeof this.runtimeHost.setBeforeSessionInvalidate === "function") {
			this.runtimeHost.setBeforeSessionInvalidate(() => {
				this.abortAllSideQuestions();
				for (const listener of [...this.beforeSessionInvalidateListeners]) {
					listener();
				}
			});
		}
		this.runtimeHost.setRebindSession(async () => {
			this.bindCurrentSessionEvents();
			if (this.headlessExtensionOptions) {
				await this.bindCurrentSessionExtensions();
			}
			await this.emit({
				type: "session_replaced",
				state: createAgentConnectionState(this.runtimeHost),
				messages: this.runtimeHost.session.messages,
			});
		});
	}

	async bindHeadlessExtensions(options: InProcessHeadlessExtensionOptions = {}): Promise<void> {
		this.headlessExtensionOptions = options;
		await this.bindCurrentSessionExtensions();
	}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onBeforeSessionInvalidate(listener: AgentConnectionBeforeSessionInvalidateListener): () => void {
		this.beforeSessionInvalidateListeners.add(listener);
		return () => {
			this.beforeSessionInvalidateListeners.delete(listener);
		};
	}

	async getState(): Promise<AgentConnectionState> {
		return createAgentConnectionState(this.runtimeHost);
	}

	async getInitialSnapshot(): Promise<AgentConnectionSnapshot> {
		return createAgentConnectionSnapshot(this.runtimeHost);
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.session.state.messages;
	}

	async getSessionHeader(): Promise<AgentConnectionSessionHeader | undefined> {
		return this.session.sessionManager.getHeader() ?? undefined;
	}

	async getCommands(): Promise<AgentConnectionSlashCommand[]> {
		return createAgentConnectionCommands(this.session);
	}

	async getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot> {
		return createAgentConnectionResourceSnapshot(this.session);
	}

	async getAvailableModels(): Promise<AgentConnectionModel[]> {
		return this.session.modelRegistry.refreshAvailableModels();
	}

	async getModelCatalog(): Promise<AgentConnectionModelCatalog> {
		return this.session.modelRegistry.refreshModelCatalog();
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.session.getSessionStats();
	}

	async getRuntimeFeatures(): Promise<AgentConnectionRuntimeFeatures> {
		return {
			executionMode: this.session.getExecutionMode(),
			jobs: this.session.backgroundJobs.list(),
			worktrees: this.session.subagentWorktrees.list(),
			pluginManagement: true,
		};
	}

	// =========================================================================
	// Plugin / package management
	// Local-only surface: the in-process connection owns the runtime services,
	// so package operations run directly against settings + the resource loader.
	// Daemon-backed connections route through the daemon protocol instead.
	// =========================================================================

	private get pluginOps(): PluginOps {
		return new PluginOps(this.runtimeHost.services);
	}

	async listPlugins(): Promise<AgentConnectionPluginList> {
		return this.pluginOps.listPlugins();
	}

	async getPluginDetail(source: string): Promise<AgentConnectionPluginDetail> {
		return this.pluginOps.getPluginDetail(source);
	}

	async installPlugin(spec: string, options?: { local?: boolean }): Promise<{ name: string; source: string }> {
		return this.pluginOps.installPlugin(spec, options);
	}

	async removePlugin(spec: string, options?: { local?: boolean }): Promise<boolean> {
		return this.pluginOps.removePlugin(spec, options);
	}

	async updatePlugins(spec?: string): Promise<void> {
		await this.pluginOps.updatePlugins(spec);
	}

	async addMarketplace(
		source: string,
		options?: { local?: boolean; name?: string },
	): Promise<{ name: string; pluginCount: number }> {
		return this.pluginOps.addMarketplace(source, options);
	}

	async removeMarketplace(nameOrSource: string, options?: { local?: boolean }): Promise<boolean> {
		return this.pluginOps.removeMarketplace(nameOrSource, options);
	}

	async updateMarketplaces(name?: string): Promise<{ updated: string[] }> {
		return this.pluginOps.updateMarketplaces(name);
	}

	async setPackageEnabled(source: string, enabled: boolean, options?: { local?: boolean }): Promise<void> {
		this.pluginOps.setPackageEnabled(source, enabled, options?.local);
	}

	async setExtensionHookEnabled(extensionPath: string, event: string, enabled: boolean): Promise<void> {
		this.pluginOps.setExtensionHookEnabled(extensionPath, event, enabled);
	}

	async setExecutionMode(mode: ExecutionMode): Promise<AgentConnectionRuntimeFeatures> {
		this.session.setExecutionMode(mode);
		return this.getRuntimeFeatures();
	}

	async startBackgroundJob(command: string): Promise<AgentConnectionRuntimeFeatures> {
		this.session.startBackgroundJob(command);
		return this.getRuntimeFeatures();
	}

	async tailBackgroundJob(jobId: string, maxChars = 16_000): Promise<{ output: string }> {
		return { output: this.session.backgroundJobs.tail(jobId, maxChars) };
	}

	async waitBackgroundJob(jobId: string, sinceRevision: number, timeoutMs?: number) {
		return this.session.backgroundJobs.wait(jobId, sinceRevision, timeoutMs);
	}

	async writeBackgroundJob(jobId: string, input: string): Promise<AgentConnectionRuntimeFeatures> {
		this.session.backgroundJobs.write(jobId, input);
		return this.getRuntimeFeatures();
	}

	async cancelBackgroundJob(jobId: string): Promise<AgentConnectionRuntimeFeatures> {
		this.session.backgroundJobs.cancel(jobId);
		return this.getRuntimeFeatures();
	}

	async applySubagentWorktree(id: string): Promise<AgentConnectionRuntimeFeatures> {
		this.session.subagentWorktrees.apply(id);
		return this.getRuntimeFeatures();
	}

	async discardSubagentWorktree(id: string): Promise<AgentConnectionRuntimeFeatures> {
		this.session.subagentWorktrees.discard(id);
		return this.getRuntimeFeatures();
	}

	async getContextTree(): Promise<ContextTreeNode> {
		return this.session.getContextTree();
	}

	async getSessionContext(): Promise<AgentConnectionSessionContext> {
		return this.session.buildSessionContext();
	}

	async getSessionTree(): Promise<{ tree: AgentConnectionSessionTreeNode[]; leafId: string | null }> {
		return {
			tree: this.session.sessionManager.getTree(),
			leafId: this.session.sessionManager.getLeafId(),
		};
	}

	async listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		callbacks?: AgentConnectionSessionListCallbacks,
	): Promise<AgentConnectionSavedSessionInfo[]> {
		// In-memory managers hold "" for "no explicit session dir"; pass undefined so
		// list()/listAll() fall back to the default directories instead of scanning "".
		const sessionDir = this.session.sessionManager.getSessionDir() || undefined;
		if (scope === "current") {
			return SessionManager.list(this.session.sessionManager.getCwd(), sessionDir, callbacks);
		}
		return SessionManager.listAll(callbacks, sessionDir);
	}

	async getQueue(): Promise<AgentConnectionQueueState> {
		return {
			steering: [...this.session.getSteeringMessagePreviews()],
			followUp: [...this.session.getFollowUpMessagePreviews()],
		};
	}

	async clearQueue(): Promise<AgentConnectionQueueState> {
		return this.session.clearQueue();
	}

	async abortAndClearQueue(): Promise<AgentConnectionQueueState> {
		const queue = this.session.clearQueue();
		this.session.requestAbort();
		return queue;
	}

	async listCronJobs(_options: { includeInactive?: boolean } = {}): Promise<AgentCronJob[]> {
		return [];
	}

	async listHeartbeats(): Promise<AgentConnectionHeartbeat[]> {
		return [];
	}

	async manageHeartbeat(
		_activeSessionId: string,
		_jobId: string,
		_action: AgentHeartbeatManagementAction,
	): Promise<AgentCronJob> {
		throw new Error("Heartbeats require daemon mode");
	}

	async addCronJob(_schedule: string, _prompt: string): Promise<AgentCronJob> {
		throw new Error("Cron jobs require daemon mode");
	}

	async cancelCronJob(_jobId: string): Promise<AgentCronJob> {
		throw new Error("Cron jobs require daemon mode");
	}

	async getHeartbeat(): Promise<AgentCronJob | undefined> {
		return undefined;
	}

	async setHeartbeat(
		_schedule: string,
		_instruction: string,
		_deliveryMode?: AgentHeartbeatDeliveryMode,
	): Promise<AgentCronJob> {
		throw new Error("Heartbeats require daemon mode");
	}

	async updateHeartbeat(_action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined> {
		throw new Error("Heartbeats require daemon mode");
	}

	async sendAgentMessage(_targetActiveSessionId: string, _message: string): Promise<AgentSessionMessageReceipt> {
		throw new Error("Agent messaging requires daemon mode");
	}

	async getAgentMessageStatus(): Promise<AgentSessionMessageSafetyStatus> {
		throw new Error("Agent messaging requires daemon mode");
	}

	async pauseAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		throw new Error("Agent messaging requires daemon mode");
	}

	async resumeAgentMessages(): Promise<AgentSessionMessageSafetyStatus> {
		throw new Error("Agent messaging requires daemon mode");
	}

	async clearAgentMessages(): Promise<number> {
		throw new Error("Agent messaging requires daemon mode");
	}

	async getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]> {
		return this.session.getUserMessagesForForking();
	}

	async getLastAssistantText(): Promise<string | undefined> {
		return this.session.getLastAssistantText();
	}

	async getSystemPrompt(): Promise<string> {
		return this.session.systemPrompt;
	}

	async getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined> {
		return createAgentConnectionToolDefinition(this.session.getToolDefinition(name));
	}

	async setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void> {
		this.session.sessionManager.appendLabelChange(entryId, label);
	}

	async respondToExtensionUiRequest(_requestId: string, _response: AgentConnectionExtensionUiResponse): Promise<void> {
		// In-process extension UI requests are handled directly by InteractiveMode.
	}

	async prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let accepted = false;
			const resolveOnce = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			const rejectOnce = (error: unknown) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			};
			const prompt = this.session.prompt(message, {
				...(options?.images ? { images: options.images } : {}),
				...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior, resumeIfIdle: true } : {}),
				...(options?.queueIfBusy !== undefined ? { queueIfBusy: options.queueIfBusy } : {}),
				...(options?.source ? { source: options.source } : {}),
				...(options?.signal ? { signal: options.signal } : {}),
				preflightResult: (success) => {
					if (success) {
						accepted = true;
						resolveOnce();
					}
				},
			});
			void prompt.then(() => {
				if (accepted) resolveOnce();
				else rejectOnce(new Error("Prompt was not accepted by the session."));
			}, rejectOnce);
		});
	}

	async promptAndWait(message: string, options?: AgentConnectionPromptOptions): Promise<void> {
		await this.session.promptAndWait(message, {
			...(options?.images ? { images: options.images } : {}),
			...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior, resumeIfIdle: true } : {}),
			...(options?.queueIfBusy !== undefined ? { queueIfBusy: options.queueIfBusy } : {}),
			...(options?.source ? { source: options.source } : {}),
			...(options?.signal ? { signal: options.signal } : {}),
		});
	}

	async startSideQuestion(
		id: string,
		question: string,
		previousTurns?: AgentConnectionSideQuestionTurn[],
	): Promise<void> {
		if (this.sideQuestionRuns.has(id)) {
			throw new Error(`Side question already exists: ${id}`);
		}
		const run = startSideQuestion(
			this.session.agent,
			id,
			question,
			(event) => this.emit({ type: "side_question_event", event }),
			previousTurns,
		);
		this.sideQuestionRuns.set(id, run);
		const removeRun = () => {
			this.sideQuestionRuns.delete(id);
		};
		void run.done.then(removeRun, removeRun);
	}

	async abortSideQuestion(id: string): Promise<boolean> {
		const run = this.sideQuestionRuns.get(id);
		if (!run) {
			return false;
		}
		run.abort();
		return true;
	}

	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.session.steer(message, images, { resumeIfIdle: true });
	}

	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.session.followUp(message, images, { resumeIfIdle: true });
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	async cancelRlmChild(childId: string): Promise<boolean> {
		return this.session.cancelRlmChildRun(childId);
	}

	async waitForIdle(): Promise<void> {
		await this.session.waitForIdle();
	}

	async waitForHeadlessCompletion(): Promise<AgentAutonomousStatus> {
		return waitForHeadlessCompletion(this.session);
	}

	async executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void> {
		await this.session.runUserBash(command, options);
	}

	async executeBashAndWait(command: string): Promise<BashResult> {
		return this.session.executeBash(command);
	}

	async abortBash(): Promise<void> {
		this.session.abortBash();
	}

	async setModel(provider: string, modelId: string): Promise<AgentConnectionModel> {
		const availableModels = await this.session.modelRegistry.refreshAvailableModels();
		const model = availableModels.find((candidate) => {
			return candidate.provider === provider && candidate.id === modelId;
		});
		if (!model) {
			throw new Error(`Model not found: ${provider}/${modelId}`);
		}
		await this.session.setModel(model);
		return model;
	}

	async cycleModel(
		direction: "forward" | "backward" = "forward",
	): Promise<AgentConnectionModelCycleResult | undefined> {
		return this.session.cycleModel(direction);
	}

	async setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void> {
		this.session.setScopedModels(scopedModels);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.session.setThinkingLevel(level);
	}

	async setServiceTier(serviceTier: ServiceTier): Promise<void> {
		this.session.setServiceTier(serviceTier);
	}

	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		return this.session.cycleThinkingLevel();
	}

	async setTransport(transport: Transport): Promise<void> {
		this.session.settingsManager.setTransport(transport);
		this.session.agent.transport = transport;
	}

	async setSteeringMode(mode: AgentConnectionQueueMode): Promise<void> {
		this.session.setSteeringMode(mode);
	}

	async setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void> {
		this.session.setFollowUpMode(mode);
	}

	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		this.session.setAutoCompactionEnabled(enabled);
	}

	async setAutoRetryEnabled(enabled: boolean): Promise<void> {
		this.session.setAutoRetryEnabled(enabled);
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		return this.session.compact(customInstructions);
	}

	async refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
	): Promise<RefinementResult> {
		return this.session.refine(options);
	}

	async abortCompaction(): Promise<void> {
		this.session.abortCompaction();
	}

	async abortBranchSummary(): Promise<void> {
		this.session.abortBranchSummary();
	}

	async abortRetry(): Promise<void> {
		this.session.abortRetry();
	}

	async reload(): Promise<void> {
		await this.session.reload();
	}

	async newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }> {
		return this.runtimeHost.newSession(options);
	}

	async switchSession(
		sessionPath: string,
		options?: AgentConnectionSwitchSessionOptions,
	): Promise<{ cancelled: boolean }> {
		return this.runtimeHost.switchSession(sessionPath, options);
	}

	// A single in-process runtime hosts one session at a time, so concurrency is
	// only available over the daemon transport.
	async openSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.switchSession(sessionPath);
	}

	async listBusySessionFiles(): Promise<string[]> {
		const sessionFile = this.session.sessionFile;
		return sessionFile && this.session.isSessionActive ? [sessionFile] : [];
	}

	async fork(
		entryId: string,
		options?: AgentConnectionForkOptions,
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.runtimeHost.fork(entryId, options);
	}

	async navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult> {
		return this.session.navigateTree(targetId, options);
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.runtimeHost.importFromJsonl(inputPath, cwdOverride);
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return this.session.exportToHtml(outputPath);
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		return this.session.exportToJsonl(outputPath);
	}

	async setSessionName(name: string): Promise<void> {
		const trimmedName = name.trim();
		if (!trimmedName) {
			throw new Error("Session name cannot be empty");
		}
		this.session.setSessionName(trimmedName);
	}

	async getRlmMaxDepthStatus() {
		return this.session.getRlmMaxDepthStatus();
	}

	async setRlmMaxDepth(maxDepth: number, options?: { global?: boolean }) {
		return this.session.setRlmMaxDepth(maxDepth, options);
	}

	async renameSavedSession(sessionPath: string, name: string): Promise<void> {
		const trimmedName = name.trim();
		if (!trimmedName) {
			throw new Error("Session name cannot be empty");
		}
		const currentSessionFile = this.session.sessionFile;
		if (currentSessionFile && resolve(currentSessionFile) === resolve(sessionPath)) {
			this.session.setSessionName(trimmedName);
			return;
		}
		// open() on a missing file mints a fresh session at the current process cwd,
		// so renaming a session that was never flushed would create a phantom one in
		// the wrong workspace instead of failing.
		if (!existsSync(sessionPath)) {
			throw new Error(`Session file not found: ${sessionPath}`);
		}
		SessionManager.open(sessionPath).appendSessionInfo(trimmedName);
	}

	async deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult> {
		return deleteSessionFile(sessionPath);
	}

	async watchSession(childId: string): Promise<AgentConnectionSessionWatcher | undefined> {
		const child = this.session.getRlmChildSession(childId);
		if (!child) {
			return undefined;
		}
		const unsubscribes = new Set<() => void>();
		return {
			getMessages: async () => child.messages,
			getCommands: async () => createAgentConnectionCommands(child),
			subscribe: (listener) => {
				const unsubscribe = child.subscribe((event) => void listener({ type: "session_event", event }));
				unsubscribes.add(unsubscribe);
				return () => {
					unsubscribes.delete(unsubscribe);
					unsubscribe();
				};
			},
			getToolDefinition: async (name) => createAgentConnectionToolDefinition(child.getToolDefinition(name)),
			close: async () => {
				for (const unsubscribe of unsubscribes) {
					unsubscribe();
				}
				unsubscribes.clear();
			},
		};
	}

	async dispose(): Promise<void> {
		this.abortAllSideQuestions();
		this.unsubscribeSessionEvents?.();
		this.unsubscribeSessionEvents = undefined;
		if (typeof this.runtimeHost.setBeforeSessionInvalidate === "function") {
			this.runtimeHost.setBeforeSessionInvalidate(undefined);
		}
		this.runtimeHost.setRebindSession(undefined);
		await this.runtimeHost.dispose();
	}

	private get session() {
		return this.runtimeHost.session;
	}

	private bindCurrentSessionEvents(): void {
		this.unsubscribeSessionEvents?.();
		this.unsubscribeSessionEvents = this.session.subscribe((event) => {
			void this.emit({ type: "session_event", event });
		});
	}

	private async bindCurrentSessionExtensions(): Promise<void> {
		const session = this.session;
		await session.bindExtensions({
			uiContext: this.headlessExtensionOptions?.uiContext,
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: (options) => this.runtimeHost.newSession(options),
				fork: async (entryId, options) => {
					const result = await this.runtimeHost.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionPath, options) => this.runtimeHost.switchSession(sessionPath, options),
				reload: () => session.reload(),
			},
			shutdownHandler: this.headlessExtensionOptions?.shutdownHandler,
			onError: (error) => {
				void this.emit({
					type: "extension_error",
					extensionPath: error.extensionPath,
					event: error.event,
					error: error.error,
				});
			},
		});
	}

	private abortAllSideQuestions(): void {
		for (const run of this.sideQuestionRuns.values()) {
			run.abort();
		}
		this.sideQuestionRuns.clear();
	}

	private async emit(event: AgentConnectionEvent): Promise<void> {
		for (const listener of [...this.listeners]) {
			await listener(event);
		}
	}
}

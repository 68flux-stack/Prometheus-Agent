import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import { getAvailableOutputStyles } from "../../core/resource-loader.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import { createSyntheticSourceInfo } from "../../core/source-info.js";
import type {
	AgentConnectionArtifactReference,
	AgentConnectionArtifactType,
	AgentConnectionModel,
	AgentConnectionResourceSnapshot,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionState,
} from "./types.js";

function persistedRecap(sessionManager: {
	getLatestAgentStatus?: () => { summary: string } | undefined;
}): string | undefined {
	return sessionManager.getLatestAgentStatus?.()?.summary;
}

export function createAgentConnectionState(
	runtime: AgentSessionRuntime,
	activeSessionId?: string,
): AgentConnectionState {
	const session = runtime.session;
	const sessionManager = session.sessionManager;
	return {
		activeSessionId,
		cwd: sessionManager.getCwd(),
		model: toConnectionModel(session.model),
		thinkingLevel: session.thinkingLevel,
		serviceTier: session.serviceTier,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		isBashRunning: session.isBashRunning,
		retryAttempt: session.retryAttempt,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		sessionDir: sessionManager.getSessionDir(),
		leafId: sessionManager.getLeafId(),
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		sessionActions: session.getSessionActionSnapshot(),
		compactionCount: sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
		goal: session.goalState,
		todo: session.todoListState,
		scopedModels: session.scopedModels.map((scoped) => ({
			model: toConnectionModel(scoped.model),
			thinkingLevel: scoped.thinkingLevel,
		})),
		activeToolNames: session.getActiveToolNames(),
		contextUsage: session.getContextUsage(),
		// Baseline recap; the daemon overlays the live summary on attach.
		recap: persistedRecap(sessionManager),
	};
}

export function createAgentConnectionSnapshot(
	runtime: AgentSessionRuntime,
	activeSessionId?: string,
): AgentConnectionSnapshot {
	const session = runtime.session;
	const sessionManager = session.sessionManager;
	return {
		state: createAgentConnectionState(runtime, activeSessionId),
		messages: [...session.messages],
		...(session.state?.streamingMessage ? { streamingMessage: session.state.streamingMessage } : {}),
		sessionContext: session.buildSessionContext(),
		sessionTree: {
			tree: sessionManager.getTree(),
			leafId: sessionManager.getLeafId(),
		},
	};
}

export function createAgentConnectionCommands(session: AgentSession): AgentConnectionSlashCommand[] {
	const extensionCommands = session.extensionRunner.getRegisteredCommands().map((entry) => ({
		name: entry.invocationName,
		registeredName: entry.name,
		description: entry.description,
		source: "extension" as const,
		sourceInfo: entry.sourceInfo,
	}));
	const promptCommands = session.promptTemplates.map((entry) => ({
		name: entry.name,
		description: entry.description,
		argumentHint: entry.argumentHint,
		source: "prompt" as const,
		sourceInfo: entry.sourceInfo,
	}));
	// Advertise the full builtin set so any client (TUI, desktop, headless) can
	// surface every command without a per-client hardcoded list: a new builtin
	// (e.g. /plugin) automatically reaches clients that read get_commands.
	// Each client decides what a command means to it — session builtins are
	// parsed from prompt text in agent-session, others are handled client-side
	// or passed through as prompt text.
	const builtinCommands = BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
		source: "builtin" as const,
		sourceInfo: createSyntheticSourceInfo(`<builtin:${command.name}>`, { source: "builtin" }),
		execution: command.execution,
		aliases: command.aliases,
	}));

	// Skills are advertised as plain `/name` commands (the description column already
	// says "skill"), never `/skill:name`. A skill whose name collides with an extension,
	// prompt, or builtin command is dropped so the same name doesn't show up twice.
	const reservedNames = new Set([...extensionCommands, ...promptCommands, ...builtinCommands].map((c) => c.name));
	const skillCommands = session.resourceLoader
		.getSkills()
		.skills.filter((entry) => !reservedNames.has(entry.name))
		.map((entry) => ({
			name: entry.name,
			description: entry.description,
			source: "skill" as const,
			sourceInfo: entry.sourceInfo,
		}));

	return [...extensionCommands, ...promptCommands, ...builtinCommands, ...skillCommands];
}

export function createAgentConnectionResourceSnapshot(session: AgentSession): AgentConnectionResourceSnapshot {
	const skillsResult = session.resourceLoader.getSkills();
	const promptsResult = session.resourceLoader.getPrompts();
	const themesResult = session.resourceLoader.getThemes();
	const extensionsResult = session.resourceLoader.getExtensions();

	return {
		contextFiles: session.resourceLoader.getAgentsFiles().agentsFiles.map((entry) => ({
			path: entry.path,
			artifact: createArtifactReference(session, "context_file", entry.path),
		})),
		skills: skillsResult.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			sourceInfo: skill.sourceInfo,
			artifact: createArtifactReference(session, "skill", skill.filePath),
		})),
		prompts: promptsResult.prompts.map((prompt) => ({
			name: prompt.name,
			description: prompt.description,
			argumentHint: prompt.argumentHint,
			filePath: prompt.filePath,
			sourceInfo: prompt.sourceInfo,
			artifact: createArtifactReference(session, "prompt", prompt.filePath),
		})),
		extensions: extensionsResult.extensions.map((extension) => ({
			path: extension.path,
			sourceInfo: extension.sourceInfo,
			artifact: createArtifactReference(session, "extension", extension.path),
		})),
		themes: themesResult.themes.map((loadedTheme) => ({
			name: loadedTheme.name,
			sourcePath: loadedTheme.sourcePath,
			sourceInfo: loadedTheme.sourceInfo,
			artifact: createArtifactReference(session, "theme", loadedTheme.sourcePath),
		})),
		outputStyles: getAvailableOutputStyles(),
		diagnostics: {
			skills: skillsResult.diagnostics,
			prompts: promptsResult.diagnostics,
			extensions: extensionsResult.errors.map((error) => ({
				type: "error",
				message: error.error,
				path: error.path,
			})),
			themes: themesResult.diagnostics,
		},
	};
}

export function toConnectionModel(model: Model<Api>): AgentConnectionModel;
export function toConnectionModel(model: Model<Api> | undefined): AgentConnectionModel | undefined;
export function toConnectionModel(model: Model<Api> | undefined): AgentConnectionModel | undefined {
	return model;
}

function createArtifactReference(
	session: AgentSession,
	type: AgentConnectionArtifactType,
	filePath: string | undefined,
): AgentConnectionArtifactReference | undefined {
	if (!filePath) {
		return undefined;
	}
	const { logicalPath, relativePath } = createArtifactPathInfo(filePath, session.sessionManager.getCwd());
	const idHash = createHash("sha256").update(`${session.sessionId}\0${type}\0${filePath}`).digest("hex").slice(0, 16);
	return {
		id: `artifact_${idHash}`,
		sessionId: session.sessionId,
		type,
		logicalPath,
		...(relativePath ? { relativePath } : {}),
	};
}

function createArtifactPathInfo(filePath: string, cwd: string): { logicalPath: string; relativePath?: string } {
	if (filePath.startsWith("<") && filePath.endsWith(">")) {
		return { logicalPath: filePath };
	}

	const resolvedCwd = resolve(cwd);
	const resolvedPath = resolve(filePath);
	const cwdRelativePath = toPosixPath(relative(resolvedCwd, resolvedPath));
	if (cwdRelativePath && !cwdRelativePath.startsWith("..") && !isAbsolute(cwdRelativePath)) {
		return { logicalPath: cwdRelativePath, relativePath: cwdRelativePath };
	}

	return { logicalPath: basename(filePath) || "artifact" };
}

function toPosixPath(path: string): string {
	return sep === "/" ? path : path.split(sep).join("/");
}

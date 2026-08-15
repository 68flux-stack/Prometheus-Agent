import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { AgentSessionServices } from "../src/core/agent-session-services.js";
import type { SessionManager } from "../src/core/session-manager.js";

const traceMocks = vi.hoisted(() => {
	const state = { traceFlushPromise: Promise.resolve(undefined) as Promise<undefined> };
	return {
		state,
		flushAgentTraceUpload: vi.fn(() => state.traceFlushPromise),
	};
});

vi.mock("../src/core/agent-traces.js", () => ({ flushAgentTraceUpload: traceMocks.flushAgentTraceUpload }));

describe("AgentSessionRuntime session replacement", () => {
	beforeEach(() => {
		traceMocks.flushAgentTraceUpload.mockClear();
		traceMocks.state.traceFlushPromise = Promise.resolve(undefined);
	});

	it("does not wait for an automatic trace upload before disposing the old session", async () => {
		let releaseTraceFlush = () => {};
		traceMocks.state.traceFlushPromise = new Promise<undefined>((resolve) => {
			releaseTraceFlush = () => resolve(undefined);
		});

		let disposed = false;
		const session = {
			extensionRunner: { hasHandlers: () => false },
			sessionManager: {} as SessionManager,
			setSubagentRuntimeHost: () => {},
			disposeAsync: vi.fn(async () => {
				disposed = true;
			}),
		} as unknown as AgentSession;
		const createRuntime: CreateAgentSessionRuntimeFactory = () => {
			throw new Error("not used");
		};
		const runtime = new AgentSessionRuntime(session, {} as AgentSessionServices, createRuntime);
		const teardown = (
			runtime as unknown as {
				teardownCurrent: (reason: "new") => Promise<void>;
			}
		).teardownCurrent("new");

		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(traceMocks.flushAgentTraceUpload).toHaveBeenCalledWith(session.sessionManager);
		expect(disposed).toBe(true);

		releaseTraceFlush();
		await teardown;
	});
});

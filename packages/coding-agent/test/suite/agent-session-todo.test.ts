import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { TODO_STATE_CUSTOM_TYPE } from "../../src/core/todo.js";
import { createHarness, type Harness } from "./harness.js";

describe("AgentSession todo lists", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		if (harness) {
			harness.cleanup();
			harness = undefined;
		}
	});

	it("initializes with an empty todo list", async () => {
		harness = await createHarness();
		expect(harness.session.todoListState).toEqual({
			title: "",
			items: [],
		});
		const res = harness.session.handleTodoHostRequest("todo.get");
		expect(res.todo).toBeNull();
		expect(res.status).toBe("ok");
	});

	it("sets, updates, completes, adds, and clears todo items via host requests", async () => {
		harness = await createHarness();

		// todo.set
		const setRes = harness.session.handleTodoHostRequest("todo.set", {
			title: "Project Scaffolding & Setup",
			items: [
				"Test item 1: Set up project scaffolding",
				{ text: "Test item 2: Implement core module", status: "pending" },
				"Test item 3: Write unit tests",
			],
		});
		expect(setRes.todo?.title).toBe("Project Scaffolding & Setup");
		expect(setRes.todo?.items).toHaveLength(3);
		expect(setRes.todo?.completed_count).toBe(0);
		expect(setRes.todo?.total_count).toBe(3);
		expect(harness.session.todoListState.title).toBe("Project Scaffolding & Setup");

		// todo.update
		const updateRes = harness.session.handleTodoHostRequest("todo.update", {
			id: "1",
			status: "in_progress",
		});
		expect(updateRes.todo?.items[0]?.status).toBe("in_progress");

		// todo.complete
		const completeRes = harness.session.handleTodoHostRequest("todo.complete", {
			id: "1",
		});
		expect(completeRes.todo?.items[0]?.status).toBe("completed");
		expect(completeRes.todo?.completed_count).toBe(1);

		// todo.add
		const addRes = harness.session.handleTodoHostRequest("todo.add", {
			text: "Test item 4: Add documentation",
			status: "pending",
		});
		expect(addRes.todo?.items).toHaveLength(4);
		expect(addRes.todo?.total_count).toBe(4);
		expect(addRes.todo?.items[3]?.text).toBe("Test item 4: Add documentation");

		// todo.get
		const getRes = harness.session.handleTodoHostRequest("todo.get");
		expect(getRes.todo?.title).toBe("Project Scaffolding & Setup");
		expect(getRes.todo?.items).toHaveLength(4);
		expect(getRes.todo?.completed_count).toBe(1);

		// todo.clear
		const clearRes = harness.session.handleTodoHostRequest("todo.clear");
		expect(clearRes.todo).toBeNull();
		expect(harness.session.todoListState.items).toHaveLength(0);
	});

	it("emits todo_update events when state changes", async () => {
		harness = await createHarness();
		const events: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "todo_update") {
				events.push(event);
			}
		});

		harness.session.setTodoList("Refactor Engine", ["Step 1", "Step 2"]);
		expect(events).toHaveLength(1);
		expect((events[0] as { todo: { title: string } }).todo.title).toBe("Refactor Engine");

		harness.session.updateTodoItem(1, { status: "completed" });
		expect(events).toHaveLength(2);
		expect((events[1] as { todo: { items: Array<{ status: string }> } }).todo.items[0]?.status).toBe("completed");
	});

	it("restores persisted todo list state from session branch on reopen", async () => {
		harness = await createHarness({ persistSession: true });
		harness.session.setTodoList("Persisted Checklist", ["Task A", "Task B"]);
		harness.session.updateTodoItem("1", { status: "completed" });

		const branch = harness.session.sessionManager.getBranch();
		const customEntry = branch.find(
			(entry) => entry.type === "custom" && entry.customType === TODO_STATE_CUSTOM_TYPE,
		);
		expect(customEntry).toBeDefined();

		// Open a new session pointing at the same sessionManager
		const reopenedAgent = new Agent();
		const reopenedSession = new AgentSession({
			agent: reopenedAgent,
			sessionManager: harness.sessionManager,
			settingsManager: harness.settingsManager,
			cwd: harness.tempDir,
			modelRegistry: harness.session.modelRegistry,
			resourceLoader: harness.session.resourceLoader,
		});

		try {
			expect(reopenedSession.todoListState.title).toBe("Persisted Checklist");
			expect(reopenedSession.todoListState.items).toHaveLength(2);
			expect(reopenedSession.todoListState.items[0]?.status).toBe("completed");
			expect(reopenedSession.todoListState.items[1]?.status).toBe("pending");
		} finally {
			reopenedSession.dispose();
		}
	});

	it("guarantees input prompt cache prefix preservation when updating todos", async () => {
		harness = await createHarness();

		// Record initial system prompt
		const initialSystemPrompt = harness.session.agent.state.systemPrompt;

		// Perform multiple todo operations
		harness.session.setTodoList("Cache Test List", ["Item 1", "Item 2"]);
		harness.session.updateTodoItem(1, { status: "in_progress" });
		harness.session.updateTodoItem(1, { status: "completed" });
		harness.session.addTodoItem("Item 3");

		// Assert system prompt is 100% byte-identical (no cache busting in system prompt)
		expect(harness.session.agent.state.systemPrompt).toBe(initialSystemPrompt);

		// Assert no mutating custom messages were injected into conversation messages
		const conversationMessages = harness.session.messages;
		for (const msg of conversationMessages) {
			expect(msg.role).not.toBe("custom");
		}
	});
});

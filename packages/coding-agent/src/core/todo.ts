export const TODO_STATE_CUSTOM_TYPE = "thread_todo_state";
export const MAX_TODO_TITLE_CHARS = 500;
export const MAX_TODO_ITEM_CHARS = 2000;
export const MAX_TODO_ITEMS = 100;

export type TodoItemStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
	id: string;
	text: string;
	status: TodoItemStatus;
}

export interface TodoListState {
	title: string;
	items: TodoItem[];
	updatedAt?: number;
}

/** Serialized payload returned to the kernel-side Python todo skill. Keys are snake_case. */
export interface SerializedTodoItem {
	id: string;
	text: string;
	status: TodoItemStatus;
}

export interface SerializedTodoList {
	title: string;
	items: SerializedTodoItem[];
	completed_count: number;
	total_count: number;
	updated_at?: number;
}

/** Reply payload for todo.* host requests from the IPython kernel. */
export type TodoHostResponse = {
	todo: SerializedTodoList | null;
	status: "ok" | "error";
	message?: string;
	[key: string]: unknown;
};

export function emptyTodoListState(): TodoListState {
	return {
		title: "",
		items: [],
	};
}

export function normalizeTodoItemStatus(status: unknown): TodoItemStatus {
	if (typeof status !== "string") {
		return "pending";
	}
	const normalized = status.trim().toLowerCase();
	if (normalized === "completed" || normalized === "done" || normalized === "complete") {
		return "completed";
	}
	if (
		normalized === "in_progress" ||
		normalized === "in-progress" ||
		normalized === "progress" ||
		normalized === "doing"
	) {
		return "in_progress";
	}
	if (normalized === "cancelled" || normalized === "canceled" || normalized === "dropped") {
		return "cancelled";
	}
	return "pending";
}

export function validateTodoTitle(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("Todo list title must be a string.");
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Todo list title must not be empty.");
	}
	if ([...trimmed].length > MAX_TODO_TITLE_CHARS) {
		throw new Error(`Todo list title must be at most ${MAX_TODO_TITLE_CHARS} characters.`);
	}
	return trimmed;
}

export function validateTodoItemText(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("Todo item text must be a string.");
	}
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error("Todo item text must not be empty.");
	}
	if ([...trimmed].length > MAX_TODO_ITEM_CHARS) {
		throw new Error(`Todo item text must be at most ${MAX_TODO_ITEM_CHARS} characters.`);
	}
	return trimmed;
}

export function normalizeTodoItem(item: unknown, defaultId: string): TodoItem {
	if (typeof item === "string") {
		const text = validateTodoItemText(item);
		// Check for markdown checkbox syntax like "[x] Done" or "[ ] Todo"
		if (text.startsWith("[x] ") || text.startsWith("[X] ")) {
			return {
				id: defaultId,
				text: text.slice(4).trim(),
				status: "completed",
			};
		}
		if (text.startsWith("[ ] ")) {
			return {
				id: defaultId,
				text: text.slice(4).trim(),
				status: "pending",
			};
		}
		if (text.startsWith("[-] ") || text.startsWith("[/] ")) {
			return {
				id: defaultId,
				text: text.slice(4).trim(),
				status: "in_progress",
			};
		}
		return {
			id: defaultId,
			text,
			status: "pending",
		};
	}

	if (item && typeof item === "object") {
		const record = item as Record<string, unknown>;
		const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : defaultId;
		const rawText = record.text ?? record.content ?? record.title ?? record.task;
		const text = validateTodoItemText(rawText);
		const status = normalizeTodoItemStatus(record.status ?? (record.completed === true ? "completed" : undefined));
		return {
			id,
			text,
			status,
		};
	}

	throw new Error("Each todo item must be a string or an object with text/content and optional status.");
}

export function normalizeTodoListState(state: unknown): TodoListState {
	if (!state || typeof state !== "object") {
		return emptyTodoListState();
	}
	const record = state as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const rawItems = Array.isArray(record.items) ? record.items : [];
	const items: TodoItem[] = [];
	for (let i = 0; i < rawItems.length && items.length < MAX_TODO_ITEMS; i++) {
		try {
			items.push(normalizeTodoItem(rawItems[i], String(i + 1)));
		} catch {
			// Skip invalid items during bulk normalization
		}
	}
	const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : undefined;
	return {
		title,
		items,
		updatedAt,
	};
}

export function isPersistedTodoListState(value: unknown): value is TodoListState {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.title !== "string" || !Array.isArray(record.items)) {
		return false;
	}
	for (const item of record.items) {
		if (!item || typeof item !== "object") {
			return false;
		}
		const itemRecord = item as Record<string, unknown>;
		if (
			typeof itemRecord.id !== "string" ||
			typeof itemRecord.text !== "string" ||
			typeof itemRecord.status !== "string"
		) {
			return false;
		}
	}
	return true;
}

export function serializeTodoList(state: TodoListState): SerializedTodoList | null {
	if (!state.title && state.items.length === 0) {
		return null;
	}
	const completedCount = state.items.filter((item) => item.status === "completed").length;
	return {
		title: state.title,
		items: state.items.map((item) => ({
			id: item.id,
			text: item.text,
			status: item.status,
		})),
		completed_count: completedCount,
		total_count: state.items.length,
		updated_at: state.updatedAt,
	};
}

export function todoHostResponse(state: TodoListState, message?: string): TodoHostResponse {
	return {
		todo: serializeTodoList(state),
		status: "ok",
		message,
	};
}

export function formatTodoListSummary(state: TodoListState): string {
	if (!state.title && state.items.length === 0) {
		return "No active todo list.";
	}
	const completed = state.items.filter((item) => item.status === "completed").length;
	const total = state.items.length;
	const lines = [`# ${state.title || "Todo List"} (${completed} of ${total} completed)`];
	for (const item of state.items) {
		const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[-]" : "[ ]";
		lines.push(`${marker} ${item.id}: ${item.text}`);
	}
	return lines.join("\n");
}

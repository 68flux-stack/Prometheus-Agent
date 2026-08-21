import {
	type Component,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionUIQuestion } from "../../../core/extensions/types.js";
import { theme } from "../theme/theme.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";

export interface QuestionComponentOptions {
	timeout?: number;
}

export class QuestionComponent implements Component, Focusable {
	private readonly input = new Input();
	private readonly selected: Array<number | undefined>;
	private readonly answers: string[];
	private questionIndex = 0;
	private selectedIndex = -1;
	private timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	private _focused = false;

	constructor(
		private readonly questions: ExtensionUIQuestion[],
		private readonly onSubmit: (answers: string[]) => void,
		private readonly onCancel: () => void,
		options?: QuestionComponentOptions,
	) {
		this.selected = Array.from({ length: questions.length });
		this.answers = Array.from({ length: questions.length }, () => "");
		if (options?.timeout !== undefined && options.timeout > 0) {
			this.timeoutHandle = setTimeout(() => this.onCancel(), options.timeout);
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.isCustomSelected();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			this.setSelectedIndex(Math.max(0, this.selectedIndex - 1));
			return;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			this.setSelectedIndex(Math.min(this.optionCount(), this.selectedIndex + 1));
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.confirmSelection();
			return;
		}
		if (this.isCustomSelected()) {
			this.input.handleInput?.(data);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(24, width);
		const innerWidth = Math.max(1, safeWidth - 4);
		const paint = (value: string): string => {
			const content = truncateToWidth(value, innerWidth, "");
			const background = theme.getEditorBackgroundColor() ?? ((text: string) => text);
			return background(`  ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))}  `);
		};
		const question = this.questions[this.questionIndex];
		if (!question) return [];
		const lines: string[] = [
			paint(theme.fg("accent", `${this.questionIndex + 1} of ${this.questions.length} questions`)),
			paint(""),
			paint(theme.bold(theme.fg("text", question.question))),
			paint(theme.fg("muted", question.description || "Select one answer")),
			paint(""),
		];

		question.options.forEach((option, index) => {
			const selected = this.selectedIndex === index;
			const marker = selected ? theme.fg("accent", "●") : theme.fg("muted", "○");
			const recommendation = option.recommended ? theme.fg("accent", " (Recommended)") : "";
			lines.push(paint(`${marker} ${theme.bold(theme.fg("text", option.label))}${recommendation}`));
			for (const description of wrapTextWithAnsi(
				theme.fg("muted", option.description),
				Math.max(1, innerWidth - 5),
			)) {
				lines.push(paint(`    ${description}`));
			}
			lines.push(paint(""));
		});

		const customSelected = this.isCustomSelected();
		const customMarker = customSelected ? theme.fg("accent", "●") : theme.fg("muted", "○");
		lines.push(paint(`${customMarker} ${theme.bold(theme.fg("text", "Type your own answer"))}`));
		if (customSelected) {
			const inputLine = this.input.render(Math.max(1, innerWidth - 5))[0] ?? "";
			lines.push(paint(`    ${inputLine.replace(/^> /, "")}`));
		} else {
			lines.push(paint(`    ${theme.fg("muted", "Type your answer...")}`));
		}
		lines.push(paint(""));
		lines.push(
			paint(
				`${rawKeyHint("↑↓", "choose")}  ${keyHint("tui.select.confirm", this.isLastQuestion() ? "submit" : "next")}  ${keyHint("tui.select.cancel", "dismiss")}`,
			),
		);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
	}

	private optionCount(): number {
		return (this.questions[this.questionIndex]?.options.length ?? 0) + 1;
	}

	private isCustomSelected(): boolean {
		return this.selectedIndex === (this.questions[this.questionIndex]?.options.length ?? 0);
	}

	private setSelectedIndex(index: number): void {
		this.selectedIndex = index;
		this.input.focused = this._focused && this.isCustomSelected();
	}

	private confirmSelection(): void {
		const question = this.questions[this.questionIndex];
		if (!question) return;
		let answer: string;
		if (this.isCustomSelected()) {
			answer = this.input.getValue().trim();
			if (!answer) return;
		} else {
			answer = question.options[this.selectedIndex]?.label ?? "";
			if (!answer) return;
		}
		this.selected[this.questionIndex] = this.selectedIndex;
		this.answers[this.questionIndex] = answer;
		if (!this.isLastQuestion()) {
			this.questionIndex++;
			this.selectedIndex = this.selected[this.questionIndex] ?? -1;
			this.input.setValue("");
			this.input.focused = false;
			return;
		}
		const answers = [...this.answers];
		answers[this.questionIndex] = answer;
		if (answers.some((value) => !value)) return;
		this.onSubmit(answers);
	}

	private isLastQuestion(): boolean {
		return this.questionIndex === this.questions.length - 1;
	}
}

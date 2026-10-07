/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 *
 * Every question carries a recommendation with its reason and a default. Without a UI, or for
 * questions left unanswered when the user dismisses the questionnaire, the defaults apply and the
 * result says so; a defaulted answer is never approval for anything the policy gate blocked.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	recommendation: string;
	recommendationReason: string;
	default: string;
	defaultAfter: string;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
	defaulted?: boolean;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
	recommendation: Type.String({ description: "Value of the option you recommend" }),
	recommendationReason: Type.String({ description: "Why you recommend it, in one sentence" }),
	default: Type.String({ description: "Value of the option you will take if the user does not answer" }),
	defaultAfter: Type.String({ description: "When the default applies, for example 'if no answer this session'" }),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

function contractProblems(questions: Question[]): string[] {
	return questions.flatMap((q) => {
		const values = q.options.map((o) => o.value);
		const problems: string[] = [];
		if (values.length < 2) problems.push("give at least two options");
		if (!values.includes(q.recommendation)) problems.push("recommendation must be one of the option values");
		if (!values.includes(q.default)) problems.push("default must be one of the option values");
		if (!q.recommendationReason?.trim()) problems.push("give the reason for the recommendation");
		if (!q.defaultAfter?.trim()) problems.push("say when the default applies");
		return problems.map((problem) => `${q.label}: ${problem}`);
	});
}

function defaultAnswer(q: Question): Answer {
	const index = q.options.findIndex((o) => o.value === q.default);
	return { id: q.id, value: q.default, label: q.options[index].label, wasCustom: false, index: index + 1, defaulted: true };
}

const NOT_APPROVAL =
	'Defaulted answers are not user approval: anything the policy gate blocked stays blocked, so draft it for the user instead, and list these decisions under "Needs you" in the report.';

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more decisions only they can make. Each question needs concrete options, your recommendation with its reason, and the default you will take and when. Do not ask about reversible choices you can make and report. Never use it to get approval for a command the policy gate blocked.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));
			const problems = contractProblems(questions);
			if (problems.length > 0) {
				return errorResult(`Questionnaire rejected: ${problems.join("; ")}. Fix it and ask again.`, questions);
			}
			if (!ctx.hasUI) {
				const answers = questions.map(defaultAnswer);
				return {
					content: [{ type: "text", text: `No user is attached; taking the defaults:\n${answers.map((a) => `${questions.find((q) => q.id === a.id)?.label}: ${a.label} (${questions.find((q) => q.id === a.id)?.defaultAfter})`).join("\n")}\n${NOT_APPROVAL}` }],
					details: { questions, answers, cancelled: false },
				};
			}
			// Show the recommendation and the default under their options; returned labels stay unchanged.
			for (const q of questions) {
				q.options = q.options.map((o) => {
					const notes = [o.description, o.value === q.recommendation ? `Recommended: ${q.recommendationReason}` : "", o.value === q.default ? `Default ${q.defaultAfter}.` : ""].filter(Boolean);
					return { ...o, description: notes.join(" ") || undefined };
				});
			}

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const result = await ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				// Helpers
				function refresh() {
					cachedWidth = undefined;
					cachedLines = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							refresh();
							return;
						}
					}

					// Submit tab
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					const renderWidth = Math.max(1, width);
					if (cachedLines && cachedWidth === renderWidth) return cachedLines;

					const lines: string[] = [];
					const q = currentQuestion();
					const opts = currentOptions();

					function addWrapped(text: string) {
						lines.push(...wrapTextWithAnsi(text, renderWidth));
					}

					function addWrappedWithPrefix(prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						if (prefixWidth >= renderWidth) {
							addWrapped(prefix + text);
							return;
						}
						const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
						const continuationPrefix = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
						}
					}

					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						addWrappedWithPrefix(" ", tabs.join(""));
						lines.push("");
					}

					// Helper to render options list
					function renderOptions() {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}${isOther && inputMode ? " ✎" : ""}`;
							const color = selected || (isOther && inputMode) ? "accent" : "text";

							addWrappedWithPrefix(prefix, theme.fg(color, label));
							if (opt.description) {
								addWrappedWithPrefix("     ", theme.fg("muted", opt.description));
							}
						}
					}

					// Content
					if (inputMode && q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						// Show options for reference
						renderOptions();
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("muted", "Your answer:"));
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}
						lines.push("");
						addWrappedWithPrefix(" ", theme.fg("dim", "Enter to submit • Esc takes the defaults"));
					} else if (currentTab === questions.length) {
						addWrappedWithPrefix(" ", theme.fg("accent", theme.bold("Ready to submit")));
						lines.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								const summary = `${theme.fg("muted", `${question.label}: `)}${theme.fg("text", prefix + answer.label)}`;
								addWrappedWithPrefix(" ", summary);
							}
						}
						lines.push("");
						if (allAnswered()) {
							addWrappedWithPrefix(" ", theme.fg("success", "Press Enter to submit"));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							addWrappedWithPrefix(" ", theme.fg("warning", `Unanswered: ${missing}`));
						}
					} else if (q) {
						addWrappedWithPrefix(" ", theme.fg("text", q.prompt));
						lines.push("");
						renderOptions();
					}

					lines.push("");
					if (!inputMode) {
						const help = isMulti
							? "Tab/←→ navigate • ↑↓ select • Enter confirm • Esc takes the defaults"
							: "↑↓ navigate • Enter select • Esc takes the default";
						addWrappedWithPrefix(" ", theme.fg("dim", help));
					}
					lines.push(theme.fg("accent", "─".repeat(renderWidth)));

					cachedWidth = renderWidth;
					cachedLines = lines;
					return lines;
				}

				return {
					render,
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			const answers = questions.map((q) => result.answers.find((a) => a.id === q.id) ?? defaultAnswer(q));
			const answerLines = answers.map((a) => {
				const q = questions.find((candidate) => candidate.id === a.id);
				const qLabel = q?.label || a.id;
				if (a.defaulted) return `${qLabel}: not answered; default taken: ${a.label} (${q?.defaultAfter})`;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});
			const defaulted = answers.some((a) => a.defaulted);
			const intro = result.cancelled ? "The user dismissed the questionnaire.\n" : "";

			return {
				content: [{ type: "text", text: `${intro}${answerLines.join("\n")}${defaulted ? `\n${NOT_APPROVAL}` : ""}` }],
				details: { ...result, answers, cancelled: false },
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.defaulted) {
					return `${theme.fg("warning", "• ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(default) ")}${a.label}`;
				}
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

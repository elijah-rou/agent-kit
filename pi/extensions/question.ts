/**
 * Question Tool - Single question with options
 * Full custom UI: options list + inline editor for "Type something..."
 * Escape in editor returns to options, Escape in options dismisses the question.
 *
 * Every question carries a recommendation with its reason and the default the agent takes if the
 * user does not answer. Without a UI, or when the user dismisses it, the default applies and the
 * result says so; a defaulted answer is never approval for anything the policy gate blocked.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "typebox";

interface OptionWithDesc {
	label: string;
	description?: string;
}

type DisplayOption = OptionWithDesc & { isOther?: boolean };

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
	defaulted?: boolean;
	rejected?: string[];
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { description: "Options for the user to choose from" }),
	recommendation: Type.String({ description: "Label of the option you recommend" }),
	recommendationReason: Type.String({ description: "Why you recommend it, in one sentence" }),
	default: Type.String({ description: "Label of the option you will take if the user does not answer" }),
	defaultAfter: Type.String({ description: "When the default applies, for example 'if no answer this session'" }),
});

function contractProblems(params: { options: OptionWithDesc[]; recommendation: string; recommendationReason: string; default: string; defaultAfter: string }): string[] {
	const labels = params.options.map((o) => o.label);
	const problems: string[] = [];
	if (labels.length < 2) problems.push("give at least two options");
	if (!labels.includes(params.recommendation)) problems.push("recommendation must be one of the option labels");
	if (!labels.includes(params.default)) problems.push("default must be one of the option labels");
	if (!params.recommendationReason?.trim()) problems.push("give the reason for the recommendation");
	if (!params.defaultAfter?.trim()) problems.push("say when the default applies");
	return problems;
}

function defaultedText(params: { default: string; defaultAfter: string }, why: string): string {
	return `${why} Taking the default: ${params.default} (${params.defaultAfter}). This is not user approval: anything the policy gate blocked stays blocked, so draft it for the user instead, and list this decision under "Needs you" in the report.`;
}

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user a decision only they can make: give concrete options, your recommendation with its reason, and the default you will take and when. Do not ask about reversible choices you can make and report. Never use it to get approval for a command the policy gate blocked.",
		promptSnippet: "question: ask the user a real decision, with options, a recommendation, and a default",
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const simpleOptions = params.options.map((o) => o.label);
			const problems = contractProblems(params);
			if (problems.length > 0) {
				return {
					content: [{ type: "text", text: `Question rejected: ${problems.join("; ")}. Fix it and ask again.` }],
					details: { question: params.question, options: simpleOptions, answer: null, rejected: problems } as QuestionDetails,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: defaultedText(params, "No user is attached.") }],
					details: { question: params.question, options: simpleOptions, answer: params.default, defaulted: true } as QuestionDetails,
				};
			}

			const marked = params.options.map((o) => {
				const tags = [o.label === params.recommendation ? "recommended" : "", o.label === params.default ? "default" : ""].filter(Boolean);
				const why = o.label === params.recommendation ? params.recommendationReason : "";
				return { ...o, tag: tags.length ? ` (${tags.join(", ")})` : "", description: [o.description, why].filter(Boolean).join(" ") || undefined };
			});
			const allOptions: (DisplayOption & { tag?: string })[] = [...marked, { label: "Type something.", isOther: true }];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

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

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
						} else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								editMode = true;
								refresh();
							} else {
								done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
							}
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));

						add(theme.fg("accent", "─".repeat(width)));
						add(theme.fg("text", ` ${params.question}`));
						lines.push("");

						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";

							const tag = opt.tag ? theme.fg("muted", opt.tag) : "";
							if (isOther && editMode) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
							} else if (selected) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label}`) + tag);
							} else {
								add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}${tag}`);
							}

							// Show description if present
							if (opt.description) {
								add(`     ${theme.fg("muted", opt.description)}`);
							}
						}

						if (editMode) {
							lines.push("");
							add(theme.fg("muted", " Your answer:"));
							for (const line of editor.render(width - 2)) {
								add(` ${line}`);
							}
						}

						lines.push("");
						if (editMode) {
							add(theme.fg("dim", " Enter to submit • Esc to go back"));
						} else {
							add(theme.fg("dim", ` ↑↓ navigate • Enter to select • Esc takes the default (${params.default})`));
						}
						add(theme.fg("accent", "─".repeat(width)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			if (!result) {
				return {
					content: [{ type: "text", text: defaultedText(params, "The user dismissed the question without choosing.") }],
					details: { question: params.question, options: simpleOptions, answer: params.default, defaulted: true } as QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: {
						question: params.question,
						options: simpleOptions,
						answer: result.answer,
						wasCustom: true,
					} as QuestionDetails,
				};
			}
			return {
				content: [{ type: "text", text: `User selected: ${result.index}. ${result.answer}` }],
				details: {
					question: params.question,
					options: simpleOptions,
					answer: result.answer,
					wasCustom: false,
				} as QuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionWithDesc) => o.label);
				const numbered = [...labels, "Type something."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.rejected) {
				return new Text(theme.fg("error", `Rejected: ${details.rejected.join("; ")}`), 0, 0);
			}
			if (details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			if (details.defaulted) {
				return new Text(theme.fg("warning", "Default taken: ") + theme.fg("accent", details.answer), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}

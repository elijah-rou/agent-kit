// Lints an agent's final report against the interaction contract (design D7, requirement R11).
//
// Rule 1: the first non-empty section is "Needs you". A section starts at a heading; a heading
// whose body is blank is skipped, so a bare title H1 is fine. The section passes when its
// heading reads "Needs you", or when its first non-blank line is a Needs-you lead: bold
// ("**Needs you:** ...", "__Needs you__") or plain ("Needs you: ..."). Text before any heading
// is checked the same way. The Needs-you part must not be empty; "Needs you: nothing" passes.
//
// Rule 2: every question to the user carries options, a recommendation and a default.
// Heuristic: inside the Needs-you part, a line ending in "?" (after trailing emphasis or code
// markers) is a question. The rest of its unit, after that line, must contain the words
// "Option(s)", "Recommend..." and "Default" (case-insensitive). A unit is a top-level list
// item with its continuation lines and nested items, or a paragraph when there is no list.
//
// Limits of the heuristic:
// - Questions outside the Needs-you part are not checked.
// - A question that does not end its line ("Merge now? I can wait.") is missed.
// - Rhetorical questions in Needs you are flagged.
// - Marker words count wherever they appear, so prose like "the default config" satisfies the
//   Default marker; the lint checks presence, not that the options are concrete or the
//   recommendation has a reason.
// - Markers placed before the question, or in a separate list item, do not count.

export interface LintError {
	readonly line: number;
	readonly message: string;
}

interface Line {
	readonly number: number;
	readonly text: string;
	readonly fenced: boolean;
	readonly heading: { readonly level: number; readonly text: string } | null;
}

const MARKERS = [
	{ name: "Options", pattern: /\boptions?\b/i },
	{ name: "Recommend", pattern: /\brecommend/i },
	{ name: "Default", pattern: /\bdefault/i },
] as const;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;

function scan(text: string): Line[] {
	const lines: Line[] = [];
	let fence: string | null = null;
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
		const fenced = fence !== null || marker !== undefined;
		if (marker !== undefined) {
			fence = fence === null ? marker : marker[0] === fence[0] ? null : fence;
		}
		const match = fenced ? null : /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
		const heading = match === null ? null : { level: match[1]!.length, text: match[2]! };
		lines.push({ number: index + 1, text: raw, fenced, heading });
	}
	return lines;
}

function stripEmphasis(text: string): string {
	return text.trim().replace(/^(\*\*|__|\*|_)\s*/, "");
}

function isNeedsYouHeading(text: string): boolean {
	return /^needs you\b/i.test(stripEmphasis(text));
}

// A lead names the Needs-you part inside a paragraph: "**Needs you:** x" or "Needs you: x".
function isNeedsYouLead(text: string): boolean {
	const trimmed = text.trim();
	if (/^(\*\*|__)/.test(trimmed)) {
		return /^needs you\b/i.test(stripEmphasis(trimmed));
	}
	return /^needs you\s*:/i.test(trimmed);
}

function isBoldLead(text: string): boolean {
	return /^(\*\*|__)\S/.test(text);
}

interface Part {
	readonly start: number;
	readonly body: readonly Line[];
}

// Finds the first section with content and returns its Needs-you part, or an error.
function findNeedsYou(lines: readonly Line[]): Part | LintError {
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line.text.trim() === "") {
			index += 1;
			continue;
		}
		if (line.heading !== null) {
			if (isNeedsYouHeading(line.heading.text)) {
				return { start: line.number, body: lines.slice(index + 1, sectionEnd(lines, index)) };
			}
			const body = lines.slice(index + 1, sectionEnd(lines, index, 6));
			const first = body.find((l) => l.text.trim() !== "");
			if (first === undefined) {
				index += 1;
				continue;
			}
			if (first.heading === null && isNeedsYouLead(first.text)) {
				return leadPart(lines, lines.indexOf(first));
			}
			return firstSectionError(line);
		}
		if (isNeedsYouLead(line.text)) {
			return leadPart(lines, index);
		}
		return firstSectionError(line);
	}
	return { line: 1, message: 'report is empty; it must open with "Needs you"' };
}

function firstSectionError(line: Line): LintError {
	const message = 'first section must be "Needs you" (write "Needs you: nothing" if none)';
	return { line: line.number, message };
}

// Index of the line ending the section that starts at `index`: the next heading at the same
// or a higher level. With maxLevel 6 any heading ends it.
function sectionEnd(lines: readonly Line[], index: number, maxLevel?: number): number {
	const level = maxLevel ?? lines[index]!.heading!.level;
	for (let next = index + 1; next < lines.length; next += 1) {
		const heading = lines[next]!.heading;
		if (heading !== null && heading.level <= level) {
			return next;
		}
	}
	return lines.length;
}

// A lead-form part runs to the next heading or the next bold lead at column 0.
function leadPart(lines: readonly Line[], index: number): Part {
	const lead = lines[index]!;
	const remainder = lead.text.replace(/^\s*(\*\*|__)?\s*needs you\s*:?\s*(\*\*|__)?\s*:?/i, "");
	let end = index + 1;
	while (end < lines.length) {
		const line = lines[end]!;
		if (line.heading !== null || (!line.fenced && isBoldLead(line.text))) {
			break;
		}
		end += 1;
	}
	const first: Line = { ...lead, text: remainder };
	return { start: lead.number, body: [first, ...lines.slice(index + 1, end)] };
}

function units(body: readonly Line[]): Line[][] {
	const indents = body
		.map((line) => LIST_ITEM.exec(line.text)?.[1]?.length)
		.filter((indent): indent is number => indent !== undefined);
	const topIndent = indents.length === 0 ? -1 : Math.min(...indents);
	const result: Line[][] = [];
	let current: Line[] = [];
	let previousBlank = true;
	for (const line of body) {
		const blank = line.text.trim() === "";
		const item = LIST_ITEM.exec(line.text);
		const startsItem = item !== null && item[1]!.length <= topIndent;
		const startsParagraph = !blank && previousBlank && !/^\s/.test(line.text) && item === null;
		if ((startsItem || startsParagraph) && current.length > 0) {
			result.push(current);
			current = [];
		}
		current.push(line);
		previousBlank = blank;
	}
	if (current.length > 0) {
		result.push(current);
	}
	return result;
}

function isQuestion(line: Line): boolean {
	return !line.fenced && /\?$/.test(line.text.trim().replace(/[*_`]+$/, ""));
}

export function lintReport(text: string): LintError[] {
	const found = findNeedsYou(scan(text));
	if ("message" in found) {
		return [found];
	}
	const content = found.body.filter((line) => line.text.trim() !== "");
	if (content.length === 0) {
		const message = 'Needs you part is empty; write "Needs you: nothing" if none';
		return [{ line: found.start, message }];
	}
	const errors: LintError[] = [];
	for (const unit of units(found.body)) {
		for (const [position, line] of unit.entries()) {
			if (!isQuestion(line)) {
				continue;
			}
			const after = unit.slice(position + 1).map((l) => l.text).join("\n");
			const missing = MARKERS.filter((marker) => !marker.pattern.test(after));
			if (missing.length > 0) {
				const names = missing.map((marker) => marker.name).join(", ");
				errors.push({ line: line.number, message: `question lacks ${names} after it` });
			}
		}
	}
	return errors;
}

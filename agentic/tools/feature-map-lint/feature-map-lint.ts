// Validates a verification feature map (design D10): a directory holding README.md plus one
// Markdown file per feature.
//
// README.md must have the H2 sections "Baseline preconditions", "Driving conventions",
// "Proof and skip reporting" and "Features". Every link in Features must point to an existing
// local file. Every feature file must be linked from somewhere in README.md.
//
// Feature files are the *.md files directly in the directory (except README.md) plus any local
// .md file linked from Features. Each has exactly one H1, a paragraph between the H1 and the
// first H2, and exactly four H2s in this order: "Sub-features", "How to get to it (user POV)",
// "Driving it with <harness>" (any non-empty harness name), "Gotchas". The driving section has
// a line starting with "Preconditions:" (bold allowed). H3 and deeper headings are free.
// Headings inside fenced code blocks are ignored. Heading names compare case-insensitively.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const README_SECTIONS = [
	"Baseline preconditions",
	"Driving conventions",
	"Proof and skip reporting",
	"Features",
] as const;

const FEATURE_SECTIONS = [
	{ label: "Sub-features", pattern: /^sub-features$/i },
	{ label: "How to get to it (user POV)", pattern: /^how to get to it \(user pov\)$/i },
	{ label: "Driving it with <harness>", pattern: /^driving it with \S.*$/i },
	{ label: "Gotchas", pattern: /^gotchas$/i },
] as const;
const DRIVING_INDEX = 2;

export interface LintError {
	readonly file: string;
	readonly line: number;
	readonly message: string;
}

interface Heading {
	readonly level: number;
	readonly text: string;
	readonly line: number;
}

interface Link {
	readonly target: string;
	readonly line: number;
}

interface Document {
	readonly lines: readonly string[];
	readonly headings: readonly Heading[];
	// True for lines inside a fenced code block, including the fences.
	readonly fenced: readonly boolean[];
}

export function parseDocument(text: string): Document {
	const lines = text.split(/\r?\n/);
	const headings: Heading[] = [];
	const fenced: boolean[] = [];
	let fence: string | null = null;
	for (const [index, line] of lines.entries()) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (fence !== null) {
			fenced.push(true);
			if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) {
				fence = null;
			}
			continue;
		}
		if (marker !== undefined) {
			fence = marker;
			fenced.push(true);
			continue;
		}
		fenced.push(false);
		const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading !== null) {
			headings.push({ level: heading[1]!.length, text: heading[2]!, line: index + 1 });
		}
	}
	assert.equal(fenced.length, lines.length);
	return { lines, headings, fenced };
}

// Returns the 1-based line range [start, end] of the body under a heading, ending before the
// next heading of the same or a higher level.
function sectionBody(document: Document, heading: Heading): { start: number; end: number } {
	const next = document.headings.find((h) => h.line > heading.line && h.level <= heading.level);
	const end = next === undefined ? document.lines.length : next.line - 1;
	return { start: heading.line + 1, end };
}

function linksIn(document: Document, start: number, end: number): Link[] {
	const links: Link[] = [];
	for (let line = start; line <= end; line += 1) {
		if (document.fenced[line - 1]) {
			continue;
		}
		const text = document.lines[line - 1]!.replace(/`[^`]*`/g, "");
		for (const match of text.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
			links.push({ target: match[1]!, line });
		}
	}
	return links;
}

function isExternal(target: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function localPath(directory: string, target: string): string {
	const withoutFragment = target.split("#", 1)[0]!;
	return resolve(directory, decodeURIComponent(withoutFragment));
}

export function lintFeatureMap(directory: string): LintError[] {
	const root = resolve(directory);
	const readme = join(root, "README.md");
	if (!existsSync(readme)) {
		return [{ file: "README.md", line: 1, message: "README.md is missing" }];
	}
	const readmeDocument = parseDocument(readFileSync(readme, "utf8"));
	const errors: LintError[] = [];
	const featureLinks = lintReadme(root, readmeDocument, errors);

	const linkedFromReadme = new Set(
		linksIn(readmeDocument, 1, readmeDocument.lines.length)
			.filter((link) => !isExternal(link.target) && !link.target.startsWith("#"))
			.map((link) => localPath(root, link.target)),
	);
	const featureFiles = new Set(
		readdirSync(root)
			.filter((name) => name.endsWith(".md") && name !== "README.md")
			.map((name) => join(root, name)),
	);
	for (const path of featureLinks) {
		if (path.endsWith(".md") && existsSync(path)) {
			featureFiles.add(path);
		}
	}
	for (const path of [...featureFiles].sort()) {
		const file = relative(root, path);
		if (!linkedFromReadme.has(path)) {
			errors.push({ file, line: 1, message: "feature file is not linked from README.md" });
		}
		const document = parseDocument(readFileSync(path, "utf8"));
		errors.push(...lintFeature(document).map((error) => ({ ...error, file })));
	}
	return errors;
}

// Checks README sections and Features links, and returns the resolved local Features targets.
function lintReadme(root: string, document: Document, errors: LintError[]): string[] {
	const h2 = document.headings.filter((heading) => heading.level === 2);
	for (const name of README_SECTIONS) {
		if (!h2.some((heading) => heading.text.toLowerCase() === name.toLowerCase())) {
			errors.push({ file: "README.md", line: 1, message: `missing section "## ${name}"` });
		}
	}
	const features = h2.find((heading) => heading.text.toLowerCase() === "features");
	if (features === undefined) {
		return [];
	}
	const { start, end } = sectionBody(document, features);
	const links = linksIn(document, start, end);
	if (links.length === 0) {
		errors.push({ file: "README.md", line: features.line, message: "Features has no links" });
	}
	const targets: string[] = [];
	for (const link of links) {
		if (isExternal(link.target)) {
			const message = `Features link "${link.target}" is external; link a local feature file`;
			errors.push({ file: "README.md", line: link.line, message });
			continue;
		}
		const path = localPath(root, link.target);
		if (existsSync(path) && statSync(path).isFile()) {
			targets.push(path);
		} else {
			const message = `Features link "${link.target}" does not resolve`;
			errors.push({ file: "README.md", line: link.line, message });
		}
	}
	return targets;
}

export function lintFeature(document: Document): Omit<LintError, "file">[] {
	const errors: Omit<LintError, "file">[] = [];
	const h1 = document.headings.filter((heading) => heading.level === 1);
	const h2 = document.headings.filter((heading) => heading.level === 2);
	if (h1.length === 0) {
		errors.push({ line: 1, message: "missing H1 title" });
	}
	for (const extra of h1.slice(1)) {
		errors.push({ line: extra.line, message: "more than one H1" });
	}
	const title = h1[0];
	const firstH2 = h2[0];
	if (title !== undefined) {
		if (firstH2 !== undefined && firstH2.line < title.line) {
			errors.push({ line: firstH2.line, message: "H2 before the H1 title" });
		} else {
			const end = firstH2 === undefined ? document.lines.length : firstH2.line - 1;
			if (!hasParagraph(document, title.line + 1, end)) {
				const message = "missing a description paragraph between the H1 and the first H2";
				errors.push({ line: title.line, message });
			}
		}
	}
	errors.push(...lintSections(document, h2));
	return errors.sort((a, b) => a.line - b.line);
}

function hasParagraph(document: Document, start: number, end: number): boolean {
	for (let line = start; line <= end; line += 1) {
		const text = document.lines[line - 1]!.trim();
		const structural = /^(#|[-*+]\s|\d+[.)]\s|>|\||<!--)/.test(text);
		if (!document.fenced[line - 1] && text !== "" && !structural) {
			return true;
		}
	}
	return false;
}

function lintSections(document: Document, h2: readonly Heading[]): Omit<LintError, "file">[] {
	const errors: Omit<LintError, "file">[] = [];
	if (h2.length !== FEATURE_SECTIONS.length) {
		const found = h2.map((heading) => `"${heading.text}"`).join(", ") || "none";
		const message = `expected exactly ${FEATURE_SECTIONS.length} H2 sections, found ${h2.length}: ${found}`;
		errors.push({ line: h2[0]?.line ?? 1, message });
	}
	const count = Math.min(h2.length, FEATURE_SECTIONS.length);
	for (let index = 0; index < count; index += 1) {
		const heading = h2[index]!;
		const expected = FEATURE_SECTIONS[index]!;
		if (!expected.pattern.test(heading.text)) {
			const message = `H2 ${index + 1} must be "${expected.label}", found "${heading.text}"`;
			errors.push({ line: heading.line, message });
		}
	}
	// Checked wherever the driving section sits, so a misordered file still gets this error.
	const driving = h2.find((heading) => FEATURE_SECTIONS[DRIVING_INDEX].pattern.test(heading.text));
	if (driving !== undefined) {
		const { start, end } = sectionBody(document, driving);
		const lines = document.lines.slice(start - 1, end);
		if (!lines.some((line) => /^\s*(\*\*|__)?Preconditions:/.test(line))) {
			const message = 'driving section has no "Preconditions:" line';
			errors.push({ line: driving.line, message });
		}
	}
	return errors;
}

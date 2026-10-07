// Rule-to-enforcer table checker (design slice 1, requirement R16).
//
// rules.toml holds an array of tables:
//
//   [[rule]]
//   id = "no-push-to-main"                       # unique
//   statement = "Never push directly to main."   # the rule as a person would say it
//   level = "cedar"                              # see LEVELS
//   enforcer = { kind = "cedar", ref = "always-pause-default-branch" }
//   proof = { test = "test/policy.test.ts", past_mistake = "2026-09-30 agent pushed to main" }
//
// For level "instruction" (a rule that stays judgment), past_mistake may be empty, but the rule
// must carry `judgment = true` and a non-empty `judgment_reason`. Other levels must not set
// either key. Unknown keys are errors, so a typo cannot silently drop a check.
//
// Reference resolution, relative to --root:
//   enforcer.kind = "cedar"  an `@id("<ref>")` annotation in policy/*.cedar or
//                            .agents/policy/*.cedar (annotations inside // comments ignored)
//   any other kind           enforcer.ref is an existing file or directory
//   proof.test               an existing file

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const LEVELS = [
	"architecture",
	"types",
	"lint",
	"test",
	"hook",
	"cedar",
	"instruction",
] as const;
export type Level = (typeof LEVELS)[number];

const RULE_KEYS = new Set([
	"id", "statement", "level", "enforcer", "proof", "judgment", "judgment_reason",
]);
const ENFORCER_KEYS = new Set(["kind", "ref"]);
const PROOF_KEYS = new Set(["test", "past_mistake"]);
const CEDAR_DIRECTORIES = ["policy", join(".agents", "policy")];

export interface Rule {
	readonly id: string;
	readonly statement: string;
	readonly level: Level;
	readonly enforcer: { readonly kind: string; readonly ref: string };
	readonly proof: { readonly test: string; readonly past_mistake: string };
	readonly judgment: boolean;
	readonly judgmentReason: string;
	readonly line: number;
}

export interface RuleError {
	readonly line: number;
	readonly rule: string;
	readonly message: string;
}

export interface Table {
	readonly rules: readonly Rule[];
	readonly errors: readonly RuleError[];
}

export class TableError extends Error {}

export function parseTable(text: string): Table {
	let document: unknown;
	try {
		document = Bun.TOML.parse(text);
	} catch (error) {
		throw new TableError((error as Error).message);
	}
	assert.ok(typeof document === "object" && document !== null);
	const errors: RuleError[] = [];
	for (const key of Object.keys(document)) {
		if (key !== "rule") {
			errors.push({ line: 1, rule: "-", message: `unknown top-level key "${key}"` });
		}
	}
	const raw = (document as Record<string, unknown>).rule;
	if (!Array.isArray(raw)) {
		errors.push({ line: 1, rule: "-", message: "expected [[rule]] tables" });
		return { rules: [], errors };
	}
	// Line numbers come from a text scan for [[rule]] headers. If the scan disagrees with the
	// parser (a header-like line inside a multi-line string), report line 1 rather than guess.
	const headerLines = ruleHeaderLines(text);
	const lines = headerLines.length === raw.length ? headerLines : raw.map(() => 1);
	const rules: Rule[] = [];
	for (const [index, value] of raw.entries()) {
		const rule = parseRule(value, lines[index]!, errors);
		if (rule !== null) {
			rules.push(rule);
		}
	}
	return { rules, errors };
}

function ruleHeaderLines(text: string): number[] {
	const lines: number[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (/^\s*\[\[\s*rule\s*\]\]/.test(line)) {
			lines.push(index + 1);
		}
	}
	return lines;
}

function parseRule(value: unknown, line: number, errors: RuleError[]): Rule | null {
	const record = value as Record<string, unknown>;
	const label = typeof record.id === "string" && record.id !== "" ? record.id : `#${line}`;
	const before = errors.length;
	const fail = (message: string) => void errors.push({ line, rule: label, message });

	unknownKeys(record, RULE_KEYS, "", fail);
	const id = requiredString(record, "id", fail);
	const statement = requiredString(record, "statement", fail);
	const level = record.level;
	if (!LEVELS.includes(level as Level)) {
		fail(`level must be one of ${LEVELS.join(", ")}`);
	}
	const enforcer = requiredTable(record, "enforcer", ENFORCER_KEYS, fail);
	const proof = requiredTable(record, "proof", PROOF_KEYS, fail);
	const kind = enforcer === null ? "" : requiredString(enforcer, "kind", fail, "enforcer.");
	const ref = enforcer === null ? "" : requiredString(enforcer, "ref", fail, "enforcer.");
	const test = proof === null ? "" : requiredString(proof, "test", fail, "proof.");
	const pastMistake = proof === null ? "" : optionalString(proof, "past_mistake", fail, "proof.");
	const judgment = record.judgment ?? false;
	if (typeof judgment !== "boolean") {
		fail("judgment must be a boolean");
	}
	const judgmentReason = optionalString(record, "judgment_reason", fail, "");
	if (errors.length > before) {
		return null;
	}
	return {
		id,
		statement,
		level: level as Level,
		enforcer: { kind, ref },
		proof: { test, past_mistake: pastMistake },
		judgment: judgment as boolean,
		judgmentReason,
		line,
	};
}

type Fail = (message: string) => void;

function unknownKeys(record: Record<string, unknown>, known: Set<string>, prefix: string, fail: Fail) {
	for (const key of Object.keys(record)) {
		if (!known.has(key)) {
			fail(`unknown key "${prefix}${key}"`);
		}
	}
}

function requiredString(record: Record<string, unknown>, key: string, fail: Fail, prefix = ""): string {
	const value = record[key];
	if (typeof value === "string" && value.trim() !== "") {
		return value;
	}
	fail(`${prefix}${key} must be a non-empty string`);
	return "";
}

function optionalString(record: Record<string, unknown>, key: string, fail: Fail, prefix: string) {
	const value = record[key] ?? "";
	if (typeof value === "string") {
		return value;
	}
	fail(`${prefix}${key} must be a string`);
	return "";
}

function requiredTable(
	record: Record<string, unknown>,
	key: string,
	known: Set<string>,
	fail: Fail,
): Record<string, unknown> | null {
	const value = record[key];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(`${key} must be a table`);
		return null;
	}
	unknownKeys(value as Record<string, unknown>, known, `${key}.`, fail);
	return value as Record<string, unknown>;
}

export function checkTable(table: Table, root: string): RuleError[] {
	const errors = [...table.errors];
	const cedarIds = collectCedarIds(root);
	const seen = new Map<string, number>();
	for (const rule of table.rules) {
		const fail = (message: string) => void errors.push({ line: rule.line, rule: rule.id, message });
		const firstLine = seen.get(rule.id);
		if (firstLine === undefined) {
			seen.set(rule.id, rule.line);
		} else {
			fail(`duplicate id; first defined at line ${firstLine}`);
		}
		checkEnforcer(rule, root, cedarIds, fail);
		if (!existsSync(resolve(root, rule.proof.test))) {
			fail(`proof.test "${rule.proof.test}" does not exist`);
		}
		checkJudgment(rule, fail);
	}
	return errors.sort((a, b) => a.line - b.line);
}

function checkEnforcer(rule: Rule, root: string, cedarIds: ReadonlySet<string>, fail: Fail): void {
	if (rule.enforcer.kind === "cedar") {
		if (!cedarIds.has(rule.enforcer.ref)) {
			const where = CEDAR_DIRECTORIES.map((d) => `${d}/*.cedar`).join(" or ");
			fail(`no @id("${rule.enforcer.ref}") in ${where}`);
		}
	} else {
		if (!existsSync(resolve(root, rule.enforcer.ref))) {
			fail(`enforcer.ref "${rule.enforcer.ref}" does not exist`);
		}
	}
}

function checkJudgment(rule: Rule, fail: Fail): void {
	if (rule.level === "instruction") {
		if (rule.judgment !== true) {
			fail('level "instruction" requires judgment = true');
		}
		if (rule.judgmentReason.trim() === "") {
			fail('level "instruction" requires a non-empty judgment_reason');
		}
	} else {
		if (rule.proof.past_mistake.trim() === "") {
			fail("proof.past_mistake must name the real past mistake this check catches");
		}
		if (rule.judgment || rule.judgmentReason !== "") {
			fail(`judgment and judgment_reason are only allowed on level "instruction"`);
		}
	}
}

export function collectCedarIds(root: string): Set<string> {
	const ids = new Set<string>();
	for (const directory of CEDAR_DIRECTORIES.map((d) => join(root, d))) {
		if (!existsSync(directory)) {
			continue;
		}
		for (const name of readdirSync(directory).filter((n) => n.endsWith(".cedar")).sort()) {
			const source = stripCedarComments(readFileSync(join(directory, name), "utf8"));
			for (const match of source.matchAll(/@id\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
				ids.add(match[1]!);
			}
		}
	}
	return ids;
}

// Cedar has only `//` line comments. Strings may contain "//", so track string state.
export function stripCedarComments(source: string): string {
	let output = "";
	let inString = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index]!;
		if (inString) {
			output += char;
			if (char === "\\") {
				output += source[index + 1] ?? "";
				index += 1;
			} else if (char === '"') {
				inString = false;
			}
		} else if (char === '"') {
			inString = true;
			output += char;
		} else if (char === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			index = newline < 0 ? source.length : newline - 1;
		} else {
			output += char;
		}
	}
	return output;
}

// Duplicate detection. An instruction line restates a rule when, after normalization, either
//   (a) the rule statement is a substring of the line, or
//   (b) the line contains at least DUPLICATE_THRESHOLD (0.8) of the statement's distinct
//       content tokens, and the statement has at least MIN_STATEMENT_TOKENS (3) of them.
// Normalization lowercases, turns every non-alphanumeric run into one space, and for (b)
// drops STOPWORDS and a plural "s" from tokens longer than three letters. Negations and
// modals ("never", "not", "must") are kept because they carry the rule's meaning.
// Lines that mention the rule id are skipped: they point at the rule rather than restate it.
// Only rules whose level is not "instruction" are compared; instruction rules belong there.
export const DUPLICATE_THRESHOLD = 0.8;
export const MIN_STATEMENT_TOKENS = 3;
const STOPWORDS = new Set([
	"a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "by", "is", "are",
	"be", "it", "its", "this", "that", "as", "at", "from", "into", "your", "you",
]);

export interface Duplicate {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
	readonly level: Level;
	readonly score: number;
}

export function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function contentTokens(text: string): Set<string> {
	const tokens = normalize(text)
		.split(" ")
		.filter((token) => token !== "" && !STOPWORDS.has(token))
		.map((token) => (token.length > 3 && /[^s]s$/.test(token) ? token.slice(0, -1) : token));
	return new Set(tokens);
}

export function restatementScore(statement: string, line: string): number {
	const normalizedStatement = normalize(statement);
	if (normalizedStatement !== "" && ` ${normalize(line)} `.includes(` ${normalizedStatement} `)) {
		return 1;
	}
	const wanted = contentTokens(statement);
	if (wanted.size < MIN_STATEMENT_TOKENS) {
		return 0;
	}
	const present = contentTokens(line);
	const shared = [...wanted].filter((token) => present.has(token)).length;
	return shared / wanted.size;
}

export function findDuplicates(
	rules: readonly Rule[],
	file: string,
	text: string,
	threshold: number,
): Duplicate[] {
	assert.ok(threshold > 0 && threshold <= 1);
	const enforced = rules.filter((rule) => rule.level !== "instruction");
	const duplicates: Duplicate[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (line.trim() === "") {
			continue;
		}
		for (const rule of enforced) {
			if (line.includes(rule.id)) {
				continue;
			}
			const score = restatementScore(rule.statement, line);
			if (score >= threshold) {
				duplicates.push({ file, line: index + 1, rule: rule.id, level: rule.level, score });
			}
		}
	}
	return duplicates;
}

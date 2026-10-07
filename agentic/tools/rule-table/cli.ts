#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import {
	DUPLICATE_THRESHOLD,
	LEVELS,
	MIN_STATEMENT_TOKENS,
	TableError,
	checkTable,
	findDuplicates,
	parseTable,
} from "./rule-table.ts";

const USAGE = `Usage: rule-table <command> [arguments]

Validate the rule-to-enforcer table (rules.toml).

Commands:
  check <rules.toml> [--root <dir>]
      Check every [[rule]]: id, statement, level, enforcer = { kind, ref },
      proof = { test, past_mistake }. Ids must be unique. For enforcer kind "cedar", ref must
      match an @id("<ref>") annotation in policy/*.cedar or .agents/policy/*.cedar under
      --root; for other kinds, ref must be an existing path. proof.test must exist.
      past_mistake must be non-empty unless level = "instruction", which instead needs
      judgment = true and a non-empty judgment_reason. --root defaults to the directory
      containing rules.toml.
  duplicates [--rules <rules.toml>] [--threshold <n>] <instruction-file>...
      Flag instruction lines that restate a rule whose level is not "instruction": the
      normalized statement is a substring of the line, or the line holds at least
      --threshold (default ${DUPLICATE_THRESHOLD}) of the statement's content tokens (statements
      with fewer than ${MIN_STATEMENT_TOKENS} content tokens only match by substring). Lines
      naming the rule id are skipped. --rules defaults to ./rules.toml.

Levels: ${LEVELS.join(", ")}

Options:
  --help    Show this help.

Exit status: 0 clean, 1 check errors or duplicates found, 2 usage or parse error.
`;

interface Io {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
}

const defaultIo: Io = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

class UsageError extends Error {}

export function main(argv: readonly string[], io: Io = defaultIo): number {
	const [command, ...rest] = argv;
	if (command === undefined || command === "--help" || command === "-h" || rest.includes("--help")) {
		(command === undefined ? io.stderr : io.stdout)(USAGE);
		return command === undefined ? 2 : 0;
	}
	try {
		switch (command) {
			case "check":
				return runCheck(rest, io);
			case "duplicates":
				return runDuplicates(rest, io);
			default:
				throw new UsageError(`unknown command "${command}"`);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(`error: ${error.message}\n\n${USAGE}`);
			return 2;
		}
		if (error instanceof TableError) {
			io.stderr(`error: ${error.message}\n`);
			return 2;
		}
		throw error;
	}
}

function parse(rest: readonly string[], options: Record<string, { type: "string" }>) {
	try {
		return parseArgs({ args: [...rest], options, allowPositionals: true, strict: true });
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
}

function readExisting(path: string): string {
	if (!existsSync(path)) {
		throw new UsageError(`${path} does not exist`);
	}
	return readFileSync(path, "utf8");
}

function runCheck(rest: readonly string[], io: Io): number {
	const { values, positionals } = parse(rest, { root: { type: "string" } });
	if (positionals.length !== 1) {
		throw new UsageError("check takes exactly one <rules.toml>");
	}
	const rulesPath = positionals[0]!;
	const root = (values.root as string | undefined) ?? dirname(rulesPath);
	const table = parseTable(readExisting(rulesPath));
	const errors = checkTable(table, root);
	for (const error of errors) {
		io.stderr(`${rulesPath}:${error.line}: [${error.rule}] ${error.message}\n`);
	}
	if (errors.length === 0) {
		io.stdout(`${rulesPath}: ${table.rules.length} rules ok\n`);
		return 0;
	}
	return 1;
}

function runDuplicates(rest: readonly string[], io: Io): number {
	const { values, positionals } = parse(rest, {
		rules: { type: "string" },
		threshold: { type: "string" },
	});
	if (positionals.length === 0) {
		throw new UsageError("duplicates needs at least one <instruction-file>");
	}
	const threshold = Number(values.threshold ?? DUPLICATE_THRESHOLD);
	if (!(threshold > 0 && threshold <= 1)) {
		throw new UsageError("--threshold must be a number in (0, 1]");
	}
	const rulesPath = (values.rules as string | undefined) ?? "rules.toml";
	const table = parseTable(readExisting(rulesPath));
	if (table.errors.length > 0) {
		io.stderr(`error: ${rulesPath} has schema errors; run rule-table check first\n`);
		return 2;
	}
	let count = 0;
	for (const file of positionals) {
		for (const duplicate of findDuplicates(table.rules, file, readExisting(file), threshold)) {
			count += 1;
			const score = duplicate.score.toFixed(2);
			const message = `restates rule ${duplicate.rule} (level ${duplicate.level}, score ${score})`;
			io.stdout(`${duplicate.file}:${duplicate.line}: ${message}\n`);
		}
	}
	io.stdout(`${count} duplicate(s)\n`);
	return count === 0 ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}

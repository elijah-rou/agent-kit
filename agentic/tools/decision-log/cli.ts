#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	LogError,
	UsageError,
	append,
	checkEvidence,
	start,
	validate,
	type EvidenceResult,
} from "./decision-log.ts";

const USAGE = `Usage: decision-log <command> [arguments]

Append-only TSV decision trail with columns: ts phase decision why evidence result.

Commands:
  append <log> <phase> <decision> <why> <evidence> <result>
      Append one row stamped with the current ISO timestamp. Writes the header on first
      use. Tabs and newlines in cells become spaces; cells starting with = + - @ get a
      leading single quote. Put "--" before the arguments if a cell starts with "-".
  start <log> <run-id>
      Append a "start" row naming the timestamp range of prior rows this run did not write.
  validate <log> [--snapshot <prior-copy>]
      Check the header, cell count, ISO timestamps, non-empty decisions, and that rows only
      grow. With --snapshot, also prove the log starts with the earlier copy byte for byte.
  check-evidence <log> [--repo <path>]
      Resolve each evidence pointer (whitespace or comma separated). Kinds: URL and pr#N
      (format only), commit SHA (git cat-file -e in --repo), path:line (line exists), path
      (exists). Relative paths resolve against --repo (default: current directory).
      Unknown kinds are reported but do not fail.

Options:
  --help    Show this help.

Exit status: 0 success, 1 validation or evidence failure, 2 usage error.
`;

interface Io {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly now: () => Date;
}

const defaultIo: Io = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	now: () => new Date(),
};

export async function main(argv: readonly string[], io: Io = defaultIo): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "--help" || command === "-h" || rest[0] === "--help") {
		io.stdout(USAGE);
		return 0;
	}
	try {
		return run(command, rest, io);
	} catch (error) {
		if (error instanceof UsageError) {
			io.stderr(`error: ${error.message}\n\n${USAGE}`);
			return 2;
		}
		if (error instanceof LogError) {
			io.stderr(`error: ${error.message}\n`);
			return 1;
		}
		throw error;
	}
}

function run(command: string | undefined, rest: readonly string[], io: Io): number {
	switch (command) {
		case "append": {
			const args = positionalOnly(rest, 6);
			const [log, phase, decision, why, evidence, result] = args as [
				string, string, string, string, string, string,
			];
			const row = append(log, { phase, decision, why, evidence, result }, io.now());
			io.stdout(`${row.ts}\n`);
			return 0;
		}
		case "start": {
			const [log, runId] = positionalOnly(rest, 2) as [string, string];
			const row = start(log, runId, io.now());
			io.stdout(`${row.ts}\t${row.result}\n`);
			return 0;
		}
		case "validate":
			return runValidate(rest, io);
		case "check-evidence":
			return runCheckEvidence(rest, io);
		case undefined:
			throw new UsageError("missing command");
		default:
			throw new UsageError(`unknown command "${command}"`);
	}
}

// append and start take no options, so every argument is a cell value. A leading "--" is
// accepted for values that start with "-".
function positionalOnly(rest: readonly string[], count: number): string[] {
	const args = rest[0] === "--" ? rest.slice(1) : [...rest];
	if (args.length !== count) {
		throw new UsageError(`expected ${count} arguments, got ${args.length}`);
	}
	return args;
}

function parse(rest: readonly string[], option: string) {
	try {
		return parseArgs({
			args: [...rest],
			options: { [option]: { type: "string" } },
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		throw new UsageError((error as Error).message);
	}
}

function readLog(path: string): string {
	if (!existsSync(path)) {
		throw new LogError(`${path}: no such file`);
	}
	return readFileSync(path, "utf8");
}

function runValidate(rest: readonly string[], io: Io): number {
	const { values, positionals } = parse(rest, "snapshot");
	if (positionals.length !== 1) {
		throw new UsageError("validate takes exactly one <log>");
	}
	const log = positionals[0]!;
	const snapshotPath = values.snapshot as string | undefined;
	const snapshot = snapshotPath === undefined ? null : readLog(snapshotPath);
	const problems = validate(readLog(log), snapshot);
	for (const problem of problems) {
		io.stderr(`${log}:${problem.line}: ${problem.message}\n`);
	}
	if (problems.length === 0) {
		io.stdout(`${log}: ok\n`);
		return 0;
	}
	return 1;
}

function runCheckEvidence(rest: readonly string[], io: Io): number {
	const { values, positionals } = parse(rest, "repo");
	if (positionals.length !== 1) {
		throw new UsageError("check-evidence takes exactly one <log>");
	}
	const log = positionals[0]!;
	const repo = (values.repo as string | undefined) ?? process.cwd();
	if (!existsSync(repo)) {
		throw new UsageError(`--repo ${repo} does not exist`);
	}
	const results = checkEvidence(readLog(log), repo);
	for (const result of results) {
		io.stdout(`${log}:${result.line}: ${formatResult(result)}\n`);
	}
	const failures = results.filter((r) => r.status === "missing" || r.status === "invalid");
	const unknown = results.filter((r) => r.status === "unknown").length;
	io.stdout(`${results.length} pointers, ${failures.length} failed, ${unknown} unknown\n`);
	return failures.length === 0 ? 0 : 1;
}

function formatResult(result: EvidenceResult): string {
	return `${result.status} ${result.kind} ${result.pointer} (${result.detail})`;
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}

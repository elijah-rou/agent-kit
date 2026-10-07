#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { lintReport } from "./report-lint.ts";

const USAGE = `Usage: report-lint <report.md | ->

Check an agent's final report against the interaction contract (design D7).

1. The first non-empty section must be "Needs you": a heading, a bold lead
   ("**Needs you:** ..."), or a plain lead ("Needs you: ..."). "Needs you: nothing" passes.
2. In the Needs-you part, every line ending in "?" is a question. The rest of its list item
   (or paragraph) must mention Options, a Recommend(ation), and a Default.

The question check is a heuristic: it only looks inside Needs you, only sees questions that
end a line, and checks that the marker words are present, not that they are meaningful.

Use "-" to read the report from stdin. Errors print as <file>:<line>: <message>.

Options:
  --help    Show this help.

Exit status: 0 clean, 1 contract violations, 2 usage error.
`;

interface Io {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly stdin: () => string;
}

const defaultIo: Io = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	stdin: () => readFileSync(0, "utf8"),
};

export function main(argv: readonly string[], io: Io = defaultIo): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		io.stdout(USAGE);
		return 0;
	}
	const path = argv[0];
	if (argv.length !== 1 || path === undefined || (path.startsWith("-") && path !== "-")) {
		io.stderr(`error: expected one report path or "-"\n\n${USAGE}`);
		return 2;
	}
	if (path !== "-" && !existsSync(path)) {
		io.stderr(`error: ${path} does not exist\n`);
		return 2;
	}
	const text = path === "-" ? io.stdin() : readFileSync(path, "utf8");
	const errors = lintReport(text);
	const name = path === "-" ? "<stdin>" : path;
	for (const error of errors) {
		io.stderr(`${name}:${error.line}: ${error.message}\n`);
	}
	if (errors.length === 0) {
		io.stdout(`${name}: ok\n`);
		return 0;
	}
	return 1;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}

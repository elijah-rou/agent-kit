#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { lintFeatureMap } from "./feature-map-lint.ts";

const USAGE = `Usage: feature-map-lint <feature-map-dir>

Validate a verification feature map: README.md plus one Markdown file per feature.

README.md needs the H2 sections "Baseline preconditions", "Driving conventions",
"Proof and skip reporting" and "Features". Every Features link must resolve to a local file,
and every feature file must be linked from README.md.

Each feature file needs exactly one H1, a paragraph before the first H2, and exactly four H2s
in order: "Sub-features", "How to get to it (user POV)", "Driving it with <harness>",
"Gotchas". The driving section needs a "Preconditions:" line.

Errors print as <file>:<line>: <message>.

Options:
  --help    Show this help.

Exit status: 0 clean, 1 lint errors, 2 usage error.
`;

interface Io {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
}

const defaultIo: Io = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

export function main(argv: readonly string[], io: Io = defaultIo): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		io.stdout(USAGE);
		return 0;
	}
	if (argv.length !== 1 || argv[0]!.startsWith("-")) {
		io.stderr(`error: expected one feature-map directory\n\n${USAGE}`);
		return 2;
	}
	const directory = argv[0]!;
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		io.stderr(`error: ${directory} is not a directory\n`);
		return 2;
	}
	const errors = lintFeatureMap(directory);
	for (const error of errors) {
		io.stderr(`${directory}/${error.file}:${error.line}: ${error.message}\n`);
	}
	if (errors.length === 0) {
		io.stdout(`${directory}: ok\n`);
		return 0;
	}
	io.stderr(`${errors.length} error(s)\n`);
	return 1;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}

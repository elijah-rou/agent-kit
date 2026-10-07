#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readProvenance, reportItem, upstreamHead, type ItemReport } from "./upstream-drift.ts";

const DEFAULT_UPSTREAM = join(homedir(), "Projects", "cursor-plugins");
const AGENT_KIT_ROOT = join(import.meta.dir, "..", "..", "..");

const USAGE = `Usage: upstream-drift [--root <dir>] [--upstream <repo>] [--upstream-for <owner/name>=<repo>]... [--fail-on-drift]

Report upstream files that changed since each adapted item's recorded commit.

Provenance is read from <root>/skills/README.md (table rows with Local, Upstream path and
Commit columns), <root>/agentic/vendor/*/PROVENANCE (upstream_path: and commit: lines), and
<root>/provenance.toml ([[item]] with local, upstream_path, commit, and optional repo for an
upstream other than the default). For each item it runs
git -C <upstream> diff --numstat --no-renames <commit> HEAD -- <upstream_path>.

Options:
  --root <dir>       Project root (default: the agent-kit checkout holding this tool).
  --upstream <repo>  Upstream checkout (default: $UPSTREAM_DRIFT_REPO, else
                     ~/Projects/cursor-plugins).
  --upstream-for <owner/name>=<repo>
                     Checkout for provenance.toml items with that repo; repeatable. An item
                     whose repo has no checkout is reported as an error.
  --fail-on-drift    Exit 1 when any item has upstream changes.
  --help             Show this help.

Exit status: 0 report printed (drift allowed unless --fail-on-drift), 1 drift with
--fail-on-drift or a provenance or git error, 2 usage error.
`;

interface Io {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const defaultIo: Io = {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	env: process.env,
};

export function main(argv: readonly string[], io: Io = defaultIo): number {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			options: {
				root: { type: "string" },
				upstream: { type: "string" },
				"upstream-for": { type: "string", multiple: true },
				"fail-on-drift": { type: "boolean" },
				help: { type: "boolean" },
			},
			allowPositionals: false,
			strict: true,
		});
	} catch (error) {
		io.stderr(`error: ${(error as Error).message}\n\n${USAGE}`);
		return 2;
	}
	const { values } = parsed;
	if (values.help) {
		io.stdout(USAGE);
		return 0;
	}
	const root = values.root ?? AGENT_KIT_ROOT;
	const upstream = values.upstream ?? io.env.UPSTREAM_DRIFT_REPO ?? DEFAULT_UPSTREAM;
	for (const [flag, path] of [["--root", root], ["--upstream", upstream]] as const) {
		if (!existsSync(path)) {
			io.stderr(`error: ${flag} ${path} does not exist\n`);
			return 2;
		}
	}
	const others = new Map<string, string>();
	for (const pair of values["upstream-for"] ?? []) {
		const at = pair.indexOf("=");
		const path = pair.slice(at + 1);
		if (at < 1 || !existsSync(path)) {
			io.stderr(`error: --upstream-for needs owner/name=<existing checkout>, got ${pair}\n`);
			return 2;
		}
		others.set(pair.slice(0, at), path);
	}
	return report(root, upstream, others, values["fail-on-drift"] === true, io);
}

function report(root: string, upstream: string, others: ReadonlyMap<string, string>, failOnDrift: boolean, io: Io): number {
	const provenance = readProvenance(root);
	for (const error of provenance.errors) {
		io.stderr(`error: ${error}\n`);
	}
	const head = upstreamHead(upstream);
	io.stdout(`upstream ${upstream} at ${head.slice(0, 12)}\n`);
	for (const [repo, path] of others) io.stdout(`upstream ${repo} ${path} at ${upstreamHead(path).slice(0, 12)}\n`);
	// An item from another repository needs its checkout; without one it is an error, not silently skipped.
	const reports = provenance.items.map((item): ItemReport => {
		if (item.repo === undefined) return reportItem(upstream, item);
		const path = others.get(item.repo);
		return path === undefined ? { kind: "error", item, message: `no checkout for ${item.repo}; pass --upstream-for ${item.repo}=<path>` } : reportItem(path, item);
	});
	for (const entry of reports) {
		io.stdout(formatReport(entry));
	}
	const drifted = reports.filter((r) => r.kind === "ok" && r.changes.length > 0).length;
	const failed = reports.filter((r) => r.kind === "error").length + provenance.errors.length;
	io.stdout(`${reports.length} items, ${drifted} drifted, ${failed} errors\n`);
	if (failed > 0) {
		return 1;
	}
	return failOnDrift && drifted > 0 ? 1 : 0;
}

function formatReport(entry: ItemReport): string {
	const { item } = entry;
	const label = `${item.local} <- ${item.repo ? `${item.repo}:` : ""}${item.upstreamPath} @ ${item.commit.slice(0, 12)}`;
	switch (entry.kind) {
		case "error":
			return `${label}: error: ${entry.message} (${item.source})\n`;
		case "ok": {
			if (entry.changes.length === 0) {
				return `${label}: no drift\n`;
			}
			const files = entry.changes.map((c) => `  +${c.added} -${c.deleted} ${c.path}\n`);
			return `${label}: ${entry.changes.length} files changed upstream\n${files.join("")}`;
		}
		default: {
			const impossible: never = entry;
			throw new Error(`unhandled report ${JSON.stringify(impossible)}`);
		}
	}
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2));
}

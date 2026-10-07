// Upstream drift report (design D1, slice 12, requirement R18).
//
// Provenance sources, all relative to the project root; every present source is read:
//
// 1. skills/README.md: any Markdown table whose header row has the columns "Local",
//    "Upstream path" and "Commit" (case-insensitive; other columns are ignored). Backticks
//    and link syntax in cells are stripped, so `[x](./x)` and `x` both read as x.
//
//      | Local | Upstream path | Commit |
//      |---|---|---|
//      | skills/correct | pstack/skills/correct | 9f451cf |
//
// 2. agentic/vendor/<name>/PROVENANCE: leading "key: value" lines, read until the first line
//    that is not one. Required keys: upstream_path, commit. The local path is
//    agentic/vendor/<name>.
//
// 3. provenance.toml: [[item]] tables with string keys local, upstream_path, commit.
//
// An item is identified by its local path and upstream path, so a local file adapted from several
// upstream sources has one item per source. Identical items from several sources are reported
// once. Two items with the same local path and upstream path but a different commit are an error.
//
// For each item the report lists upstream files changed between the recorded commit and the
// upstream HEAD under upstream_path, from
// `git -C <upstream> diff --numstat --no-renames <commit> HEAD -- <upstream_path>`.
// (--numstat carries the same per-file counts as --stat without truncating long paths.)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Item {
	readonly local: string;
	readonly upstreamPath: string;
	readonly commit: string;
	readonly source: string;
	/** Upstream repository (owner/name) when it is not the default upstream. */
	readonly repo?: string;
}

export interface ChangedFile {
	readonly path: string;
	readonly added: string;
	readonly deleted: string;
}

export type ItemReport =
	| { readonly kind: "ok"; readonly item: Item; readonly changes: readonly ChangedFile[] }
	| { readonly kind: "error"; readonly item: Item; readonly message: string };

export interface Provenance {
	readonly items: readonly Item[];
	readonly errors: readonly string[];
}

const GIT_TIMEOUT_MS = 30_000;
const VENDOR = "agentic/vendor";

export function readProvenance(root: string): Provenance {
	const errors: string[] = [];
	const found = [
		...readSkillsReadme(join(root, "skills", "README.md"), errors),
		...readVendorProvenance(join(root, VENDOR), errors),
		...readProvenanceToml(join(root, "provenance.toml"), errors),
	];
	const byKey = new Map<string, Item>();
	for (const item of found) {
		const key = `${item.local}\0${item.upstreamPath}`;
		const existing = byKey.get(key);
		if (existing === undefined) {
			byKey.set(key, item);
		} else if (existing.commit !== item.commit) {
			errors.push(
				`${item.local} <- ${item.upstreamPath}: ${existing.source} says ${existing.commit}` +
					` but ${item.source} says ${item.commit}`,
			);
		}
	}
	const items = [...byKey.values()].sort(
		(a, b) => a.local.localeCompare(b.local) || a.upstreamPath.localeCompare(b.upstreamPath),
	);
	return { items, errors };
}

function cleanCell(cell: string): string {
	return cell
		.trim()
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`/g, "")
		.trim();
}

function tableCells(line: string): string[] {
	return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cleanCell);
}

export function parseSkillsReadme(text: string, source: string, errors: string[]): Item[] {
	const lines = text.split("\n");
	const items: Item[] = [];
	let columns: { local: number; upstream: number; commit: number } | null = null;
	for (const [index, line] of lines.entries()) {
		if (!line.trim().startsWith("|")) {
			columns = null;
			continue;
		}
		const cells = tableCells(line);
		if (columns === null) {
			const lower = cells.map((cell) => cell.toLowerCase());
			const local = lower.indexOf("local");
			const upstream = lower.indexOf("upstream path");
			const commit = lower.indexOf("commit");
			if (local >= 0 && upstream >= 0 && commit >= 0) {
				columns = { local, upstream, commit };
			}
			continue;
		}
		if (cells.every((cell) => /^:?-+:?$/.test(cell))) {
			continue;
		}
		const item = {
			local: cells[columns.local] ?? "",
			upstreamPath: cells[columns.upstream] ?? "",
			commit: cells[columns.commit] ?? "",
			source: `${source}:${index + 1}`,
		};
		if (item.local === "" || item.upstreamPath === "" || item.commit === "") {
			errors.push(`${item.source}: provenance row needs Local, Upstream path and Commit`);
		} else {
			items.push(item);
		}
	}
	return items;
}

function readSkillsReadme(path: string, errors: string[]): Item[] {
	if (!existsSync(path)) {
		return [];
	}
	return parseSkillsReadme(readFileSync(path, "utf8"), "skills/README.md", errors);
}

export function parseProvenanceFile(text: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
		if (match === null) {
			break;
		}
		fields[match[1]!] = match[2]!;
	}
	return fields;
}

function readVendorProvenance(vendor: string, errors: string[]): Item[] {
	if (!existsSync(vendor)) {
		return [];
	}
	const items: Item[] = [];
	for (const name of readdirSync(vendor).sort()) {
		const directory = join(vendor, name);
		if (!statSync(directory).isDirectory()) {
			continue;
		}
		const source = `${VENDOR}/${name}/PROVENANCE`;
		const path = join(directory, "PROVENANCE");
		if (!existsSync(path)) {
			errors.push(`${source}: missing`);
			continue;
		}
		const fields = parseProvenanceFile(readFileSync(path, "utf8"));
		const upstreamPath = fields.upstream_path ?? "";
		const commit = fields.commit ?? "";
		if (upstreamPath === "" || commit === "") {
			errors.push(`${source}: needs upstream_path and commit lines`);
			continue;
		}
		items.push({ local: `${VENDOR}/${name}`, upstreamPath, commit, source });
	}
	return items;
}

function readProvenanceToml(path: string, errors: string[]): Item[] {
	if (!existsSync(path)) {
		return [];
	}
	let document: Record<string, unknown>;
	try {
		document = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		errors.push(`provenance.toml: ${(error as Error).message}`);
		return [];
	}
	const raw = document.item;
	if (!Array.isArray(raw)) {
		errors.push("provenance.toml: expected [[item]] tables");
		return [];
	}
	const items: Item[] = [];
	for (const [index, entry] of raw.entries()) {
		const record = entry as Record<string, unknown>;
		const source = `provenance.toml item ${index + 1}`;
		const { local, upstream_path: upstreamPath, commit, repo } = record;
		const valid = [local, upstreamPath, commit].every((v) => typeof v === "string" && v !== "") && (repo === undefined || (typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo)));
		if (valid) {
			items.push({
				local: local as string,
				upstreamPath: upstreamPath as string,
				commit: commit as string,
				source,
				...(repo === undefined ? {} : { repo: repo as string }),
			});
		} else {
			errors.push(`${source}: needs string local, upstream_path and commit, and repo as owner/name when present`);
		}
	}
	return items;
}

function git(upstream: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", upstream, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr.trim() };
}

export function upstreamHead(upstream: string): string {
	const head = git(upstream, ["rev-parse", "HEAD"]);
	if (!head.ok) {
		throw new Error(`${upstream} is not a git repository with a HEAD: ${head.stderr}`);
	}
	return head.stdout.trim();
}

export function reportItem(upstream: string, item: Item): ItemReport {
	// A hex-only commit also keeps provenance text from being read as a git option.
	if (!/^[0-9a-f]{7,64}$/i.test(item.commit)) {
		return { kind: "error", item, message: `commit "${item.commit}" is not a hex SHA` };
	}
	const commit = git(upstream, ["rev-parse", "--verify", "--quiet", `${item.commit}^{commit}`]);
	if (!commit.ok) {
		return { kind: "error", item, message: `commit ${item.commit} not found upstream` };
	}
	const atCommit = git(upstream, ["cat-file", "-e", `${item.commit}:${item.upstreamPath}`]);
	if (!atCommit.ok) {
		const message = `${item.upstreamPath} does not exist at ${item.commit}`;
		return { kind: "error", item, message };
	}
	const diff = git(upstream, [
		"diff", "--numstat", "--no-renames", item.commit, "HEAD", "--", item.upstreamPath,
	]);
	if (!diff.ok) {
		return { kind: "error", item, message: `git diff failed: ${diff.stderr}` };
	}
	const changes = diff.stdout
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [added, deleted, ...path] = line.split("\t");
			assert.ok(path.length > 0, `unexpected numstat line: ${line}`);
			return { added: added!, deleted: deleted!, path: path.join("\t") };
		});
	return { kind: "ok", item, changes };
}

import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import {
	HEADER,
	append,
	checkEvidence,
	classifyPointer,
	sanitizeCell,
	start,
	validate,
} from "./decision-log.ts";

const CLI = join(import.meta.dir, "cli.ts");
const directories: string[] = [];

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "decision-log-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function at(seconds: number): Date {
	return new Date(Date.UTC(2026, 9, 7, 12, 0, seconds));
}

function row(decision: string, evidence = "") {
	return { phase: "build", decision, why: "because", evidence, result: "done" };
}

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	const io = {
		stdout: (text: string) => void out.push(text),
		stderr: (text: string) => void err.push(text),
		now: () => at(0),
	};
	return { io, out, err };
}

describe("sanitization", () => {
	it("replaces tabs and newlines with spaces", () => {
		expect(sanitizeCell("a\tb\nc\r\nd\re")).toBe("a b c d e");
	});

	it("prefixes a quote to cells that start with a formula character", () => {
		for (const lead of ["=", "+", "-", "@"]) {
			expect(sanitizeCell(`${lead}SUM(A1)`)).toBe(`'${lead}SUM(A1)`);
		}
		expect(sanitizeCell("a=b")).toBe("a=b");
		expect(sanitizeCell("'quoted")).toBe("'quoted");
	});

	it("keeps a row at six cells when inputs contain tabs and newlines", () => {
		const log = join(tempDir(), "run.tsv");
		append(log, { ...row("x\ty"), why: "line1\nline2", result: "=1+1" }, at(1));
		const lines = readFileSync(log, "utf8").split("\n");
		expect(lines[0]).toBe(HEADER);
		expect(lines[1]).toBe("2026-10-07T12:00:01.000Z\tbuild\tx y\tline1 line2\t\t'=1+1");
		expect(validate(readFileSync(log, "utf8"), null)).toEqual([]);
	});
});

describe("append", () => {
	it("writes the header once and appends rows in order", () => {
		const log = join(tempDir(), "run.tsv");
		append(log, row("first"), at(1));
		append(log, row("second"), at(2));
		const text = readFileSync(log, "utf8");
		expect(text.split("\n").filter((line) => line === HEADER)).toHaveLength(1);
		expect(text.trimEnd().split("\n")).toHaveLength(3);
	});

	it("creates a missing parent directory such as .audit/", () => {
		const log = join(tempDir(), ".audit", "task.tsv");
		append(log, row("first"), at(1));
		expect(validate(readFileSync(log, "utf8"), null)).toEqual([]);
	});

	it("refuses an empty decision and a file without the header", () => {
		const directory = tempDir();
		expect(() => append(join(directory, "a.tsv"), row("  "), at(1))).toThrow("decision");
		const foreign = join(directory, "b.tsv");
		writeFileSync(foreign, "not a log\n");
		expect(() => append(foreign, row("x"), at(1))).toThrow("header");
		expect(readFileSync(foreign, "utf8")).toBe("not a log\n");
	});
});

describe("start rows", () => {
	it("names the timestamp range of prior rows", () => {
		const log = join(tempDir(), "run.tsv");
		append(log, row("a"), at(1));
		append(log, row("b"), at(5));
		const started = start(log, "run-2", at(9));
		expect(started.phase).toBe("start");
		expect(started.decision).toBe("start run run-2");
		expect(started.result).toBe(
			"prior rows: 2, 2026-10-07T12:00:01.000Z..2026-10-07T12:00:05.000Z",
		);
	});

	it("says none on a fresh log", () => {
		const log = join(tempDir(), "run.tsv");
		expect(start(log, "run-1", at(1)).result).toBe("prior rows: none");
		expect(validate(readFileSync(log, "utf8"), null)).toEqual([]);
	});
});

describe("validate", () => {
	const good = `${HEADER}\n2026-10-07T12:00:01.000Z\tp\td\tw\t\tr\n`;

	it("accepts a well-formed log", () => {
		expect(validate(good, null)).toEqual([]);
	});

	it("reports header, cell count, timestamp, decision and formula problems with lines", () => {
		const bad = [
			"ts\tphase",
			"2026-10-07T12:00:01.000Z\tp\td\tw\tr",
			"yesterday\tp\td\tw\t\tr",
			"2026-10-07T12:00:02.000Z\tp\t\tw\t\tr",
			"2026-10-07T12:00:03.000Z\tp\td\t=cmd\t\tr",
			"",
		].join("\n");
		const messages = validate(bad, null).map((p) => `${p.line}: ${p.message}`);
		expect(messages).toEqual([
			expect.stringMatching(/^1: header/),
			"2: expected 6 cells, found 5",
			expect.stringMatching(/^3: ts "yesterday"/),
			"4: decision is empty",
			"5: why starts with a formula character",
		]);
	});

	it("detects rows that do not only grow", () => {
		const backwards = `${good}2026-10-07T11:00:00.000Z\tp\td\tw\t\tr\n`;
		expect(validate(backwards, null)).toEqual([
			{ line: 3, message: "ts goes backwards from line 2" },
		]);
	});

	it("proves append-only against a snapshot", () => {
		const grown = `${good}2026-10-07T12:00:02.000Z\tp\td2\tw\t\tr\n`;
		expect(validate(grown, good)).toEqual([]);
		const edited = good.replace("\td\t", "\tedited\t");
		expect(validate(edited, good)).toEqual([
			{ line: 2, message: "row differs from the snapshot; the log is not append-only" },
		]);
		expect(validate(`${HEADER}\n`, good)).toEqual([
			{ line: 2, message: "log is shorter than the snapshot; rows were removed" },
		]);
	});

	it("flags an unterminated final row", () => {
		expect(validate(good.trimEnd(), null)).toEqual([
			{ line: 2, message: "final row is not newline-terminated" },
		]);
	});
});

describe("evidence", () => {
	it("classifies pointer kinds", () => {
		expect(classifyPointer("https://example.com/x")).toBe("url");
		expect(classifyPointer("pr#12")).toBe("pr");
		expect(classifyPointer("9f451cf")).toBe("commit");
		expect(classifyPointer("src/a.ts:3")).toBe("file-line");
		expect(classifyPointer("notes.md")).toBe("file");
		expect(classifyPointer("docs/")).toBe("file");
		expect(classifyPointer("session:abc")).toBe("unknown");
	});

	it("resolves files, lines, commits, PRs and URLs, and reports unknown kinds", () => {
		const repo = tempDir();
		const git = (...args: string[]) => {
			const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
			expect(result.status).toBe(0);
			return result.stdout.trim();
		};
		git("init", "--quiet");
		writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
		git("add", "a.txt");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "c");
		const sha = git("rev-parse", "HEAD");
		const log = join(repo, "run.tsv");
		append(log, row("ok", `a.txt a.txt:2 ${sha} pr#4 https://example.com`), at(1));
		append(log, row("bad", "gone.txt,a.txt:3 deadbeefdeadbeef pr#x session:1"), at(2));
		const results = checkEvidence(readFileSync(log, "utf8"), repo);
		const summary = results.map((r) => `${r.line} ${r.kind} ${r.status}`);
		expect(summary).toEqual([
			"2 file ok",
			"2 file-line ok",
			"2 commit ok",
			"2 pr ok",
			"2 url ok",
			"3 file missing",
			"3 file-line missing",
			"3 commit missing",
			"3 pr invalid",
			"3 unknown unknown",
		]);
	});
});

describe("cli", () => {
	it("prints usage on --help and exits non-zero on invalid input", () => {
		const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
		expect(help.status).toBe(0);
		expect(help.stdout).toContain("Usage: decision-log");
		const bad = spawnSync(process.execPath, [CLI, "frobnicate"], { encoding: "utf8" });
		expect(bad.status).toBe(2);
		expect(bad.stderr).toContain('unknown command "frobnicate"');
	});

	it("appends, validates and checks evidence end to end", async () => {
		const directory = tempDir();
		const log = join(directory, "run.tsv");
		writeFileSync(join(directory, "proof.txt"), "x\n");
		const appended = capture();
		const cells = ["build", "-d", "w", "proof.txt", "+r"];
		expect(await main(["append", "--", log, ...cells], appended.io)).toBe(0);
		expect(readFileSync(log, "utf8")).toContain("\t'-d\t");
		expect(await main(["validate", log], capture().io)).toBe(0);
		const checked = capture();
		expect(await main(["check-evidence", log, "--repo", directory], checked.io)).toBe(0);
		expect(checked.out.join("")).toContain("ok file proof.txt");

		const snapshot = join(directory, "snapshot.tsv");
		writeFileSync(snapshot, readFileSync(log, "utf8"));
		appendFileSync(log, "2020-01-01T00:00:00.000Z\tp\td\tw\t\tr\n");
		const failed = capture();
		expect(await main(["validate", log, "--snapshot", snapshot], failed.io)).toBe(1);
		expect(failed.err.join("")).toContain(":3: ts goes backwards");
		expect(await main(["validate", log, "--bogus"], capture().io)).toBe(2);
		expect(await main(["append", log, "too", "few"], capture().io)).toBe(2);
	});
});

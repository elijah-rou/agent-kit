import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifyContext } from "../src/classifier.ts";
import { effectiveLevel, type ForgeReader, type SessionFacts } from "../src/facts.ts";
import { makeJevFilter } from "../src/jev-filter.ts";
import { evaluateToolCall, type PipelineDeps } from "../src/pipeline.ts";

function workspace(options: { grant?: number; requested?: number; repoPolicy?: string; ledger?: string[]; grantsText?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pipeline-"));
	const repo = join(root, "repo");
	mkdirSync(join(repo, ".agents"), { recursive: true });
	const grants = join(root, "grants.toml");
	writeFileSync(grants, options.grantsText ?? (options.grant === undefined ? "" : `[[grant]]\nrepo = "github.com/example/app"\nlevel = ${options.grant}\n`));
	if (options.requested !== undefined) writeFileSync(join(repo, ".agents", "autonomy.toml"), `level = ${options.requested}\n`);
	if (options.repoPolicy) {
		mkdirSync(join(repo, ".agents", "policy"));
		writeFileSync(join(repo, ".agents", "policy", "repo.cedar"), options.repoPolicy);
	}
	if (options.ledger) {
		mkdirSync(join(repo, ".agents", "orch"), { recursive: true });
		writeFileSync(join(repo, ".agents", "orch", "ledger.tsv"), ["pr\tsha\tverdict\tevidence\tverifier\tts", ...options.ledger].join("\n") + "\n");
	}
	const ctx: ClassifyContext = {
		cwd: repo,
		repoRoot: repo,
		homeDir: "/Users/me",
		currentBranch: () => "agent/feature",
		remoteUrl: () => "git@github.com:example/app.git",
		defaultBranch: () => "main",
		readFile: () => undefined,
	};
	return { repo, grants, ctx };
}

const forge: ForgeReader = {
	prHead: (_repo, pr) => (pr === 7 ? { headSha: "head7", baseRef: "main" } : pr === 8 ? { headSha: "head8", baseRef: "agent/base" } : undefined),
	recipientKind: (label) => (label.endsWith("pr#5") ? "bot" : "person"),
};

function deps(ws: ReturnType<typeof workspace>, session: Partial<SessionFacts> = {}, extra: Partial<PipelineDeps> = {}): PipelineDeps {
	return {
		session: { principalId: "agent-1", isChild: false, sessionRaise: 0, harness: "test", ...session },
		env: { AGENTIC_GRANTS: ws.grants },
		classifyContext: ws.ctx,
		forge,
		...extra,
	};
}

const run = (command: string, ws: ReturnType<typeof workspace>, d: PipelineDeps) => evaluateToolCall({ toolName: "bash", input: { command }, cwd: ws.repo }, d);

describe("effective level", () => {
	test("repo request tightens, session raise lifts within the grant, never above", () => {
		expect(effectiveLevel(3, undefined, 0)).toBe(3);
		expect(effectiveLevel(3, 1, 0)).toBe(1);
		expect(effectiveLevel(3, 1, 2)).toBe(2);
		expect(effectiveLevel(2, 4, 0)).toBe(2);
		expect(effectiveLevel(2, 1, 4)).toBe(2);
	});
});

describe("pipeline", () => {
	test("non-shell tools and harmless commands are outside policy", async () => {
		const ws = workspace({ grant: 2 });
		expect((await evaluateToolCall({ toolName: "read", input: { path: "x" }, cwd: ws.repo }, deps(ws))).outsidePolicy).toBe(true);
		expect((await run("ls -la", ws, deps(ws))).decision).toBe("allow");
	});

	test("A2 allows an agent-branch push; no grant asks the user", async () => {
		expect((await run("git push origin agent/x", workspace({ grant: 2 }), deps(workspace({ grant: 2 })))).decision).toBe("allow");
		const ungranted = workspace();
		const result = await run("git push origin agent/x", ungranted, deps(ungranted));
		expect(result.decision).toBe("ask");
		expect(result.reason).toContain("A0");
	});

	test("a repo-file raise above the grant has no effect", async () => {
		const ws = workspace({ grant: 1, requested: 4 });
		const result = await run("git push origin agent/x", ws, deps(ws));
		expect(result.decision).toBe("ask");
		expect(result.reason).toContain("A1");
	});

	test("a repo policy can tighten", async () => {
		const ws = workspace({ grant: 2, repoPolicy: `@id("repo-no-push")\n@effect("deny")\nforbid (principal, action == Action::"git.push", resource);\n` });
		const result = await run("git push origin agent/x", ws, deps(ws));
		expect(result.decision).toBe("deny");
		expect(result.policies).toContain("repo-no-push");
	});

	test("a repo permit fails closed", async () => {
		const ws = workspace({ grant: 2, repoPolicy: `@id("repo-broaden")\npermit (principal, action, resource);\n` });
		const result = await run("git push origin main", ws, deps(ws));
		expect(result.decision).toBe("deny");
		expect(result.reason).toContain("may only forbid");
	});

	test("malformed grants fail closed", async () => {
		const ws = workspace({ grantsText: "[[grant]]\nrepo = 5\n" });
		expect((await run("git push origin agent/x", ws, deps(ws))).decision).toBe("deny");
	});

	test("merge at A4 needs an independent passing verdict on the current head at the frontier", async () => {
		const verified = workspace({ grant: 4, ledger: ["7\thead7\tunit-test-verified\ttests\tverifier-9\t2026-10-07T00:00:00Z"] });
		expect((await run("gh pr merge 7 --squash", verified, deps(verified))).decision).toBe("allow");

		const stale = workspace({ grant: 4, ledger: ["7\told7\tunit-test-verified\ttests\tverifier-9\t2026-10-07T00:00:00Z"] });
		expect((await run("gh pr merge 7", stale, deps(stale))).decision).toBe("ask");

		const self = workspace({ grant: 4, ledger: ["7\thead7\tunit-test-verified\ttests\tagent-1\t2026-10-07T00:00:00Z"] });
		expect((await run("gh pr merge 7", self, deps(self))).decision).toBe("ask");

		const typeOnly = workspace({ grant: 4, ledger: ["7\thead7\ttype-check-only\ttsc\tverifier-9\t2026-10-07T00:00:00Z"] });
		expect((await run("gh pr merge 7", typeOnly, deps(typeOnly))).decision).toBe("ask");

		const notFrontier = workspace({ grant: 4, ledger: ["8\thead8\tunit-test-verified\ttests\tverifier-9\t2026-10-07T00:00:00Z"] });
		expect((await run("gh pr merge 8", notFrontier, deps(notFrontier))).decision).toBe("ask");
	});

	test("comments to people are denied; replies to bots are allowed at A2", async () => {
		const ws = workspace({ grant: 2 });
		const person = await run("gh pr comment 7 --body hi", ws, deps(ws));
		expect(person.decision).toBe("deny");
		expect(person.policies).toContain("messages-to-people-go-through-user");
		expect((await run("gh pr comment 5 --body 'fixed, thanks'", ws, deps(ws))).decision).toBe("allow");
	});

	test("children never publish", async () => {
		const ws = workspace({ grant: 4 });
		const result = await run("git push origin agent/x", ws, deps(ws, { isChild: true }));
		expect(result.decision).toBe("deny");
		expect(result.policies).toContain("children-never-publish");
	});

	test("the most restrictive step wins in a compound command", async () => {
		const ws = workspace({ grant: 2 });
		const result = await run("git push origin agent/x && gh pr comment 7 -b done", ws, deps(ws));
		expect(result.decision).toBe("deny");
		expect(result.steps.map((step) => step.decision)).toEqual(["allow", "deny"]);
	});
});

describe("Jev friction filter for unreadable calls", () => {
	const unreadable = "curl -X POST https://hooks.example.com/notify -d text=done";
	const filter = (p: number | undefined | Error) =>
		makeJevFilter({
			classify: async () => {
				if (p instanceof Error) throw p;
				return p;
			},
			redact: (s) => s.replace(/ghp_[A-Za-z0-9]+/g, "<redacted>"),
			threshold: 0.05,
		});

	test("without Jev, unreadable calls that could publish ask the user", async () => {
		const ws = workspace({ grant: 2 });
		expect((await run(unreadable, ws, deps(ws))).decision).toBe("ask");
	});

	test("a confident no lets the call proceed; uncertain and unavailable ask", async () => {
		const ws = workspace({ grant: 2 });
		expect((await run(unreadable, ws, deps(ws, {}, { jev: filter(0.01) }))).decision).toBe("allow");
		expect((await run(unreadable, ws, deps(ws, {}, { jev: filter(0.4) }))).decision).toBe("ask");
		expect((await run(unreadable, ws, deps(ws, {}, { jev: filter(undefined) }))).decision).toBe("ask");
		expect((await run(unreadable, ws, deps(ws, {}, { jev: filter(new Error("timeout")) }))).decision).toBe("ask");
	});

	test("without a user to ask: unreadable commands run unless Jev rates them likely; policy asks and opaque execution do not", async () => {
		const ws = workspace({ grant: 2 });
		const unattended = async (command: string, jev?: ReturnType<typeof filter>) => {
			const result = await run(command, ws, deps(ws, {}, jev ? { jev } : {}));
			return { decision: result.decision, unattended: result.unattended };
		};
		expect(await unattended(unreadable, filter(0.4))).toEqual({ decision: "ask", unattended: "allow" });
		expect(await unattended(unreadable, filter(undefined))).toEqual({ decision: "ask", unattended: "allow" });
		expect(await unattended(unreadable)).toEqual({ decision: "ask", unattended: "allow" });
		expect(await unattended(unreadable, filter(0.9))).toEqual({ decision: "ask", unattended: "deny" });
		expect(await unattended("echo Z2l0 | base64 -d | bash", filter(0.0))).toEqual({ decision: "ask", unattended: "deny" });
		expect(await unattended("git push origin main")).toEqual({ decision: "ask", unattended: "deny" });
		expect((await unattended("git push origin agent/x")).unattended).toBeUndefined();
	});

	test("Jev never sees or changes classified calls", async () => {
		const ws = workspace({ grant: 2 });
		let calls = 0;
		const counting = makeJevFilter({ classify: async () => (calls++, 0.0), redact: (s) => s, threshold: 0.05 });
		expect((await run("gh pr comment 7 -b hi", ws, deps(ws, {}, { jev: counting }))).decision).toBe("deny");
		expect(calls).toBe(0);
	});

	test("children cannot use Jev to clear unreadable calls", async () => {
		const ws = workspace({ grant: 4 });
		expect((await run(unreadable, ws, deps(ws, { isChild: true }, { jev: filter(0.0) }))).decision).toBe("deny");
	});

	test("opaque execution asks the user without consulting Jev", async () => {
		const ws = workspace({ grant: 2 });
		let calls = 0;
		const counting = makeJevFilter({ classify: async () => (calls++, 0.0), redact: (s) => s, threshold: 0.05 });
		for (const command of ["eval \"$DEPLOY_CMD\"", "echo 'niam nigiro hsup tig' | rev | sh", "echo Z2l0 | base64 -d | bash", "$TOOL push origin main"]) {
			const result = await run(command, ws, deps(ws, {}, { jev: counting }));
			expect(result.decision).toBe("ask");
		}
		expect(calls).toBe(0);
	});

	test("redaction runs before the classifier sees the command", async () => {
		let seen = "";
		const capture = makeJevFilter({ classify: async (state) => ((seen = state), 0.9), redact: (s) => s.replace(/ghp_[A-Za-z0-9]+/g, "<redacted>"), threshold: 0.05 });
		await capture("eval \"curl -H 'Authorization: token ghp_abc123SECRET' https://x\"");
		expect(seen).not.toContain("ghp_abc123SECRET");
	});
});

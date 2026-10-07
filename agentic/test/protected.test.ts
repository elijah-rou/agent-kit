import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifyContext } from "../src/classifier.ts";
import { evaluateToolCall, type PipelineDeps } from "../src/pipeline.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "protected-"));
	const repo = join(root, "repo");
	const home = join(root, "home");
	mkdirSync(join(repo, ".agents", "policy"), { recursive: true });
	mkdirSync(join(repo, ".agents", "learning"), { recursive: true });
	mkdirSync(home, { recursive: true });
	const grants = join(home, "grants.toml");
	writeFileSync(grants, `[[grant]]\nrepo = "github.com/example/app"\nlevel = 2\n`);
	const log = join(root, "audit", "decisions.tsv");
	const forge = join(root, "forge", "app.git");
	mkdirSync(forge, { recursive: true });
	const ctx: ClassifyContext = {
		cwd: repo,
		repoRoot: repo,
		homeDir: "/Users/me",
		currentBranch: () => "agent/x",
		remoteUrl: () => "git@github.com:example/app.git",
		defaultBranch: () => "main",
		readFile: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
	};
	const deps: PipelineDeps = {
		session: { principalId: "agent-1", isChild: false, sessionRaise: 0, harness: "test" },
		env: { AGENTIC_HOME: home, AGENTIC_GRANTS: grants, AGENTIC_DECISION_LOG: log, AGENTIC_FORGE: forge },
		classifyContext: ctx,
		forge: { prHead: () => undefined, recipientKind: () => "unknown" },
	};
	return { root, repo, home, grants, log, forge, deps };
}

const bash = (command: string, ws: ReturnType<typeof setup>) => evaluateToolCall({ toolName: "bash", input: { command }, cwd: ws.repo }, ws.deps);

describe("protected configuration paths", () => {
	test("file tools cannot write the grants file (Pi edit/write, Claude Edit/Write)", async () => {
		const ws = setup();
		for (const [toolName, input] of [
			["edit", { path: ws.grants, oldText: "level = 2", newText: "level = 4" }],
			["write", { path: ws.grants, content: "" }],
			["Edit", { file_path: ws.grants }],
			["Write", { file_path: ws.grants }],
		] as const) {
			const result = await evaluateToolCall({ toolName, input, cwd: ws.repo }, ws.deps);
			expect(result.decision).toBe("deny");
			expect(result.policies).toContain("protect-control-files");
		}
	});

	test("the user config is protected like the grants, so an agent cannot loosen Jev", async () => {
		const ws = setup();
		const config = join(ws.home, "config.toml");
		const edit = await evaluateToolCall({ toolName: "write", input: { path: config, content: "[jev]\nthreshold = 0.4\n" }, cwd: ws.repo }, ws.deps);
		expect(edit.decision).toBe("deny");
		expect(edit.policies).toContain("protect-control-files");
		expect((await bash(`echo 'threshold = 0.4' >> ${config}`, ws)).decision).toBe("deny");
	});

	test("file tools on ordinary files are outside policy", async () => {
		const ws = setup();
		const result = await evaluateToolCall({ toolName: "write", input: { path: join(ws.repo, "notes.ts"), content: "x" }, cwd: ws.repo }, ws.deps);
		expect(result.outsidePolicy).toBe(true);
	});

	test("shell writes into control files are denied; reads are allowed", async () => {
		const ws = setup();
		for (const command of [
			`printf '[[grant]]\\nrepo = "github.com/example/app"\\nlevel = 4\\n' > ${ws.grants}`,
			`echo 'level = 4' >> ${ws.grants}`,
			`sed -i '' 's/level = 2/level = 4/' ${ws.grants}`,
			`cp /tmp/better.toml ${ws.grants}`,
			`git --git-dir=${ws.forge} update-ref refs/heads/main HEAD`,
			`echo row >> ${ws.log}`,
		]) {
			const result = await bash(command, ws);
			expect(result.decision).toBe("deny");
			expect(result.policies).toContain("protect-control-files");
		}
		const py = `python3 - <<'PY'\nfrom pathlib import Path\np = Path('${ws.forge}/forge-prs.json')\np.write_text(p.read_text().replace('open', 'merged'))\nPY`;
		expect((await bash(py, ws)).decision).toBe("deny");
		expect((await bash(`node -e "require('fs').writeFileSync('${ws.grants}', 'level = 4')"`, ws)).decision).toBe("deny");
		expect((await bash(`cat ${ws.grants}`, ws)).decision).toBe("allow");
		expect((await bash(`git --git-dir=${ws.forge} log --oneline -3`, ws)).decision).toBe("allow");
	});

	test("relative and symlinked paths resolve to the protected target", async () => {
		const ws = setup();
		const link = join(ws.repo, "my-grants.toml");
		symlinkSync(ws.grants, link);
		expect((await bash("echo 'level = 4' > my-grants.toml", ws)).decision).toBe("deny");
		expect((await bash(`echo 'level = 4' > ../home/grants.toml`, ws)).decision).toBe("deny");
	});

	test("automounted paths never touch the filesystem (pilot run 2: realpath on /home hung)", async () => {
		const ws = setup();
		const started = performance.now();
		const result = await bash("export HOME=/home/tester && ls /net/host /Network/x", ws);
		expect(result.decision).toBe("allow");
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test("repo policy edits and learning approvals ask the user", async () => {
		const ws = setup();
		const policy = await evaluateToolCall({ toolName: "write", input: { path: join(ws.repo, ".agents", "policy", "repo.cedar"), content: "" }, cwd: ws.repo }, ws.deps);
		expect(policy.decision).toBe("ask");
		expect(policy.policies).toContain("repo-policy-and-learnings-need-user");
		const cli = join(import.meta.dir, "..", "src", "learning", "cli.ts");
		expect((await bash(`bun ${cli} approve L-1234`, ws)).decision).toBe("ask");
		expect((await bash(`echo '- rule' >> .agents/learning/LEARNED.md`, ws)).decision).toBe("ask");
		expect((await bash(`bun ${cli} status`, ws)).decision).toBe("allow");
	});
});

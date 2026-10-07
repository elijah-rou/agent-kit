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

	test("~ and @ paths, cd, parent directories, and prefix assignments still reach protected paths", async () => {
		const ws = setup();
		const deps = { ...ws.deps, classifyContext: { ...ws.deps.classifyContext!, homeDir: ws.home.replace(/\/home$/, "") } };
		// homeDir is the setup root, so ~/home/grants.toml is the grants file.
		const run = (command: string) => evaluateToolCall({ toolName: "bash", input: { command }, cwd: ws.repo }, deps);
		for (const command of [
			"echo x > ~/home/grants.toml",
			"cp /tmp/x ~/home/config.toml",
			`cd ${ws.home} && sed -i '' s/2/4/ grants.toml`,
			`mv ${ws.home} /tmp/old-home`,
			`cp -R /tmp/fake ${ws.home}`,
			"ORCH_STORE=.agents/orch agentic orch ledger record --pr 5 --verdict pass",
		]) {
			expect({ command, decision: (await run(command)).decision }).toEqual({ command, decision: "deny" });
		}
		// .agents also holds the verdict ledger, so removing it is blocked; the policy folder alone asks.
		expect((await run("rm -rf .agents")).decision).toBe("deny");
		expect((await run("rm -rf .agents/policy")).decision).toBe("ask");
		for (const [toolName, path] of [["edit", "~/home/grants.toml"], ["write", `@${ws.grants}`]] as const) {
			expect((await evaluateToolCall({ toolName, input: { path, oldText: "2", newText: "4" }, cwd: ws.repo }, deps)).decision).toBe("deny");
		}
		expect((await run(`cp notes.txt ${ws.repo}`)).decision).toBe("allow");
		expect((await run("cd src && echo x > notes.txt")).decision).toBe("allow");
	});

	test("files that wire the gate in ask the user: harness settings and the gate's own code", async () => {
		const ws = setup();
		const claudeHome = join(ws.root, "claude");
		const deps = { ...ws.deps, env: { ...ws.deps.env, CLAUDE_CONFIG_DIR: claudeHome, PI_CODING_AGENT_DIR: join(ws.root, "pi") } };
		for (const path of [join(claudeHome, "settings.json"), join(ws.root, "pi", "settings.json"), join(ws.repo, ".claude", "settings.local.json"), join(import.meta.dir, "..", "src", "pipeline.ts")]) {
			const result = await evaluateToolCall({ toolName: "write", input: { path, content: "{}" }, cwd: ws.repo }, deps);
			expect({ path, decision: result.decision, policies: result.policies }).toEqual({ path, decision: "ask", policies: ["gate-wiring-needs-user"] });
		}
		const policy = await evaluateToolCall({ toolName: "write", input: { path: join(import.meta.dir, "..", "policy", "global.cedar"), content: "" }, cwd: ws.repo }, deps);
		expect(policy.decision).toBe("deny");
	});

	test("cd that fails or sits in a subshell, env and $PWD assignments, copies into a grandparent", async () => {
		const ws = setup();
		const deps = { ...ws.deps, classifyContext: { ...ws.deps.classifyContext!, homeDir: ws.root } };
		const run = async (command: string) => ({ command, decision: (await evaluateToolCall({ toolName: "bash", input: { command }, cwd: ws.repo }, deps)).decision });
		for (const command of [
			"cd /nonexistent; rm -rf .agents/orch",
			"(cd /tmp); rm -rf .agents/orch",
			"cd src; cd -; rm -rf .agents/orch",
			"env ORCH_STORE=.agents/orch agentic orch ledger record 1 a pass",
			"ORCH_STORE=$PWD/.agents/orch agentic orch ledger record 1 a pass",
			'ORCH_STORE="$(pwd)/.agents/orch" agentic orch ledger record 1 a pass',
			"cp -R fake/.agents .",
			"rsync -a fake/ ./",
		]) {
			expect(await run(command)).toEqual({ command, decision: "deny" });
		}
		expect(await run("pushd /tmp; popd; echo x > .agents/policy/a")).toEqual({ command: "pushd /tmp; popd; echo x > .agents/policy/a", decision: "ask" });
		for (const command of ["cp file .", "rm -rf build", "mv a b", "cd src && npm test", "git clean -fd", "cp -R src dist", "rsync -a src/ dist/", "git checkout -b topic"]) {
			expect(await run(command)).toEqual({ command, decision: "allow" });
		}
	});

	test("cd ~ then removing the harness settings directory asks", async () => {
		const ws = setup();
		const deps = { ...ws.deps, env: { ...ws.deps.env, CLAUDE_CONFIG_DIR: join(ws.root, ".claude") }, classifyContext: { ...ws.deps.classifyContext!, homeDir: ws.root } };
		const result = await evaluateToolCall({ toolName: "bash", input: { command: "cd ~ && rm -rf .claude" }, cwd: ws.repo }, deps);
		expect(result.policies).toEqual(["gate-wiring-needs-user"]);
	});

	test("rewriting the gate's checkout or moving bootstrap's link to it asks", async () => {
		const ws = setup();
		const kit = join(import.meta.dir, "..", "..");
		const bootstrapRoot = join(ws.root, "bootstrap");
		mkdirSync(join(bootstrapRoot, "tools"), { recursive: true });
		symlinkSync(kit, join(bootstrapRoot, "tools", "agent-kit"));
		const deps = { ...ws.deps, env: { ...ws.deps.env, BOOTSTRAP_ROOT: bootstrapRoot } };
		for (const command of [`git -C ${kit} checkout --detach main`, `git -C ${kit} reset --hard HEAD~3`, `mv ${bootstrapRoot}/tools /tmp/t`, `rm ${bootstrapRoot}/tools/agent-kit`]) {
			const result = await evaluateToolCall({ toolName: "bash", input: { command }, cwd: ws.repo }, deps);
			// Removing the link resolves through it to the kit, above the blocked global policies.
			expect({ command, stopped: result.policies.some((id) => ["gate-wiring-needs-user", "protect-control-files"].includes(id)) }).toEqual({ command, stopped: true });
		}
		const commit = await evaluateToolCall({ toolName: "bash", input: { command: `git -C ${kit} status` }, cwd: ws.repo }, deps);
		expect(commit.decision).toBe("allow");
	});

	test("cd semantics: certain after &&, uncertain after ; or a subshell; ordinary cd work stays allowed", async () => {
		const ws = setup();
		const run = async (command: string) => ({ command, decision: (await evaluateToolCall({ toolName: "bash", input: { command }, cwd: ws.repo }, ws.deps)).decision });
		for (const command of ["cd src && mv ../a.ts .", "cd src && rsync -a ../build/ .", "cd /tmp/scratch && cp -R ../tmpl/ .", "cd a && cd b && rm -rf build", "(cd src && make); ls", "cd .agents/policy && ls", "pushd .agents && popd"]) {
			expect(await run(command)).toEqual({ command, decision: "allow" });
		}
		for (const command of ["cd /nonexistent && true; rm -rf .agents/orch", "cd src || rm -rf .agents/orch", "ORCH_STORE=.agents/orch; export ORCH_STORE; agentic orch status", "ditto fake ."]) {
			expect(await run(command)).toEqual({ command, decision: "deny" });
		}
	});

	test("git rewrites of the gate's checkout through any work-tree form ask", async () => {
		const ws = setup();
		const kit = join(import.meta.dir, "..", "..");
		for (const command of [`git -C ${kit} sparse-checkout set docs`, `git -C ${kit} read-tree -u --reset HEAD~3`, `git -C ${kit} checkout-index -f -a`, `git --work-tree=${kit} --git-dir=${kit}/.git checkout --detach main`, `GIT_WORK_TREE=${kit} git checkout main -- .`]) {
			const result = await evaluateToolCall({ toolName: "bash", input: { command }, cwd: ws.repo }, ws.deps);
			expect({ command, policies: result.policies }).toEqual({ command, policies: ["gate-wiring-needs-user"] });
		}
	});

	test("naming the gate's own files in a variable is not a write", async () => {
		const ws = setup();
		const cli = join(import.meta.dir, "..", "bin", "agentic");
		const result = await evaluateToolCall({ toolName: "bash", input: { command: `A=${cli}; echo "$A"` }, cwd: ws.repo }, ws.deps);
		expect(result.decision).toBe("allow");
	});
});

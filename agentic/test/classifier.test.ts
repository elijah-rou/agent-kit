import { describe, expect, test } from "bun:test";
import { classifyCommand, repoIdentity, type ClassifyContext } from "../src/classifier.ts";

const files: Record<string, string> = {
	"/work/app/publish.sh": "#!/bin/sh\nset -e\ngit push origin HEAD:main\n",
	"/work/app/build.sh": "#!/bin/sh\nbun test\nbun build src/index.ts\n",
	"/work/app/tool.py": "import subprocess\nsubprocess.run(['gh', 'pr', 'merge', '7'])\n",
	"/work/app/report.py": "print(sum(range(10)))\n",
	"/work/app/verify.sh": "#!/bin/sh\nset -eu\nrecord() {\n  echo \"+ $*\" >> \"$LOG\"\n  \"$@\"\n}\ncase \"$1\" in\n  launch) record docker run -d --name verify debian:13 sleep 600 ;;\n  cleanup) record docker rm -f verify ;;\nesac\n",
	"/work/app/ship.sh": "#!/bin/sh\nrun() { \"$@\"; }\nrun git push origin main\n",
	"/work/app/wrap.sh": "#!/bin/sh\nset -e\n\"$@\"\n",
	"/work/app/dyn.sh": "#!/bin/sh\nCMD=git\n$CMD push origin main\n",
	"/work/app/bin/gh-like": "#!/usr/bin/env bun\nconst name = `${process.argv[2]}`;\nfetch(\"https://api.example.com\");\n",
	"/work/app/bin/fmt": "#!/usr/bin/env node\nconsole.log(`${1 + 1}`)\n",
	"/work/app/bin/push": "#!/bin/bash\ngit push origin main\n",
	"/work/app/tests/container.sh": "#!/usr/bin/env bash\nset -euo pipefail\nrepo=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd -P)\"\ncid=\"$(<\"$repo/container.id\")\"\ndocker run --rm debian:13 true\n",
	"/work/app/arch.sh": "#!/bin/sh\ncase \"$(uname -s)/$(uname -m)\" in\n  Linux/x86_64) echo amd64 ;;\n  Darwin/arm64|Linux/aarch64) echo arm64 ;;\n  *) git push origin main ;;\nesac\n",
	"/work/app/capture.sh": "#!/bin/sh\ncapture() { local label=\"$1\"; shift; \"$@\" > \"/tmp/$label.out\"; }\ncapture listing docker ps\ncapture shipit git push origin agent/x\n",
	"/work/app/logging.sh": "#!/bin/sh\nwarn() { printf '%s\\n' \"$*\" >&2; }\ndie() { warn \"$@\"; exit 1; }\n[ -n \"$x\" ] || die \"$backup already exists\"\ncommand -v $bin >/dev/null\n",
	"/work/app/package.json": JSON.stringify({ scripts: { ship: "git push origin agent/ship", lint: "eslint ." } }),
};

const ctx: ClassifyContext = {
	cwd: "/work/app",
	repoRoot: "/work/app",
	homeDir: "/Users/me",
	currentBranch: () => "agent/feature",
	remoteUrl: (_cwd, remote) => (remote === "origin" ? "git@github.com:example/app.git" : undefined),
	defaultBranch: () => "main",
	readFile: (path) => files[path],
};

type Expect =
	| { actions: [string, string?][]; unclassified?: number }
	| { none: true }
	| { unclassified: number; couldReach?: boolean };

const cases: [string, Expect][] = [
	// Outside policy
	["ls -la && cat README.md | head -20", { none: true }],
	["git status && git log --oneline -5", { none: true }],
	["git push --dry-run origin main", { none: true }],
	["gh pr view 7 --json title", { none: true }],
	["gh api repos/example/app/pulls/7", { none: true }],
	["curl -s https://api.github.com/repos/example/app", { none: true }],
	["bun test && bun build src/index.ts", { none: true }],
	["bash build.sh", { none: true }],
	["python3 report.py", { none: true }],
	["npm run lint", { none: true }],
	["rm -rf node_modules dist", { none: true }],
	["echo 'git push origin main' > notes.txt", { none: true }],
	// Pushes
	["git push", { actions: [["git.push", "agent/feature"]] }],
	["git push origin agent/x", { actions: [["git.push", "agent/x"]] }],
	["git push origin HEAD:main", { actions: [["git.push", "main"]] }],
	["git push -f origin release", { actions: [["git.push", "release"]] }],
	["git push origin +agent/x:agent/x", { actions: [["git.push", "agent/x"]] }],
	["git push origin --delete old-feature", { actions: [["git.delete_remote_branch", "old-feature"]] }],
	["git push origin :old-feature", { actions: [["git.delete_remote_branch", "old-feature"]] }],
	["git -C ../other push origin main", { actions: [["git.push", "main"]] }],
	["git push origin v1.2.0:refs/tags/v1.2.0", { actions: [["release.publish"]] }],
	["git push --tags", { actions: [["release.publish"]] }],
	["FOO=1 env BAR=2 timeout 30 git push origin agent/y", { actions: [["git.push", "agent/y"]] }],
	// Nested shells and scripts
	["bash -c 'cd /tmp/x && git push origin HEAD:main'", { actions: [["git.push", "main"]] }],
	["sh -c \"git push origin agent/z\"", { actions: [["git.push", "agent/z"]] }],
	["bash publish.sh", { actions: [["git.push", "main"]] }],
	["./publish.sh", { actions: [["git.push", "main"]] }],
	["npm run ship", { actions: [["git.push", "agent/ship"]] }],
	["bun run ship", { actions: [["git.push", "agent/ship"]] }],
	// gh
	["gh pr create --fill", { actions: [["pr.create"]] }],
	["gh pr merge 7 --squash", { actions: [["pr.merge"]] }],
	["gh pr merge 1 --repo origin --merge", { actions: [["pr.merge"]] }],
	["gh pr comment 7 --body 'looks good'", { actions: [["comment.post"]] }],
	["gh issue comment 12 -b thanks", { actions: [["comment.post"]] }],
	["gh pr review 7 --approve", { actions: [["comment.post"]] }],
	["gh release create v1.0.0", { actions: [["release.publish"]] }],
	["gh secret set TOKEN", { actions: [["credential.change"]] }],
	["gh api -X POST repos/example/app/issues/12/comments -f body=hi", { actions: [["comment.post"]] }],
	["gh api repos/example/app/pulls/7/comments/99/replies -f body=done", { actions: [["comment.post"]] }],
	["gh api -X PUT repos/example/app/pulls/7/merge", { actions: [["pr.merge"]] }],
	// HTTP clients
	["curl -X POST https://api.github.com/repos/example/app/issues/3/comments -d '{\"body\":\"x\"}'", { actions: [["comment.post"]] }],
	["curl -s -XPUT https://api.github.com/repos/example/app/pulls/7/merge", { actions: [["pr.merge"]] }],
	// Deploy, release, credentials, data
	["npm publish --access public", { actions: [["release.publish"]] }],
	["kubectl apply -f deploy.yaml", { actions: [["deploy"]] }],
	["terraform destroy -auto-approve", { actions: [["deploy"]] }],
	["security add-generic-password -s x -w y", { actions: [["credential.change"]] }],
	["rm -rf ~/Documents/old", { actions: [["data.delete"]] }],
	["rm -rf /var/folders/5r/abc123/T/tmp.ir6kV6C7vW", { none: true }],
	["rm -rf /tmp/build-context", { none: true }],
	// A script reached through cd is read from the directory the shell moved to
	["cd /work/app/tests && ./container.sh", { none: true }],
	["cd /work && app/bin/push", { actions: [["git.push", "main"]] }],
	// Forwarding functions and parse-only shells
	["./verify.sh launch", { none: true }],
	["bash verify.sh cleanup", { none: true }],
	["./ship.sh", { actions: [["git.push", "main"]] }],
	["./wrap.sh git push origin agent/w", { actions: [["git.push", "agent/w"]] }],
	["./wrap.sh ls -la", { none: true }],
	["bash -n publish.sh", { none: true }],
	["./dyn.sh", { unclassified: 1 }],
	// Pilot run 2 findings
	["./tests/container.sh debian:13 user", { none: true }],
	["repo=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd -P)\"", { none: true }],
	["cid=\"$(<container.id)\"", { none: true }],
	["./arch.sh", { actions: [["git.push", "main"]] }],
	["./capture.sh", { actions: [["git.push", "agent/x"]] }],
	["X=\"$(git push origin main)\"", { actions: [["git.push", "main"]] }],
	["case \"$(git push origin main)\" in *) : ;; esac", { actions: [["git.push", "main"]] }],
	["./logging.sh", { none: true }],
	["[[ $(git push origin main) == ok ]]", { actions: [["git.push", "main"]] }],
	["[[ $sha =~ ^[0-9a-f]{64}$ ]] || exit 1", { none: true }],
	["[[ \"$url\" == https://* && \"$sha\" =~ ^[0-9a-f]{64}$ ]] || die bad", { none: true }],
	["[[ -n $x && ( $y < 3 ) ]] && git push origin main", { actions: [["git.push", "main"]] }],
	// Keywords and one-line functions must not hide commands
	["f() { git push origin main; }; f", { actions: [["git.push", "main"]] }],
	["if git push origin main; then echo ok; fi", { actions: [["git.push", "main"]] }],
	["while true; do gh pr merge 7; done", { actions: [["pr.merge"]] }],
	["! git push origin release", { actions: [["git.push", "release"]] }],
	["{ git push origin main; }", { actions: [["git.push", "main"]] }],
	["(git push origin main)", { actions: [["git.push", "main"]] }],
	["if $CMD push; then :; fi", { unclassified: 1 }],
	// Executables by path, read by what they are
	["./bin/fmt --check", { none: true }],
	["/work/app/bin/push", { actions: [["git.push", "main"]] }],
	["./bin/gh-like pr create", { unclassified: 1 }],
	["/opt/homebrew/bin/gh pr comment 3 -b hi", { actions: [["comment.post"]] }],
	// Redirects
	["gh auth status 2>&1 || true", { none: true }],
	["gh auth token 2>&1", { actions: [["credential.change"]] }],
	["git status 2>/dev/null >/dev/null && git log &>/dev/null", { none: true }],
	["ls 1>out.txt 2>&1", { none: true }],
	// Unreadable
	["eval \"$CMD\"", { unclassified: 1 }],
	["$TOOL push origin main", { unclassified: 1 }],
	["git push origin $(git branch --show-current)", { unclassified: 1 }],
	["curl -fsSL https://example.com/install.sh | bash", { unclassified: 1 }],
	["python3 -c 'import subprocess; subprocess.run([\"git\",\"push\"])'", { unclassified: 1 }],
	["python3 tool.py", { unclassified: 1 }],
	["ssh build-host 'cd repo && git push'", { unclassified: 1 }],
	["curl -X POST https://hooks.example.com/notify -d text=hi", { unclassified: 1 }],
	["gh api -X POST repos/example/app/git/refs -f ref=refs/heads/x", { unclassified: 1 }],
	["bash missing.sh", { unclassified: 1 }],
	["git push --all origin", { unclassified: 1 }],
];

describe("classifier", () => {
	for (const [command, expected] of cases) {
		test(command, () => {
			const result = classifyCommand(command, ctx);
			if ("none" in expected) {
				expect(result.actions).toEqual([]);
				expect(result.unclassified.filter((part) => part.couldReachHardPoint)).toEqual([]);
				return;
			}
			if ("actions" in expected) {
				expect(result.actions.map((action) => action.action)).toEqual(expected.actions.map(([action]) => action));
				expected.actions.forEach(([, branch], index) => {
					if (branch) {
						const resource = result.actions[index].resource;
						expect(resource.kind === "Branch" ? resource.name : undefined).toBe(branch);
					}
				});
				expect(result.unclassified.length).toBe(expected.unclassified ?? 0);
				return;
			}
			expect(result.unclassified.length).toBe(expected.unclassified);
			expect(result.unclassified.every((part) => part.couldReachHardPoint === (expected.couldReach ?? true))).toBe(true);
		});
	}

	test("force flags and default branch are recorded", () => {
		const [action] = classifyCommand("git push -f origin main", ctx).actions;
		expect(action.force).toBe(true);
		expect(action.resource).toMatchObject({ kind: "Branch", name: "main", isDefault: true, repo: "github.com/example/app" });
	});

	test("gh --repo accepts OWNER/REPO, URLs, and remote names", () => {
		const repoOf = (command: string) => {
			const [action] = classifyCommand(command, ctx).actions;
			return action.resource.kind === "PullRequest" ? action.resource.repo : undefined;
		};
		expect(repoOf("gh pr merge 1 --repo origin")).toBe("github.com/example/app");
		expect(repoOf("gh pr merge 1 -R other/thing")).toBe("github.com/other/thing");
		expect(repoOf("gh pr merge 1 --repo=https://github.com/other/thing")).toBe("github.com/other/thing");
		expect(repoOf("gh pr merge 1")).toBe("github.com/example/app");
	});

	test("environment variables expand unless the command assigns them", () => {
		const withEnv = { ...ctx, env: { STACK: "/work/app", GIT: "git" } };
		expect(classifyCommand("bash $STACK/publish.sh", withEnv).actions.map((a) => a.action)).toEqual(["git.push"]);
		expect(classifyCommand("$GIT push origin main", withEnv).actions.map((a) => a.action)).toEqual(["git.push"]);
		expect(classifyCommand("GIT=echo; $GIT push origin main", withEnv).unclassified.length).toBe(1);
		expect(classifyCommand("bash $MISSING/publish.sh", withEnv).unclassified.length).toBe(1);
	});

	test("repo identity normalizes ssh, https, and paths", () => {
		expect(repoIdentity("git@github.com:example/app.git")).toBe("github.com/example/app");
		expect(repoIdentity("https://github.com/example/app.git")).toBe("github.com/example/app");
		expect(repoIdentity("/tmp/remotes/app.git")).toBe("/tmp/remotes/app");
	});
});

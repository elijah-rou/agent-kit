import { describe, expect, test } from "bun:test";
import { blockReason, mayPublish, publicationCommand, skipsHooks, type Actor } from "./classify.ts";
import { invocations, NESTING_LIMIT, Unreadable } from "./shell.ts";

const main: Actor = { kind: "main" };
const child: Actor = { kind: "child", role: "build" };
const unnamed: Actor = { kind: "child", role: undefined };
const owner: Actor = { kind: "child", role: "autopilot-owner" };

// What the original text patterns caught.
const PUBLISHING = ["git push origin main", "git pull --ff-only", "git merge topic", "git rebase main", "git cherry-pick HEAD~1", "git revert HEAD", "git am < patch", "git apply fix.diff", "git tag v1", "git -C /tmp/repo push", "git -C '/tmp/a b' -C sub rebase origin/main", "git status && git push", "make; git push", "true || git pull", "echo x | git am", "git add .\ngit push"];
// Forms the patterns missed, which the command reader now catches.
const PUBLISHING_HIDDEN = ["/usr/bin/git push", "GIT_DIR=x git push", "git --git-dir=x push", "git --git-dir x push", "git -c user.name=x push", "git --no-pager -C x push", "command git push", "  git push", "if true; then git push; fi", "{ git push; }", "time git push", "nohup git push &", "env -i FOO=1 git push", "sudo -u me git push", "xargs -n1 git push", "timeout 30 git pull", "(git merge topic)", 'echo "$(git push)"', "echo `git push`", 'bash -lc "git push"', "sh -c 'git rebase main'", "eval git push", "env -S 'git push'", "git.exe push", "/opt/homebrew/bin/GIT push", "gh pr merge 3 --squash", "gh -R owner/repo pr merge 3", "gh --repo=owner/repo pr merge"];
const LOCAL = ["git status --short", "git diff --check", "git log -1", "git show HEAD", "git commit -m local", "git commit -am local", "git fetch origin", "git branch -a", "git stash push", "ls -la", "echo git push", "gh pr view 1", "gh pr checks 1", "npm run push", "git config push.default", "git help push", "git status # then git push", "git config core.hooksPath", "git config --get core.hooksPath", "git config --unset core.hooksPath", "x=1; git status"];
const SKIPPING = ["git commit --no-verify -m x", "git push --no-verify", "cd repo && git -C x commit -m y --no-verify", "ls; git commit --no-verify"];
const SKIPPING_HIDDEN = ["git commit -n -m x", "git commit -nm x", "git commit -anm x", "git -C repo commit -n", "/usr/bin/git commit -n", "git commit --no-veri -m x", "git -c core.hooksPath=/dev/null commit -m x", "git -c Core.HooksPath=x commit", "git --config-env=core.hooksPath=HOOKS commit", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", 'bash -c "git commit -n -m x"'];
const HOOKS_PATH_WRITES = ["git config core.hooksPath /dev/null", "git config --global core.hooksPath /dev/null", "git config set core.hooksPath x", "git config core.hooksPath .githooks"];

// Round-2 audit cases. A1: a here document's body swallowed the rest of the command.
const HEREDOC = [
	"git commit -m \"$(cat <<'EOF'\nDon't skip hooks\nEOF\n)\" --no-verify",
	"git commit -m \"$(cat <<'EOF'\nDon't skip hooks\nEOF\n)\" -n",
	"cat > /tmp/msg <<'EOF'\nDon't skip hooks\nEOF\ngit commit -F /tmp/msg -n",
	"cat <<-EOF > /tmp/msg\n\tDon't skip hooks\n\tEOF\ngit commit -F /tmp/msg -n",
];
const HEREDOC_CHILD = "git commit -m \"$(cat <<'EOF'\nDon't skip hooks\nEOF\n)\" && gh pr merge 28 --squash";
// A2: ordinary syntax the reader took for something else.
const SYNTAX = [
	[">/dev/null git push origin x", "child"],
	["2>/dev/null git commit -n -m x", "main"],
	["git commit -m x 2>&1 >/dev/null -n", "main"],
	["&>/dev/null git push origin x", "child"],
	["true # note \\\ngit commit -n -m x", "main"],
	["echo $'it\\'s'; git commit -n -m x", "main"],
	["$'git' push origin x", "child"],
	["=git push origin x", "child"],
	["nocorrect git push origin x", "child"],
	["- git push origin x", "child"],
] as const;

describe("skipsHooks", () => {
	test("finds --no-verify on a git invocation anywhere in the command", () => {
		for (const command of SKIPPING) expect(skipsHooks(command)).toBe(true);
	});
	test("finds commit -n, a --no-verify prefix, and a core.hooksPath override or write", () => {
		for (const command of [...SKIPPING_HIDDEN, ...HOOKS_PATH_WRITES]) expect([command, skipsHooks(command)]).toEqual([command, true]);
	});
	test("ignores commands without a git invocation or a hook skip", () => {
		for (const command of ["git commit -m x", "echo --no-verify", "npm test --no-verify", "git commit -m x\necho --no-verify", "git commit -am x", "git push -n", "git merge -n topic", "git config --get core.hooksPath", "git merge --no-verify-signatures topic", "git pull --no-verify-signatures", "git commit -F /tmp/msg"]) expect([command, skipsHooks(command)]).toEqual([command, false]);
	});
});

describe("publicationCommand", () => {
	test("names each publication or integration command", () => {
		for (const command of [...PUBLISHING, ...PUBLISHING_HIDDEN]) expect([command, publicationCommand(command)]).toEqual([command, expect.any(String)]);
		expect(publicationCommand("git -C /tmp/repo cherry-pick abc")).toBe("git cherry-pick");
		expect(publicationCommand("gh pr merge 3")).toBe("gh pr merge");
	});
	test("leaves local git commands and non-git commands alone", () => {
		for (const command of LOCAL) expect([command, publicationCommand(command)]).toEqual([command, undefined]);
	});
	test("reads PowerShell's escapes and call operator", () => {
		expect(publicationCommand("& 'C:\\Program Files\\Git\\cmd\\git.exe' push", "powershell")).toBe("git push");
		expect(publicationCommand("git pu`sh origin main", "powershell")).toBe("git push");
		expect(publicationCommand("if ($x) {git push}", "powershell")).toBe("git push");
		expect(publicationCommand("Invoke-Expression 'git push'", "powershell")).toBe("git push");
		expect(publicationCommand("cmd /c git push origin x", "powershell")).toBe("git push");
		expect(publicationCommand("wsl git push origin x", "powershell")).toBe("git push");
		const encoded = Buffer.from("git push origin x", "utf16le").toString("base64");
		for (const flag of ["-EncodedCommand", "-enc", "-e", "-ec"]) expect(publicationCommand(`pwsh ${flag} ${encoded}`, "powershell")).toBe("git push");
	});
	test("follows wrappers that run their arguments as a command", () => {
		for (const command of ["env -S'git push origin x'", "env --split-string='git push origin x'", "env -iS'git push'", "busybox git push", "busybox sh -c 'git push'", "caffeinate -i git push", "caffeinate -t 10 git push", "flock /tmp/l git push", "flock -w 5 /tmp/l -c 'git push'", "arch -arm64 git push", "arch -arch x86_64 git push", "watch -n 60 git push origin x", "find . -exec git push \\;", "find . -name x -execdir git push {} +", "find . -ok git push ';'"]) expect([command, publicationCommand(command)]).toEqual([command, "git push"]);
		expect(publicationCommand("git subtree push --prefix=d origin x")).toBe("git subtree push");
		expect(publicationCommand("git subtree split --prefix=d")).toBeUndefined();
	});
	test("lets a child list or verify tags and tell merge-base from merge", () => {
		for (const command of ["git tag", "git tag -l", "git tag --list 'v*'", "git tag --contains HEAD", "git tag --points-at HEAD", "git tag -n", "git tag -n5", "git tag -v v1", "git tag --merged main", "git merge-base HEAD origin/main", "git diff $(git merge-base HEAD origin/main)"]) expect([command, publicationCommand(command)]).toEqual([command, undefined]);
		for (const command of ["git tag v1", "git tag -a v1 -m x", "git tag -d v1", "git tag -f v1 HEAD", "git merge topic"]) expect([command, publicationCommand(command)]).toEqual([command, expect.any(String)]);
	});
});

describe("blockReason", () => {
	test("skipping hooks is refused for every actor, owners included", () => {
		for (const command of [...SKIPPING, ...SKIPPING_HIDDEN]) for (const actor of [main, child, unnamed, owner]) expect(blockReason(command, actor)).toMatch(/skipping git hooks \(--no-verify/);
	});
	test("writing core.hooksPath is refused for every actor, with a reason that sends it to the user", () => {
		for (const command of HOOKS_PATH_WRITES) for (const actor of [main, owner]) expect(blockReason(command, actor)).toMatch(/setting core.hooksPath with git config.*ask the user to set it/);
	});
	test("a here document's body is data and the command after it is still read (A1)", () => {
		for (const command of HEREDOC) for (const actor of [main, child, owner]) expect([command, blockReason(command, actor)]).toEqual([command, expect.stringMatching(/skipping git hooks \(--no-verify/)]);
		expect(blockReason(HEREDOC_CHILD, child)).toMatch(/child publication\/integration command: gh pr merge/);
		expect(blockReason(HEREDOC_CHILD, main)).toBeUndefined();
		// The body is data to the reader; the text patterns still see a line starting with git push and say so.
		expect(blockReason("cat > /tmp/msg <<'EOF'\ngit push is refused for children\nEOF", child)).toMatch(/may only mention the command/);
		expect(blockReason("cat > /tmp/msg <<'EOF'\nchildren may not push\nEOF", child)).toBeUndefined();
	});
	test("a here document, here-string, or echo fed to a shell is read as commands", () => {
		for (const command of ["bash <<EOF\ngit push origin x\nEOF", "cat <<'EOF' | sh\ngit push origin x\nEOF", "bash <<< 'git push origin x'", "echo 'git push origin x' | bash", "cat <<EOF\n$(git push origin x)\nEOF"]) expect([command, blockReason(command, child)]).toEqual([command, expect.stringMatching(/git push/)]);
	});
	test("redirections, comments, ANSI-C quotes, and zsh forms are read as a shell reads them (A2)", () => {
		for (const [command, who] of SYNTAX) {
			const actor = who === "main" ? main : child;
			expect([command, blockReason(command, actor)]).toEqual([command, expect.stringMatching(who === "main" ? /skipping git hooks/ : /child publication\/integration command: git push/)]);
		}
		expect(blockReason("git status > /tmp/out 2>&1", child)).toBeUndefined();
		expect(blockReason("echo $((1 << 2)); git status", child)).toBeUndefined();
		expect(blockReason("echo $((1 << 2)); git push", child)).toMatch(/git push/);
	});
	test("text the reader cannot read is refused for every actor, with a reason naming the fix", () => {
		for (const command of ["git commit -m \"unterminated", "git commit -m 'unterminated", "echo $(git status", "echo `git status", "cat <<EOF\nno end", "echo $'open", "{git,push} origin x", "/usr/bin/gi? push", "pwsh -EncodedCommand not-base64!"]) {
			for (const actor of [main, owner]) expect([command, blockReason(command, actor, command.startsWith("pwsh") ? "powershell" : "posix")]).toEqual([command, expect.stringMatching(/could not read this command: .*Rewrite it so a shell can read it plainly/)]);
		}
		expect(() => invocations("echo 'open", "posix")).toThrow(Unreadable);
	});
	test("a refusal only the text patterns make says it may be a mention and how to rephrase", () => {
		for (const command of ["git commit -m \"docs: explain why --no-verify is refused\"", "git log --grep=--no-verify", "git grep -n -- --no-verify", "git commit -m \"$(cat <<'EOF'\nRefuse git commit -n\n\ngit commit --no-verify is refused too\nEOF\n)\""]) {
			expect([command, blockReason(command, main)]).toEqual([command, expect.stringMatching(/may only mention the flag.*git commit -F <file>.*without its leading dashes/)]);
		}
		for (const command of ["git commit -m \"docs; git push is refused\"", "rg \"error|git push\" docs/", "git commit -m \"$(cat <<'EOF'\nGuard children\n\ngit push is refused for children now\nEOF\n)\""]) {
			expect([command, blockReason(command, child)]).toEqual([command, expect.stringMatching(/may only mention the command.*git commit -F <file>/)]);
			expect(blockReason(command, main)).toBeUndefined();
		}
		for (const actor of [main, child]) expect(blockReason("git commit -F /tmp/msg", actor)).toBeUndefined();
	});
	test("a child other than an owner may not publish or integrate", () => {
		expect(mayPublish(child)).toBe(false);
		expect(mayPublish(unnamed)).toBe(false);
		for (const command of [...PUBLISHING, ...PUBLISHING_HIDDEN]) {
			expect(blockReason(command, child)).toMatch(/child publication\/integration command: (git|gh) /);
			expect(blockReason(command, unnamed)).toMatch(/child publication\/integration/);
		}
	});
	test("the main session and an owner may publish and integrate", () => {
		expect(mayPublish(main)).toBe(true);
		expect(mayPublish(owner)).toBe(true);
		for (const command of [...PUBLISHING, ...PUBLISHING_HIDDEN]) {
			expect(blockReason(command, main)).toBeUndefined();
			expect(blockReason(command, owner)).toBeUndefined();
		}
	});
	test("a role name that only contains the owner role is not an owner", () => {
		for (const role of ["autopilot-owner-2", "plugin:autopilot-owner", "Autopilot-Owner", " autopilot-owner"]) expect(blockReason("git push", { kind: "child", role })).toMatch(/child publication/);
	});
	test("local commands pass for every actor", () => {
		for (const command of LOCAL) for (const actor of [main, child, unnamed, owner]) expect([command, blockReason(command, actor)]).toEqual([command, undefined]);
	});
	test("a command nested past the limit is refused for every actor, whatever it runs", () => {
		const deep = Array.from({ length: NESTING_LIMIT + 2 }).reduce<string>((inner) => `echo "$(${inner})"`, "ls");
		for (const actor of [main, owner]) expect(blockReason(deep, actor)).toMatch(/could not read this command: it nests more than/);
		const shallow = Array.from({ length: NESTING_LIMIT - 1 }).reduce<string>((inner) => `echo "$(${inner})"`, "git push");
		expect(blockReason(shallow, child)).toMatch(/git push/);
		expect(blockReason(shallow, main)).toBeUndefined();
	});
});

describe("invocations", () => {
	test("splits quoted words, assignments, and substitutions", () => {
		expect(invocations(`cd a && FOO=1 git -C "x y" push origin "$(git rev-parse HEAD)" # git merge`, "posix")).toEqual([
			{ assignments: [], program: "git", args: ["rev-parse", "HEAD"] },
			{ assignments: [], program: "cd", args: ["a"] },
			{ assignments: ["FOO=1"], program: "git", args: ["-C", "x y", "push", "origin", ""] },
		]);
	});
	test("an unterminated quote, substitution, or here document is unreadable", () => {
		for (const command of [`git commit -m "unterminated`, "echo $(git push", "cat <<EOF\nbody"]) expect(() => invocations(command, "posix")).toThrow(Unreadable);
	});
	test("a here document body is not read as commands, and redirections are not programs", () => {
		expect(invocations("2>/dev/null git commit -F - <<'EOF' >/dev/null\ngit push is refused\nEOF\ngit status", "posix")).toEqual([
			{ assignments: [], program: "git", args: ["commit", "-F", "-"] },
			{ assignments: [], program: "git", args: ["status"] },
		]);
	});
});

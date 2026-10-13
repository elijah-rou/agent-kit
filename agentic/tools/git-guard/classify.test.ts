import { describe, expect, test } from "bun:test";
import { blockReason, mayPublish, publicationCommand, skipsHooks, type Actor } from "./classify.ts";
import { invocations, NESTING_LIMIT } from "./shell.ts";

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
const SKIPPING_HIDDEN = ["git commit -n -m x", "git commit -nm x", "git commit -anm x", "git -C repo commit -n", "/usr/bin/git commit -n", "git commit --no-veri -m x", "git config core.hooksPath /dev/null", "git config --global core.hooksPath /dev/null", "git config set core.hooksPath x", "git -c core.hooksPath=/dev/null commit -m x", "git -c Core.HooksPath=x commit", "git --config-env=core.hooksPath=HOOKS commit", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", 'bash -c "git commit -n -m x"'];

describe("skipsHooks", () => {
	test("finds --no-verify on a git invocation anywhere in the command", () => {
		for (const command of SKIPPING) expect(skipsHooks(command)).toBe(true);
	});
	test("finds commit -n, a --no-verify prefix, and a core.hooksPath override", () => {
		for (const command of SKIPPING_HIDDEN) expect([command, skipsHooks(command)]).toEqual([command, true]);
	});
	test("ignores commands without a git invocation or a hook skip", () => {
		for (const command of ["git commit -m x", "echo --no-verify", "npm test --no-verify", "git commit -m x\necho --no-verify", "git commit -am x", "git push -n", "git merge -n topic", "git config --get core.hooksPath"]) expect([command, skipsHooks(command)]).toEqual([command, false]);
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
	});
});

describe("blockReason", () => {
	test("skipping hooks is refused for every actor, owners included", () => {
		for (const command of [...SKIPPING, ...SKIPPING_HIDDEN]) for (const actor of [main, child, unnamed, owner]) expect(blockReason(command, actor)).toMatch(/skipping git hooks \(--no-verify/);
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
		for (const actor of [main, owner]) expect(blockReason(deep, actor)).toMatch(/could not check this command/);
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
	test("an unterminated quote or substitution runs to the end of the line", () => {
		expect(invocations(`git commit -m "unterminated`, "posix")).toEqual([{ assignments: [], program: "git", args: ["commit", "-m", "unterminated"] }]);
		expect(invocations("echo $(git push", "posix").map((call) => call.program)).toEqual(["git", "echo"]);
	});
});

import { describe, expect, test } from "bun:test";
import { blockReason, hookSkip, mayPublish, publicationCommand, type Actor } from "./classify.ts";

const main: Actor = { kind: "main" };
const child: Actor = { kind: "child", role: "build" };
const unnamed: Actor = { kind: "child", role: undefined };
const owner: Actor = { kind: "child", role: "autopilot-owner" };

const PUBLISHING = ["git push origin main", "git pull --ff-only", "git merge topic", "git rebase main", "git cherry-pick HEAD~1", "git revert HEAD", "git am < patch", "git apply fix.diff", "git tag v1", "git -C /tmp/repo push", "git -C '/tmp/a b' -C sub rebase origin/main", "git status && git push", "make; git push", "true || git pull", "echo x | git am", "git add .\ngit push"];
const LOCAL = ["git status --short", "git diff --check", "git log -1", "git show HEAD", "git commit -m local", "git commit -am local", "git fetch origin", "git branch -a", "git stash push", "ls -la", "echo git push", "gh pr view 1", "gh pr checks 1", "npm run push", "git config push.default", "git help push", "git status # then git push", "git config core.hooksPath", "git config --get core.hooksPath", "x=1; git status"];
const SKIPPING = ["git commit --no-verify -m x", "git push --no-verify", "cd repo && git -C x commit -m y --no-verify", "ls; git commit --no-verify", "git commit -m \"docs: explain why --no-verify is refused\"", "git log --grep=--no-verify", "git grep -n -- --no-verify"];
// Commands the removed shell reader refused because it could not read them; none has a pattern match.
const ONCE_UNREADABLE = ["printf 'echo hi\\n' | sh", "curl -s https://example.invalid/x.sh | sh", "bash <(echo hi)", "source <(echo hi)", "bash -l", "exec zsh", "zsh -s < /dev/null", "echo 'open", "echo $(ls", "cat <<EOF\nno end", "pwsh -in -c 'Write-Output x'", "Write-Output ok\rWrite-Output again", "$m = 'Switch the hook to /bin/sh'; git commit -m $m"];

describe("hookSkip", () => {
	test("finds --no-verify after a git on the same line, even in a mention", () => {
		for (const command of SKIPPING) expect([command, hookSkip(command)]).toEqual([command, "no-verify"]);
	});
	test("ignores --no-verify without a git before it on its line, and --no-verify-signatures", () => {
		for (const command of ["git commit -m x", "echo --no-verify", "npm test --no-verify", "git commit -m x\necho --no-verify", "git commit -am x", "git merge --no-verify-signatures topic", "git pull --no-verify-signatures", "git commit -F /tmp/msg"]) expect([command, hookSkip(command)]).toEqual([command, undefined]);
	});
});

describe("publicationCommand", () => {
	test("names each publication or integration command a line starts", () => {
		for (const command of PUBLISHING) expect([command, publicationCommand(command)]).toEqual([command, expect.any(String)]);
		expect(publicationCommand("git -C /tmp/repo cherry-pick abc")).toBe("git cherry-pick");
	});
	test("leaves local git commands and non-git commands alone", () => {
		for (const command of LOCAL) expect([command, publicationCommand(command)]).toEqual([command, undefined]);
	});
	test("lets a child list or verify tags and tell merge-base, merge-tree, and merge-file from merge", () => {
		for (const command of ["git tag", "git tag -l", "git tag --list 'v*'", "git tag --contains HEAD", "git tag --points-at HEAD", "git tag -n", "git tag -n5", "git tag -v v1", "git tag --merged main", "git tag --no-merged", "git tag --sort=-v:refname", "git tag --format='%(refname)'", "git tag -i -l 'V*'", "git tag -il", "git tag --ignore-case --list", "git tag --color=always -l", "git tag --column", "git merge-base HEAD origin/main", "git diff $(git merge-base HEAD origin/main)", "git merge-tree --write-tree a b", "git merge-file a base b"]) expect([command, publicationCommand(command)]).toEqual([command, undefined]);
		for (const command of ["git tag v1", "git tag -a v1 -m x", "git tag -d v1", "git tag -f v1 HEAD", "git tag -a v1 -m -l", "git tag -am note v1", "git tag -i v1", "git tag --color v1", "git tag --sort=refname v1", "git merge topic"]) expect([command, publicationCommand(command)]).toEqual([command, expect.any(String)]);
	});
});

describe("blockReason", () => {
	test("--no-verify is refused for every actor, owners included, with a reason that covers a mention", () => {
		for (const command of SKIPPING) for (const actor of [main, child, unnamed, owner]) expect([command, blockReason(command, actor)]).toEqual([command, expect.stringMatching(/skipping git hooks with --no-verify.*fix what a hook reports.*git commit -F <file>.*without its leading dashes/)]);
	});
	test("a child other than an owner may not publish or integrate", () => {
		expect(mayPublish(child)).toBe(false);
		expect(mayPublish(unnamed)).toBe(false);
		for (const command of PUBLISHING) {
			expect(blockReason(command, child)).toMatch(/child publication\/integration command: git .*commit locally.*git commit -F <file>/);
			expect(blockReason(command, unnamed)).toMatch(/child publication\/integration/);
		}
	});
	test("a mention of a publication command at the start of a line or after a separator is refused for a child only", () => {
		for (const command of ["git commit -m \"docs; git push is refused\"", "rg \"error|git push\" docs/", "git commit -m \"$(cat <<'EOF'\nGuard children\n\ngit push is refused for children now\nEOF\n)\"", "cat > /tmp/msg <<'EOF'\ngit push is refused for children\nEOF"]) {
			expect([command, blockReason(command, child)]).toEqual([command, expect.stringMatching(/child publication\/integration command: git push.*git commit -F <file>/)]);
			expect(blockReason(command, main)).toBeUndefined();
		}
		for (const actor of [main, child]) expect(blockReason("git commit -F /tmp/msg", actor)).toBeUndefined();
	});
	test("the main session and an owner may publish and integrate", () => {
		expect(mayPublish(main)).toBe(true);
		expect(mayPublish(owner)).toBe(true);
		for (const command of PUBLISHING) {
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
	test("commands the removed shell reader could not read pass for every actor", () => {
		const deep = "echo " + '"${x:-'.repeat(40) + "y" + '}"'.repeat(40);
		for (const command of [...ONCE_UNREADABLE, deep]) for (const actor of [main, child, owner]) expect([command, blockReason(command, actor)]).toEqual([command, undefined]);
	});
	test("the patterns refuse what they match even when the text is unbalanced", () => {
		expect(blockReason("git commit -m \"unterminated --no-verify", main)).toMatch(/skipping git hooks/);
		expect(blockReason("echo 'open; git push origin x", child)).toMatch(/git push/);
	});
});

describe("patterns for what the shell reader alone used to find", () => {
	const actors = [main, child, unnamed, owner];
	const refusedForAll = (commands: string[], reason: RegExp) => {
		for (const command of commands) for (const actor of actors) expect([command, actor, blockReason(command, actor)]).toEqual([command, actor, expect.stringMatching(reason)]);
	};
	const allowedForAll = (commands: string[]) => {
		for (const command of commands) for (const actor of actors) expect([command, actor, blockReason(command, actor)]).toEqual([command, actor, undefined]);
	};
	// git am integrates, so a child other than an owner is refused it as integration, never as skipping hooks.
	const amAllowed = (commands: string[]) => {
		for (const command of commands) {
			for (const actor of [main, owner]) expect([command, blockReason(command, actor)]).toEqual([command, undefined]);
			for (const actor of [child, unnamed]) expect([command, blockReason(command, actor)]).toEqual([command, expect.stringMatching(/^git guard blocked child publication\/integration command: git am\./)]);
		}
	};
	test("git commit -n and git am -n, alone or bundled in short flags, are refused for every actor, mentions included", () => {
		refusedForAll(["git commit -n -m x", "git commit -nm x", "git commit -anm x", "git commit -s -n -m x", "git am -n patch", "git am -3n patch", "git -C repo commit -n -m x", "git add . && git commit -n -m x", "/usr/bin/git commit -nm x", "git commit -m \"fix -n handling\""], /skipping git hooks with -n.*fix what a hook reports.*git commit -F <file>/);
		allowedForAll(["git commit -m x", "git commit -am local", "git commit -mn", "git log -n 3", "git add . && git commit -m x && git log -n 3", "git commit -m x; head -n 5 log", "git commit --no-edit"]);
		amAllowed(["git am patch", "git am -3 patch", "git am -k -s patch"]);
	});
	test("a hook manager's skip variable assigned before git on the same line, or alone on the line before it, is refused for every actor", () => {
		refusedForAll(["HUSKY=0 git commit -m x", "HUSKY_SKIP_HOOKS=1 git commit -m x", "SKIP=lint git commit -m x", "PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m x", "LEFTHOOK=0 git push", "LEFTHOOK_EXCLUDE=lint git commit -m x", "OVERCOMMIT_DISABLE=1 git commit -m x", "FOO=1 HUSKY=0 git commit -m x", "HUSKY=0 FOO=1 git commit -m x", "cd repo && SKIP='lint,test' git commit -m x", "export HUSKY=0 && git commit -m x", "export HUSKY=0; git push", "HUSKY=0 /usr/bin/git commit -m x", "export HUSKY=0\ngit commit -m x", "export HUSKY=0 FOO=1;\ngit commit -m x"], /skipping git hooks with a hook manager's skip variable.*git commit -F <file>/);
		allowedForAll(["HUSKY=0 npm install", "SKIP=1 make", "MYSKIP=1 git commit -m x", "HUSKYX=1 git commit -m x", "git commit -m x"]);
	});
	test("setting or unsetting core.hooksPath or a hook.* key through git -c, --config-env, or git config is refused for every actor", () => {
		refusedForAll(["git -c core.hooksPath=/dev/null commit -m x", "git -c core.hookspath=/dev/null push", "git -c 'core.hooksPath=/dev/null' commit -m x", "git -C repo -c hook.pre-commit.command=true commit -m x", "git -c user.name=x -c hook.lint.enabled=false commit -m y", "git --config-env=core.hooksPath=EMPTY commit -m x", "git --config-env core.hooksPath=EMPTY commit -m x", "git config core.hooksPath /dev/null", "git config --global core.hooksPath ''", "git config --unset core.hooksPath", "git config unset core.hooksPath", "git config set core.hooksPath /tmp/none", "git config --add hook.lint.command true", "git config hook.lint.enabled false", "git config --remove-section hook.lint", "git -C repo config core.hooksPath x", "/usr/bin/git config core.hooksPath x"], /skipping git hooks by setting or unsetting core.hooksPath or a hook.\* key.*git commit -F <file>/);
		allowedForAll(["git config user.name x", "git config core.hooksPath", "git config --get core.hooksPath", "git config get core.hooksPath", "git config --list", "git config --get-regexp '^hook\\.'", "git -c user.name=x commit -m y", "git commit -c HEAD"]);
	});
	test("gh pr merge is refused for every child but an owner", () => {
		for (const command of ["gh pr merge 3", "gh pr merge 3 --squash", "gh pr merge -R owner/repo 3", "cd repo && gh pr merge 3 --auto", "/opt/homebrew/bin/gh pr merge 3"]) {
			for (const actor of [child, unnamed]) expect([command, blockReason(command, actor)]).toEqual([command, expect.stringMatching(/child publication\/integration command: gh pr merge.*commit locally.*git commit -F <file>.*without gh in front/)]);
			for (const actor of [main, owner]) expect([command, blockReason(command, actor)]).toEqual([command, undefined]);
		}
		for (const command of ["gh pr view 3", "gh pr checks 3", "gh pr view 3 --json mergeable", "gh pr diff 3"]) expect([command, blockReason(command, child)]).toEqual([command, undefined]);
	});
	test("git called by an absolute path is read as git by the publication and --no-verify patterns", () => {
		for (const [command, name] of [["/usr/bin/git push origin x", "git push"], ["/opt/homebrew/bin/git -C repo rebase main", "git rebase"], ["cd repo && /usr/bin/git merge topic", "git merge"], ["/usr/local/bin/git tag v1", "git tag"]] as const) {
			expect([command, blockReason(command, child)]).toEqual([command, expect.stringContaining(`child publication/integration command: ${name}.`)]);
			for (const actor of [main, owner]) expect([command, blockReason(command, actor)]).toEqual([command, undefined]);
		}
		refusedForAll(["/usr/bin/git commit --no-verify -m x", "make && /usr/bin/git push --no-verify"], /skipping git hooks with --no-verify/);
		for (const command of ["/usr/bin/git status", "/usr/bin/git merge-base a b", "/usr/bin/git tag -l", "ls /usr/bin/git", "echo /usr/bin/git push"]) expect([command, blockReason(command, child)]).toEqual([command, undefined]);
	});
	test("redirections and a trailing comment are not git config or git tag arguments", () => {
		allowedForAll(["git config core.hooksPath 2>/dev/null || echo unset", "git config core.hooksPath >/dev/null 2>&1 && echo set", "git config hook.lint.command 2> /dev/null", "git config core.hooksPath &>/dev/null", "git config core.hooksPath > /tmp/out", "git config core.hooksPath # read it", "git config --get core.hooksPath </dev/null"]);
		refusedForAll(["git config core.hooksPath /dev/null 2>/dev/null", "git config core.hooksPath >/tmp/log /dev/null", "git config core.hooksPath > /tmp/log x", "git config core.hooksPath x # set it"], /skipping git hooks by setting or unsetting core.hooksPath/);
		for (const command of ["git tag 2>/dev/null", "git tag -l >/tmp/tags 2>&1", "git tag 2> /dev/null | head", "git tag # list them"]) expect([command, blockReason(command, child)]).toEqual([command, undefined]);
		for (const command of ["git tag v1 2>/dev/null", "git tag 2>/dev/null v1", "git tag > /tmp/out v1"]) expect([command, blockReason(command, child)]).toEqual([command, expect.stringContaining("child publication/integration command: git tag.")]);
	});
	test("-n counts only after git commit's or git am's boolean short flags, and not in a word git refuses as a misspelled long option", () => {
		allowedForAll(["git commit -m \"Build with -fno-exceptions\"", "git commit -m \"Silence -Wno-unused-parameter\"", "git commit -m \"Add -json output\"", "git commit -m \"Fix -version banner\"", "git commit -m \"Pass -include to clang\"", "git commit -m \"Keep -only for now\"", "git commit -m \"Drop -no-op\"", "git commit -m \"Note -tn\""]);
		refusedForAll(["git commit -n -m x", "git commit -nm x", "git commit -anm x", "git commit -an", "git commit -on file", "git commit -in file", "git commit -svn -m x", "git commit -m \"fix -n handling\"", "git am -3n patch", "git am -kn patch", "git am -mn patch"], /skipping git hooks with -n/);
		amAllowed(["git am -include patch", "git am -pn1 patch"]);
	});
	test("--no-verify after git counts when the command runs onto later lines through a quoted string or a backslash", () => {
		refusedForAll(["git commit -m \"$(cat <<'EOF'\nDon't skip hooks\nEOF\n)\" --no-verify", "git commit -m x \\\n  --no-verify", "git commit -m 'first\nsecond' --no-verify", "git commit -m \"Title\n\nRefuse --no-verify\"", "/usr/bin/git -C repo commit -m \"a\nb\" --no-verify"], /skipping git hooks with --no-verify.*git commit -F <file>/);
		allowedForAll(["git commit -m x\necho --no-verify", "git commit -m \"a\nb\"\necho --no-verify", "git commit -m x # it's\necho it's --no-verify", "echo \"git\nx\" --no-verify"]);
	});
	test("a -C path that mixes quoted and bare parts is still one word", () => {
		expect(blockReason('git -C "a"/c push', child)).toMatch(/git push/);
		expect(blockReason("git -C 'my repo'/sub commit -n -m x", child)).toMatch(/-n/);
	});
	test("many quoted -C options are read in linear time", () => {
		const options = ' -C "x"'.repeat(40);
		const started = performance.now();
		for (const command of [`git${options} status`, `git${options} commit -m x`, `git${options} config user.name x`, `git${options} --no-verify-signatures`]) expect([command, blockReason(command, child)]).toEqual([command, undefined]);
		expect(blockReason(`git${options} push`, child)).toMatch(/git push/);
		expect(blockReason(`git${' -C "a b"/c'.repeat(40)} push`, child)).toMatch(/git push/);
		expect(performance.now() - started).toBeLessThan(500);
	});
	test("shells, plain commits, patches, config, and a child's reads stay allowed", () => {
		allowedForAll(["printf 'echo hi\\n' | sh", "bash -l", "exec zsh", "echo \"unterminated", "git commit -m x", "git config user.name x"]);
		amAllowed(["git am patch"]);
		for (const command of ["gh pr view 3", "git merge-base a b"]) expect([command, blockReason(command, child)]).toEqual([command, undefined]);
	});
});

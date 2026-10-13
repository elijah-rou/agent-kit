import { describe, expect, test } from "bun:test";
import { blockReason, mayPublish, publicationCommand, skipsHooks, type Actor } from "./classify.ts";

const main: Actor = { kind: "main" };
const child: Actor = { kind: "child", role: "build" };
const unnamed: Actor = { kind: "child", role: undefined };
const owner: Actor = { kind: "child", role: "autopilot-owner" };

const PUBLISHING = ["git push origin main", "git pull --ff-only", "git merge topic", "git rebase main", "git cherry-pick HEAD~1", "git revert HEAD", "git am < patch", "git apply fix.diff", "git tag v1", "git -C /tmp/repo push", "git -C '/tmp/a b' -C sub rebase origin/main", "git status && git push", "make; git push", "true || git pull", "echo x | git am", "git add .\ngit push"];
const LOCAL = ["git status --short", "git diff --check", "git log -1", "git show HEAD", "git commit -m local", "git commit -am local", "git fetch origin", "git branch -a", "git stash push", "ls -la", "echo git push", "gh pr view 1", "gh pr checks 1", "npm run push", "git config push.default", "git help push", "git status # then git push", "git config core.hooksPath", "git config --get core.hooksPath", "x=1; git status"];
const SKIPPING = ["git commit --no-verify -m x", "git push --no-verify", "cd repo && git -C x commit -m y --no-verify", "ls; git commit --no-verify", "git commit -m \"docs: explain why --no-verify is refused\"", "git log --grep=--no-verify", "git grep -n -- --no-verify"];
// Commands the removed shell reader refused because it could not read them; none has a pattern match.
const ONCE_UNREADABLE = ["printf 'echo hi\\n' | sh", "curl -s https://example.invalid/x.sh | sh", "bash <(echo hi)", "source <(echo hi)", "bash -l", "exec zsh", "zsh -s < /dev/null", "echo 'open", "echo $(ls", "cat <<EOF\nno end", "pwsh -in -c 'Write-Output x'", "Write-Output ok\rWrite-Output again", "$m = 'Switch the hook to /bin/sh'; git commit -m $m"];

describe("skipsHooks", () => {
	test("finds --no-verify after a git on the same line, even in a mention", () => {
		for (const command of SKIPPING) expect([command, skipsHooks(command)]).toEqual([command, true]);
	});
	test("ignores --no-verify without a git before it on its line, and --no-verify-signatures", () => {
		for (const command of ["git commit -m x", "echo --no-verify", "npm test --no-verify", "git commit -m x\necho --no-verify", "git commit -am x", "git merge --no-verify-signatures topic", "git pull --no-verify-signatures", "git commit -F /tmp/msg"]) expect([command, skipsHooks(command)]).toEqual([command, false]);
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

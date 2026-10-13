import { describe, expect, test } from "bun:test";
import { blockReason, mayPublish, publicationCommand, skipsHooks, type Actor } from "./classify.ts";

const main: Actor = { kind: "main" };
const child: Actor = { kind: "child", role: "build" };
const unnamed: Actor = { kind: "child", role: undefined };
const owner: Actor = { kind: "child", role: "autopilot-owner" };

const PUBLISHING = ["git push origin main", "git pull --ff-only", "git merge topic", "git rebase main", "git cherry-pick HEAD~1", "git revert HEAD", "git am < patch", "git apply fix.diff", "git tag v1", "git -C /tmp/repo push", "git -C '/tmp/a b' -C sub rebase origin/main", "git status && git push", "make; git push", "true || git pull", "echo x | git am", "git add .\ngit push"];
const LOCAL = ["git status --short", "git diff --check", "git log -1", "git show HEAD", "git commit -m local", "git fetch origin", "git branch -a", "git stash push", "ls -la", "echo git push", "gh pr view 1", "npm run push", "git config push.default", "git help push"];

describe("skipsHooks", () => {
	test("finds --no-verify on a git invocation anywhere in the command", () => {
		for (const command of ["git commit --no-verify -m x", "git push --no-verify", "cd repo && git -C x commit -m y --no-verify", "ls; git commit --no-verify"]) expect(skipsHooks(command)).toBe(true);
	});
	test("ignores commands without a git invocation or the flag", () => {
		for (const command of ["git commit -m x", "echo --no-verify", "npm test --no-verify", "git commit -m x\necho --no-verify"]) expect(skipsHooks(command)).toBe(false);
	});
});

describe("publicationCommand", () => {
	test("names each publication or integration subcommand", () => {
		for (const command of PUBLISHING) expect(publicationCommand(command)).toBeDefined();
		expect(publicationCommand("git -C /tmp/repo cherry-pick abc")).toBe("cherry-pick");
	});
	test("leaves local git commands and non-git commands alone", () => {
		for (const command of LOCAL) expect(publicationCommand(command)).toBeUndefined();
	});
});

describe("blockReason", () => {
	test("--no-verify is refused for every actor, owners included", () => {
		for (const actor of [main, child, unnamed, owner]) expect(blockReason("git commit --no-verify -m x", actor)).toMatch(/--no-verify/);
	});
	test("a child other than an owner may not publish or integrate", () => {
		expect(mayPublish(child)).toBe(false);
		expect(mayPublish(unnamed)).toBe(false);
		for (const command of PUBLISHING) {
			expect(blockReason(command, child)).toMatch(/child publication\/integration command: git /);
			expect(blockReason(command, unnamed)).toMatch(/child publication\/integration/);
		}
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
		for (const command of LOCAL) for (const actor of [main, child, unnamed, owner]) expect(blockReason(command, actor)).toBeUndefined();
	});
});

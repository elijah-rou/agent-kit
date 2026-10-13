// The git command policy both runtimes enforce on a shell command before it runs: Pi's git-interceptor
// extension and Claude Code's PreToolUse hook (cli.ts). Each runtime decides who is acting; this module
// decides what that actor may run. It reads the command text only and never runs anything.

/** Who issued the command. The coordinating session publishes; a child publishes only as an autopilot-full owner. */
export type Actor = { kind: "main" } | { kind: "child"; role: string | undefined };

/** The one child role that carries its own pull request through the merge (babysit-and-ship). */
export const PUBLISHING_CHILD_ROLE = "autopilot-owner";

const NO_VERIFY = /(^|[;&|\n]\s*)git\s+[^\n]*--no-verify\b/;
// A git invocation (at the start or after ;, &, |, or a newline, past any -C <path> options) that
// publishes or integrates history: push, pull, merge, rebase, cherry-pick, revert, am, apply, tag.
const PUBLICATION = /(?:^|[;&|\n]\s*)git(?:\s+-C\s+(?:'[^']*'|"[^"]*"|\S+))*\s+(push|pull|merge|rebase|cherry-pick|revert|am|apply|tag)\b/;

/** True when a git invocation in the command skips hooks with --no-verify. */
export function skipsHooks(command: string): boolean {
	return NO_VERIFY.test(command);
}

/** The first publication or integration subcommand a git invocation in the command runs, if any. */
export function publicationCommand(command: string): string | undefined {
	return PUBLICATION.exec(command)?.[1];
}

/** True when the actor may publish: the main session, or a child running as an autopilot-full owner. */
export function mayPublish(actor: Actor): boolean {
	switch (actor.kind) {
		case "main":
			return true;
		case "child":
			return actor.role === PUBLISHING_CHILD_ROLE;
	}
}

/**
 * Why the actor may not run the command, or undefined when the policy allows it. --no-verify is refused
 * for every actor; publication and integration are refused for every child except an owner.
 */
export function blockReason(command: string, actor: Actor): string | undefined {
	if (skipsHooks(command)) {
		return "git guard blocked --no-verify: commit and push with hooks running, and fix what a hook reports instead of skipping it";
	}
	const publication = mayPublish(actor) ? undefined : publicationCommand(command);
	if (publication === undefined) return undefined;
	return `git guard blocked child publication/integration command: git ${publication}. Only the coordinating session or an ${PUBLISHING_CHILD_ROLE} publishes or integrates; commit locally and report the branch and head SHA to your parent instead`;
}

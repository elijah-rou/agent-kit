// The git command policy both runtimes enforce on a shell command before it runs: Pi's git-interceptor
// extension and Claude Code's PreToolUse hook (cli.ts). Each runtime decides who is acting; this module
// decides what that actor may run. It reads the command text only and never runs anything.
//
// The policy is two text patterns kept from Pi's original interceptor, narrowed only where they matched
// other git commands (--no-verify-signatures, merge-base, and listing tags). They find a git command at
// the start of a line or after ;, &, or |, so they also match a mention in a quoted message or a search,
// and each reason says how to rephrase one. They do not read the shell: a git command reached another
// way (an absolute path, a wrapper, a substitution, a `sh -c` string) is not seen.

/** Who issued the command. The coordinating session publishes; a child publishes only as an autopilot-full owner. */
export type Actor = { kind: "main" } | { kind: "child"; role: string | undefined };

/** The one child role that carries its own pull request through the merge (babysit-and-ship). */
export const PUBLISHING_CHILD_ROLE = "autopilot-owner";

// --no-verify after a git at the start of a line, but not git's own --no-verify-signatures.
const NO_VERIFY = /(^|[;&|\n]\s*)git\s+[^\n]*--no-verify(?![\w-])/;
// A git invocation (at the start or after ;, &, |, or a newline, past any -C <path> options) that
// publishes or integrates history; merge-base and other hyphenated subcommands are not these.
const PUBLICATION = /(?:^|[;&|\n]\s*)git(?:\s+-C\s+(?:'[^']*'|"[^"]*"|\S+))*\s+(push|pull|merge|rebase|cherry-pick|revert|am|apply|tag)(?![\w-])/g;

// `git tag` options: those that make it list or verify tags, those that create or delete one, and
// those that take the next word as their value.
const TAG_LISTS = new Set(["-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "-v", "--verify"]);
// Options that only change how a listing looks (-i is --ignore-case): neither a listing mode nor a creation.
const TAG_WRITES = new Set(["-a", "--annotate", "-s", "--sign", "-f", "--force", "-d", "--delete", "-e", "--edit", "-m", "--message", "-F", "--file", "-u", "--local-user", "--create-reflog", "--trailer", "--cleanup"]);
// --color takes only an attached =value, never the next word.
const TAG_VALUED = new Set(["-m", "--message", "-F", "--file", "-u", "--local-user", "--cleanup", "--trailer", "--sort", "--format", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged"]);
// Short tag options that select a listing mode.
const TAG_LIST_SHORT = /^-(l|v|n\d*)$/;

/**
 * True when `git tag` with these arguments only lists or verifies tags: no option that creates or
 * deletes one, and either a listing option or no tag name. Option values (-m <msg>) are values, not options.
 */
function tagReads(args: string[]): boolean {
	let lists = false;
	let names = 0;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const option = arg.split("=")[0]!;
		if (arg === "--") {
			names += args.length - i - 1;
			break;
		}
		if (TAG_WRITES.has(option)) return false;
		if (TAG_LISTS.has(option) || TAG_LIST_SHORT.test(arg)) lists = true;
		else if (/^-[A-Za-z]{2,}$/.test(arg) && !/^-n\d+$/.test(arg)) {
			// A cluster creates a tag if any letter does (-am, -sm); otherwise it only lists.
			if ([...arg.slice(1)].some((letter) => TAG_WRITES.has(`-${letter}`))) return false;
			lists ||= [...arg.slice(1)].some((letter) => TAG_LISTS.has(`-${letter}`));
		} else if (!arg.startsWith("-")) names++;
		if (TAG_VALUED.has(arg)) i++;
	}
	return lists || names === 0;
}

/** True when the text has --no-verify after a git on the same line. */
export function skipsHooks(command: string): boolean {
	return NO_VERIFY.test(command);
}

/** The publication or integration command (`git push`, `git tag`) a line of the text starts, skipping `git tag` forms that only list (its words read up to the next separator). */
export function publicationCommand(command: string): string | undefined {
	for (const match of command.matchAll(PUBLICATION)) {
		const subcommand = match[1]!;
		if (subcommand === "tag") {
			const rest = command.slice(match.index! + match[0].length).split(/[;&|\n)]/)[0]!;
			const words = rest.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ""));
			if (tagReads(words)) continue;
		}
		return `git ${subcommand}`;
	}
	return undefined;
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
 * Why the actor may not run the command, or undefined when the policy allows it. Skipping hooks is
 * refused for every actor; publication and integration are refused for every child except an owner.
 */
export function blockReason(command: string, actor: Actor): string | undefined {
	if (skipsHooks(command)) {
		return "git guard blocked skipping git hooks with --no-verify after git on one line: commit and push with hooks running, and fix what a hook reports instead of skipping it. If the text only mentions the flag, as in a commit message or a search, write the message to a file with the editor tool and run git commit -F <file>, or search for the flag without its leading dashes";
	}
	const publication = publicationCommand(command);
	if (!mayPublish(actor) && publication !== undefined) {
		return `git guard blocked child publication/integration command: ${publication}. Only the coordinating session or an ${PUBLISHING_CHILD_ROLE} publishes or integrates; commit locally and report the branch and head SHA to your parent instead. If the text only mentions the command, as in a commit message or a search, write the message to a file with the editor tool and run git commit -F <file>, or search without git in front`;
	}
	return undefined;
}

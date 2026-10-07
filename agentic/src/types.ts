/** Hard-point actions the policy layer authorizes. Anything else is outside policy. */
export type ActionId =
	| "git.push"
	| "git.delete_remote_branch"
	| "pr.create"
	| "pr.merge"
	| "comment.post"
	| "release.publish"
	| "deploy"
	| "credential.change"
	| "data.delete"
	| "file.write"
	| "verdict.record"
	| "verdict.forge"
	| "git.skip_hooks"
	| "git.integrate"
	| "git.interactive";

export const ACTION_IDS: readonly ActionId[] = [
	"git.push",
	"git.delete_remote_branch",
	"pr.create",
	"pr.merge",
	"comment.post",
	"release.publish",
	"deploy",
	"credential.change",
	"data.delete",
	"file.write",
	"verdict.record",
	"verdict.forge",
	"git.skip_hooks",
	"git.integrate",
	"git.interactive",
];

export type Resource =
	| { kind: "Branch"; name: string; isDefault: boolean; repo: string }
	| { kind: "Repo"; origin: string }
	| { kind: "PullRequest"; number: number; headSha: string; repo: string }
	| { kind: "Recipient"; recipientKind: "person" | "bot" | "unknown"; label: string }
	| { kind: "Target"; targetKind: string; label: string }
	| { kind: "ProtectedPath"; protectedKind: string; path: string };

/** One classified hard-point action extracted from a tool call. */
export interface ClassifiedAction {
	action: ActionId;
	resource: Resource;
	force: boolean;
	/** Command text span that produced this action, for explanations. */
	evidence: string;
}

export type Classification =
	| { kind: "outside-policy" }
	| { kind: "actions"; actions: ClassifiedAction[] }
	| { kind: "unclassified"; reason: string; couldReachHardPoint: boolean };

export interface Facts {
	userGrant: number;
	requestedLevel: number;
	sessionRaise: number;
	effectiveLevel: number;
	force: boolean;
	verdict: string;
	verdictSha: string;
	isFrontier: boolean;
	/** The principal pushed the pull request's branch, so it cannot verify it. */
	isAuthor: boolean;
}

export type Decision = "allow" | "ask" | "deny";

export interface PolicyDecision {
	decision: Decision;
	/** Policy IDs that determined the decision (permits for allow, forbids for deny or ask). */
	policies: string[];
	reason: string;
	errors: string[];
}

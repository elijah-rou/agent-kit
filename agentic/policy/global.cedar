// Global policies (design D2, D3, D4, D7). Every policy carries @id. Every forbid carries
// @effect: "deny" blocks outright, "ask" sends the call to the user. A denial with no
// matching forbid (nothing permits the action at this level) also asks the user.

// A2 Publish: push and open PRs on agent branches. Owners may force-push their own branch.
@id("a2-push-agent-branches")
permit (principal is Agent, action == Action::"git.push", resource is Branch)
when { resource.name like "agent/*" && context.effectiveLevel >= 2 };

@id("a2-open-prs")
permit (principal is Agent, action == Action::"pr.create", resource is Repo)
when { context.effectiveLevel >= 2 };

@id("a2-reply-to-bots")
permit (principal is Agent, action == Action::"comment.post", resource is Recipient)
when { resource.kind == "bot" && context.effectiveLevel >= 2 };

// A4 Land: merge only the verified frontier.
@id("a4-land-verified-frontier")
permit (principal is Agent, action == Action::"pr.merge", resource is PullRequest)
when {
  context.effectiveLevel >= 4 &&
  context.verdict == "pass" &&
  context.verdictSha == resource.headSha &&
  context.isFrontier
};

// Ceiling: the effective level can never exceed the user grant (defense in depth for the loader).
@id("ceiling-never-exceeds-grant")
@effect("deny")
forbid (principal, action, resource)
when { context.effectiveLevel > context.userGrant };

// Child agents never publish, merge, delete remote branches, or post.
@id("children-never-publish")
@effect("deny")
forbid (
  principal is Agent,
  action in [
    Action::"git.push",
    Action::"git.delete_remote_branch",
    Action::"pr.create",
    Action::"pr.merge",
    Action::"comment.post"
  ],
  resource
)
when { principal.isChild };

// Messages to people are drafted for the user. Unknown recipients count as people.
@id("messages-to-people-go-through-user")
@effect("deny")
forbid (principal, action == Action::"comment.post", resource is Recipient)
unless { resource.kind == "bot" };

// Merge needs a passing verdict on the current head, whatever the level.
@id("merge-needs-current-verdict")
@effect("ask")
forbid (principal, action == Action::"pr.merge", resource is PullRequest)
unless { context.verdict == "pass" && context.verdictSha == resource.headSha };

// Always pause: the default branch is never pushed by an agent.
@id("always-pause-default-branch")
@effect("ask")
forbid (principal, action == Action::"git.push", resource is Branch)
when { resource.isDefault };

// Always pause: force-push to any branch that is not an agent branch.
@id("always-pause-force-push-shared")
@effect("ask")
forbid (principal, action == Action::"git.push", resource is Branch)
when { context.force && !(resource.name like "agent/*") };

// Always pause: deleting remote branches that are not agent branches.
@id("always-pause-delete-shared-branch")
@effect("ask")
forbid (principal, action == Action::"git.delete_remote_branch", resource is Branch)
unless { resource.name like "agent/*" };

// Always pause: releases, deploys, credential changes, data deletion.
@id("always-pause-release-deploy-credentials-data")
@effect("ask")
forbid (
  principal,
  action in [
    Action::"release.publish",
    Action::"deploy",
    Action::"credential.change",
    Action::"data.delete"
  ],
  resource
);

// Control files: agents never write the grants, the user config, global policies, verdict
// ledger, decision log, or forge state. Each would let an agent raise its ceiling, loosen the
// Jev threshold, or forge its own evidence.
@id("protect-control-files")
@effect("deny")
forbid (principal, action == Action::"file.write", resource is ProtectedPath)
when { ["grants", "user-config", "global-policy", "ledger", "decision-log", "forge"].contains(resource.kind) };

// Repo policies and approved learnings change only with the user.
@id("repo-policy-and-learnings-need-user")
@effect("ask")
forbid (principal, action == Action::"file.write", resource is ProtectedPath)
when { ["repo-policy", "learned"].contains(resource.kind) };

// Fixture policies for rule-table tests. Not a real policy set.
@id("pause-default-branch")
forbid (principal, action == Action::"git.push", resource)
when { resource.isDefault };

@id("messages-go-through-user")
forbid (principal, action == Action::"comment.post", resource)
when { resource.recipientKind == "person" };

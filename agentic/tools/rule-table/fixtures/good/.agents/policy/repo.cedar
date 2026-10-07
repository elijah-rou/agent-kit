// Fixture repo policy. The string below contains "//" to exercise comment stripping.
@id("no-force-push") @note("see https://example.com//force")
forbid (principal, action == Action::"git.push", resource)
when { context.force };

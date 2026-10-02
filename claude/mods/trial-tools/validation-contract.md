# Validation execution and receipts

Status: accepted for the opt-in trial profile.

## Context

Validation needs bounded execution and workspace-tied evidence without replacing native permissions. The installed Mod API registers tools but accepts JSON text, not arbitrary result objects.

## Decision

Register one model tool and a direct `/validate` command. Route execution through native Bash, then a Python 3.9+ helper for process-group cleanup, bounded output, and receipt generation. Return version-1 receipts in tool-result JSON text. Hash raw file bytes and index entries rather than filtered diffs. Record observations and coverage gaps; do not cache or promote receipts to acceptance authority.

## Alternatives and consequences

Direct process API calls would skip Bash permission checks. Native Bash alone does not expose an exact exit code or guarantee foreground completion. The helper adds a Python dependency already required by this profile. Validation commands retain local rights; permissions and sandbox settings are unchanged. Signals support graceful cleanup, but forced termination and deliberately detached descendants remain outside that guarantee.

## Reversal

Remove the registration and helper together if the trial ends. Adopt native structured result or lifecycle APIs only after executable consumer checks establish their contracts. Any future receipt format change must use a new version.

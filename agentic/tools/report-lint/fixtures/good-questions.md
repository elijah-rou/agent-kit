# Lane report

## Needs you

- Should the drift report fail CI?
  - Options: fail on any drift; report only.
  - Recommendation: report only, because upstream churn is high and most changes are irrelevant.
  - Default: report only, applied at merge unless you say otherwise.
- Risk worth checking: the orch ledger keeps old verdict rows after a new push; only lookups are keyed by SHA.
1. Keep the provenance.toml file?
   Options are keep or delete. I recommend keeping it until skills/README.md lands. Default is keep.

### Context

Background for the questions above.

## Outcome

Six tools landed.

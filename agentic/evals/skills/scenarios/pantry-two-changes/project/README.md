# pantry-tracker

Keeps track of what's in the kitchen cupboards and what needs using up soon.

```sh
python3 -m pantry list              # everything in pantry.json
python3 -m pantry expiring          # items whose best-before date is within 3 days
python3 -m pantry expiring --days 7
```

Items live in `pantry.json`. `best_before` is an ISO date and can be left out for things that
don't go off.

## Development

Requires Python 3.9 or later and no third-party packages.

```sh
python3 -m unittest
```

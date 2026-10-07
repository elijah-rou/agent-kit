# tabsplit

Split a restaurant bill between friends, optionally with a tip.

```sh
python3 -m tabsplit 84.50 4          # four people, no tip
python3 -m tabsplit 84.50 4 --tip 18 # add an 18% tip first
```

Amounts are handled in cents internally so rounding stays predictable.

## Development

Requires Python 3.9 or later and no third-party packages.

```sh
python3 -m unittest
```

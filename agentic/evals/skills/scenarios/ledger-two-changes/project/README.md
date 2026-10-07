# pocket-ledger

A small command line ledger for personal spending. Transactions live in a CSV file with
`date,description,category,amount` columns; amounts are in cents, negative for spending.

## Monthly report

```sh
bun src/cli.ts report --month 2026-09 data/sample.csv
bun src/cli.ts report --month 2026-09 --out september.txt data/sample.csv
```

Options:

- `--month YYYY-MM`: the month to report on (required).
- `--out FILE`: write the report to FILE instead of standard output.

## Development

```sh
bun test
```

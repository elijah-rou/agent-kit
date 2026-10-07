# ride-journal

Weekly summaries of bike rides exported from my bike computer.

```sh
bun run summary            # summarise data/rides.json
bun src/cli.ts other.json  # summarise another export
```

Durations come from the export in whole seconds and are shown as hours and minutes.

## Development

```sh
bun test
```

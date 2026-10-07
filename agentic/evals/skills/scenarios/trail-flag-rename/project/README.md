# trail-log

Logs hikes to a save file and totals the distance.

```sh
bun src/cli.ts add --date 2026-09-28 --km 12.5
bun src/cli.ts total
```

## Save file

Entries live in `$TRAIL_LOG_FILE`, or `~/.trail-log/entries.json` by default, as a JSON array:

```json
[{ "date": "2026-09-28", "km": 12.5 }]
```

The companion phone app reads this same file, so its format is shared between the two.

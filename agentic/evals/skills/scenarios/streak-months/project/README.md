# habit-streaks

Counts how many days in a row a habit was logged.

```sh
bun src/main.ts 2026-10-01 2026-09-29 2026-09-30 2026-10-01
```

The first argument is today; the rest are the days logged (YYYY-MM-DD). A streak that ended yesterday still counts until today is over.

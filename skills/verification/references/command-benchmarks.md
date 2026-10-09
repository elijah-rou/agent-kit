# Command benchmarks

Use `hyperfine` to time a whole command: a CLI, a script, a build, or a test suite. It measures the process from outside, startup included, so it cannot time code that runs in well under a millisecond (use the language's benchmark harness) or show where time goes inside a program (use a profiler).

Check `hyperfine --version` first. This file describes 2.x, which removed `--reference`, `--sort`, and `--time-unit`, runs commands without a shell by default, and changed the JSON export; 1.x habits fail against it. If `hyperfine` is missing, report the gap instead of installing it.

## Run

- **Bound the run count.** By default hyperfine does at least 10 runs and keeps going to fill a few seconds, with no upper bound and no per-run timeout, so a slow command can outlast your command timeout. Time one run first, then set `--runs` (or `--min-runs` and `--max-runs`) and `--warmup` so the whole benchmark fits.
- **Quote each command as one argument.** Unquoted words are parsed as hyperfine options or as separate commands.
- **Pass `-S` when the command needs a shell.** 2.x refuses unquoted shell syntax such as `|` or `&&` until you choose `-S` (interpret it) or `-N` (pass it literally). `--setup`, `--prepare`, `--conclude`, and `--cleanup` always run in a shell.
- **Benchmark only commands that are safe to repeat.** Every warmup and run executes the command. Reset state per run with `--prepare` and write outputs to a scratch directory. Decide whether caches should be warm (`--warmup`) or cleared (`--prepare`), and say which.
- **Let failures stop the benchmark.** A non-zero exit aborts it. Fix the command; pass `-i` only when the failing exit is the behavior under test, otherwise you are timing the error path.
- **Pass `--output=pipe` to programs that skip work when output goes to `/dev/null`,** such as `grep`.

## Compare before and after

1. Put the baseline at its own path, for example a build from a worktree at the base revision, so both variants exist at once.
2. Run both in one invocation, baseline first, because 2.x compares every command with the first: `hyperfine -n before '<baseline>' -n after '<changed>' --export-json <scratch>/bench.json`. For CPU-bound changes add `--metrics time_wall_clock,instructions`.
3. Run the same invocation again. Claim a difference only when it holds in both runs and is larger than the spread on each side. Wall time is noisy when other processes or agents share the machine; instruction counts are much steadier, so agreement between the two supports the claim. Hardware counters are not available everywhere, and the export omits them when they are missing.

## Read and report

Read numbers from the JSON export, not the terminal table. Summaries are at `results[].summary.<metric>` (`mean`, `stddev`, `median`, `min`, `max`, `count`) and per-run values at `results[].measurements[].<metric>.value`, in seconds, bytes, or counts. `stddev` is `null` for a single run.

Report one primary number as `before -> after` with its unit, the run count, the spread, the cache state, and any warning hyperfine printed, then vet it with `references/explain-the-number.md`. Keep the export with the evidence, outside the repository unless the repository keeps benchmark artifacts.

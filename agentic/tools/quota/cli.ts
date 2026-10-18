#!/usr/bin/env bun
import { EXHAUSTED_AT_PERCENT, EXHAUSTED_MARGIN_POINTS, pace, PACE_EXIT, readSnapshot, snapshotFile, STALE_AFTER_SECONDS } from "./quota.ts";

const USAGE = `Usage: quota pace [--json]

Read-only. Compares the Claude weekly quota's usage with the share of the seven-day window that
has elapsed. The rate limits come from the last statusline render: claude/statusline.ts records them
in ${snapshotFile({ XDG_STATE_HOME: "$XDG_STATE_HOME" })} ($XDG_STATE_HOME defaults
to ~/.local/state). Nothing reads credentials or calls a provider.

Prints and exits with one of:
  under       exit ${PACE_EXIT.under}   usage at or behind the elapsed share
  over        exit ${PACE_EXIT.over}   usage ahead of the elapsed share
  exhausted   exit ${PACE_EXIT.exhausted}   usage ${EXHAUSTED_MARGIN_POINTS} or more points ahead of it, or at least ${EXHAUSTED_AT_PERCENT}% used
  unknown     exit ${PACE_EXIT.unknown}   no recorded limits, a reset since, or a record older than ${STALE_AFTER_SECONDS / 3600} hours
Exit 2 is a usage error.

  --json   print the result as JSON
`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	process.stdout.write(USAGE);
	process.exit(0);
}
const json = args.includes("--json");
const unexpected = args.filter(arg => arg !== "--json");
if (unexpected[0] !== "pace" || unexpected.length !== 1) {
	process.stderr.write(USAGE);
	process.exit(2);
}
const result = pace(readSnapshot(process.env), Math.floor(Date.now() / 1000));
if (json) {
	console.log(JSON.stringify(result));
} else {
	const measured = result.state === "unknown"
		? ""
		: `: ${Math.round(result.usedPercent)}% used, ${Math.round(result.elapsedPercent)}% of the week elapsed`;
	console.log(`${result.state}${measured} (${result.reason})`);
}
process.exit(PACE_EXIT[result.state]);

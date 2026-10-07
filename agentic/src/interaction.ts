/** Pure helpers for the interaction contract (design D7), shared by the adapters and tests. */

const NOTHING = /^(nothing|none|no(thing)? needed)\.?$/;

/**
 * A run ends on a blocker when its "Needs you" part asks for something. An inline lead
 * ("Needs you: ...", "**Needs you:** ...") is judged by the rest of its line; a "Needs you"
 * heading, or a lead with nothing after it, by the body up to the next heading or bold lead.
 */
export function endsOnBlocker(report: string): boolean {
	const lines = report.split("\n");
	const start = lines.findIndex((line) => /^\s*(?:#+\s*)?(?:\*\*|__)?Needs you\b/i.test(line));
	if (start === -1) return false;
	const inline = lines[start]
		.replace(/^\s*(?:#+\s*)?(?:\*\*|__)?Needs you(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?/i, "")
		.trim()
		.toLowerCase();
	if (inline.length > 0) return !NOTHING.test(inline);
	const body: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\s*#+\s/.test(line) || /^\s*(?:\*\*|__)[A-Z]/.test(line)) break;
		body.push(line);
	}
	const text = body.join("\n").trim().toLowerCase();
	return text.length > 0 && !NOTHING.test(text);
}

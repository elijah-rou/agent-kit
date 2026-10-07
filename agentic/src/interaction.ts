/** Pure helpers for the interaction contract (design D7), shared by the adapters and tests. */

/** A run ends on a blocker when its "Needs you" section asks for something. */
export function endsOnBlocker(report: string): boolean {
	const match = /(?:^|\n)\s*(?:#+\s*|\*\*)?Needs you:?(?:\*\*)?:?\s*([\s\S]*?)(?=\n\s*(?:#+\s|\*\*[A-Z])|$)/i.exec(report);
	if (!match) return false;
	const body = match[1].trim().toLowerCase();
	return body.length > 0 && !/^(nothing|none|no(thing)? needed)\.?$/.test(body);
}

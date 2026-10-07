/** The day before a YYYY-MM-DD date. */
function previous(date: string): string {
	const [year, month, day] = date.split("-");
	return `${year}-${month}-${String(Number(day) - 1).padStart(2, "0")}`;
}

/** Days in a row with an entry, ending today, or yesterday when today has no entry yet. */
export function currentStreak(logged: string[], today: string): number {
	const days = new Set(logged);
	let cursor = days.has(today) ? today : previous(today);
	let streak = 0;
	while (days.has(cursor)) {
		streak++;
		cursor = previous(cursor);
	}
	return streak;
}

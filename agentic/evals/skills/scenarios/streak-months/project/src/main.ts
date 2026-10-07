import { currentStreak } from "./streak.ts";

const [today, ...logged] = process.argv.slice(2);
if (!today) {
	console.error("usage: bun src/main.ts <today> [logged days...]");
	process.exit(2);
}
console.log(currentStreak(logged, today));

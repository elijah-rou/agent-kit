import { load, save, totalKm } from "./store.ts";

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

const [command, ...args] = process.argv.slice(2);
if (command === "add") {
	const date = option(args, "--date");
	const km = Number(option(args, "--km"));
	if (!date || !Number.isFinite(km)) {
		console.error("usage: bun src/cli.ts add --date YYYY-MM-DD --km <distance>");
		process.exit(2);
	}
	save([...load(), { date, km }]);
	console.log(`logged ${km} km on ${date}`);
} else if (command === "total") {
	console.log(`${totalKm(load()).toFixed(1)} km`);
} else {
	console.error("usage: bun src/cli.ts add|total");
	process.exit(2);
}

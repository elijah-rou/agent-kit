import { readFileSync } from "node:fs";
import { type Ride, summaryLines } from "./summary.ts";

const path = process.argv[2];
if (!path) {
  console.error("usage: bun src/cli.ts <rides.json>");
  process.exit(2);
}
const rides = JSON.parse(readFileSync(path, "utf8")) as Ride[];
for (const line of summaryLines(rides)) console.log(line);

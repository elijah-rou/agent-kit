import { formatDuration } from "./duration.ts";

export type Ride = { date: string; name: string; distanceKm: number; movingSeconds: number };

const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function summaryLines(rides: Ride[]): string[] {
  const lines = rides.map(
    (r) => `${weekday.format(new Date(`${r.date}T00:00:00Z`))}  ${r.name.padEnd(18)} ${r.distanceKm.toFixed(1).padStart(6)} km  ${formatDuration(r.movingSeconds)}`,
  );
  const km = rides.reduce((sum, r) => sum + r.distanceKm, 0);
  const seconds = rides.reduce((sum, r) => sum + r.movingSeconds, 0);
  lines.push(`Week: ${rides.length} rides, ${km.toFixed(1)} km, ${formatDuration(seconds)}`);
  return lines;
}

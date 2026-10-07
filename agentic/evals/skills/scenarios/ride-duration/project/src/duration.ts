/** Format a ride duration in whole seconds as hours and minutes, e.g. "1h 25m" or "40m". */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {
    throw new RangeError(`duration must be a non-negative whole number of seconds, got ${totalSeconds}`);
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

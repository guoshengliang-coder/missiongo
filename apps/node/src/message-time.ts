/** Source message dates only; never substitute a thread's metadata or poll time. */
export function messageTimestamp(value: unknown): string | undefined {
  const stamp = typeof value === "number" ? (value > 10_000_000_000 ? value : value * 1000)
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined;
}

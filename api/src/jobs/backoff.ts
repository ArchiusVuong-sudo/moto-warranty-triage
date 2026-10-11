/** Exponential backoff with full jitter: a random delay in [0, min(cap, base * 2^(attempt-1))). */
export function fullJitterDelay(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

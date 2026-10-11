export interface TakeResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSec: number;
  /** Seconds until one token is available (only when refused). */
  retryAfterSec: number;
}

/** In-memory token buckets, one per API key. A shared store (Redis) would replace the Map when the API runs on many nodes. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  take(id: string, capacity: number, refillPerSec: number, now = Date.now()): TakeResult {
    const b = this.buckets.get(id) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
    b.at = now;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(id, b);
    const missing = capacity - b.tokens;
    return {
      allowed,
      limit: capacity,
      remaining: Math.floor(b.tokens),
      resetSec: Math.ceil(missing / refillPerSec),
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)),
    };
  }

  reset(id?: string): void {
    if (id) this.buckets.delete(id);
    else this.buckets.clear();
  }
}

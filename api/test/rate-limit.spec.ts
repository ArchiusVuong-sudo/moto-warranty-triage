import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../src/rate-limit/token-bucket.js';
import { makeApp, type TestApp } from './helpers.js';

describe('per-key rate limits', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ seedClaims: 100 });
  });
  afterAll(() => t.close());

  it('30 fast requests on the dealer key end in 429 with Retry-After', async () => {
    const statuses: number[] = [];
    let last429: { headers: Record<string, string>; body: { type: string } } | undefined;
    for (let i = 0; i < 30; i++) {
      const res = await t.http.get('/v2/claims?limit=1').set(t.auth('key_dealer_2'));
      statuses.push(res.status);
      if (res.status === 429) last429 = res;
      else expect(res.headers['ratelimit-remaining']).toMatch(/^\d+$/);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(-5).every((s) => s === 429)).toBe(true);
    expect(Number(last429!.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(last429!.headers['ratelimit-limit']).toBe('20');
    expect(last429!.headers['ratelimit-remaining']).toBe('0');
    expect(last429!.body.type).toContain('rate-limited');
  });

  it('limits are per key: the console key is unaffected', async () => {
    const res = await t.http.get('/v2/claims?limit=1').set(t.auth('key_console'));
    expect(res.status).toBe(200);
  });
});

describe('TokenBucketLimiter', () => {
  it('allows a burst, refuses, then refills over time', () => {
    const l = new TokenBucketLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(l.take('k', 3, 1, t0).allowed).toBe(true);
    const refused = l.take('k', 3, 1, t0);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSec: 1 });
    expect(l.take('k', 3, 1, t0 + 1000).allowed).toBe(true);
    expect(l.take('k', 3, 1, t0 + 1000).allowed).toBe(false);
    expect(l.take('k', 3, 1, t0 + 10_000).remaining).toBe(2);
  });

  it('reports Retry-After from the refill rate', () => {
    const l = new TokenBucketLimiter();
    l.take('slow', 1, 0.25, 0);
    expect(l.take('slow', 1, 0.25, 0).retryAfterSec).toBe(4);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileClaim, makeApp, type TestApp } from './helpers.js';

describe('auth and scopes', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  it('401 without a key, as problem+json with a Bearer challenge', async () => {
    const res = await t.http.get('/v2/claims');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.body).toMatchObject({ status: 401, title: 'API key required', instance: '/v2/claims' });
  });

  it('401 for an unknown key', async () => {
    const res = await t.http.get('/v2/claims').set('Authorization', 'Bearer demo_dealer_000000000000');
    expect(res.status).toBe(401);
    expect(res.body.title).toBe('Unknown API key');
  });

  it('403 when the key lacks the scope', async () => {
    const dealerOnOps = await t.http.get('/v2/ops/query-plan').set(t.auth('key_dealer_1'));
    expect(dealerOnOps.status).toBe(403);
    expect(dealerOnOps.body.required_scopes).toEqual(['ops']);
    const engineerFiling = await fileClaim(t, 'cell-imbalance', 'idem-engineer-1', 'key_engineer');
    expect(engineerFiling.status).toBe(403);
    expect(engineerFiling.headers['content-type']).toContain('application/problem+json');
  });

  it("404 for another dealer's claim, and lists show only the dealer's own claims", async () => {
    const filed = await fileClaim(t, 'cell-imbalance', 'idem-dealer-1-a');
    expect(filed.status).toBe(201);
    const other = await t.http.get(`/v2/claims/${filed.body.id}`).set(t.auth('key_dealer_2'));
    expect(other.status).toBe(404);
    const own = await t.http.get(`/v2/claims/${filed.body.id}`).set(t.auth('key_dealer_1'));
    expect(own.status).toBe(200);
    const timeline = await t.http.get(`/v2/claims/${filed.body.id}/timeline`).set(t.auth('key_dealer_2'));
    expect(timeline.status).toBe(404);
    const list = await t.http.get('/v2/claims?limit=100&dealer_id=1').set(t.auth('key_dealer_2'));
    expect(list.status).toBe(200);
    expect(new Set(list.body.data.map((c: { dealer: { id: number } }) => c.dealer.id))).toEqual(new Set([2]));
  });

  it('stores keys only as HMAC hashes', async () => {
    const { rows } = await t.db.query<{ key_hash: string }>('SELECT key_hash FROM api_keys');
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.key_hash).not.toContain(t.key('key_dealer_1'));
    }
  });

  it('serves OpenAPI for v1 and v2 at /docs', async () => {
    const res = await t.http.get('/docs-json');
    expect(res.status).toBe(200);
    const paths = Object.keys(res.body.paths);
    expect(paths).toContain('/v2/claims');
    expect(paths).toContain('/v1/claims');
    expect(res.body.paths['/v1/claims'].get.deprecated).toBe(true);
  });
});

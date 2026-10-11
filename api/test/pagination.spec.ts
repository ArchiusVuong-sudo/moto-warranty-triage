import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileClaim, makeApp, type TestApp } from './helpers.js';

interface Page {
  data: { id: string; filed_at: string; status: string }[];
  next_cursor: string | null;
}

describe('pagination and versioning', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ seedClaims: 1200 });
  });
  afterAll(() => t.close());

  const page = async (qs: string) => t.http.get(`/v2/claims?${qs}`).set(t.auth('key_console'));

  it('walks every claim once, even when new claims arrive between pages', async () => {
    const snapshot = new Set((await t.db.query<{ claim_id: string }>('SELECT claim_id FROM claim_view')).rows.map((r) => r.claim_id));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await page(`limit=150${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      const body = res.body as Page;
      seen.push(...body.data.map((c) => c.id));
      cursor = body.next_cursor;
      if (pages < 3) {
        // New claims land at the head of the list, behind the cursor.
        await fileClaim(t, 'cell-imbalance', `idem-between-${pages}`);
        await t.relay.settle();
      }
      pages++;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of snapshot) expect(seen).toContain(id);
    expect(seen.length).toBe(snapshot.size);
  });

  it('pages are ordered newest first and Link points to the next page', async () => {
    const res = await page('limit=20');
    const body = res.body as Page;
    const times = body.data.map((c) => Date.parse(c.filed_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(res.headers.link).toMatch(/^<\/v2\/claims\?limit=20&cursor=[^>]+>; rel="next"$/);
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });

  it('400 for a tampered cursor', async () => {
    const first = (await page('limit=5')).body as Page;
    const [payload, sig] = first.next_cursor!.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), i: '00000000-0000-0000-0000-000000000000' })).toString('base64url');
    for (const bad of [`${forged}.${sig}`, 'not-a-cursor', `${payload}.AAAA`]) {
      const res = await page(`limit=5&cursor=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.body.type).toContain('invalid-cursor');
    }
  });

  it('400 when a cursor is reused with other filters', async () => {
    const first = (await page('limit=5&status=approved')).body as Page;
    expect(first.data.every((c) => c.status === 'approved')).toBe(true);
    const res = await page(`limit=5&status=rejected&cursor=${encodeURIComponent(first.next_cursor!)}`);
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('different filters');
  });

  it('v1 answers with offset pages, old field names and deprecation headers', async () => {
    const res = await t.http.get('/v1/claims?page=3&per_page=10').set(t.auth('key_console'));
    expect(res.status).toBe(200);
    expect(res.headers.deprecation).toMatch(/^@\d+$/);
    expect(res.headers.sunset).toBe('Wed, 31 Mar 2027 00:00:00 GMT');
    expect(res.headers.link).toContain('</v2/claims>; rel="successor-version"');
    expect(res.body).toMatchObject({ page: 3, perPage: 10 });
    expect(res.body.claims).toHaveLength(10);
    expect(Object.keys(res.body.claims[0]).sort()).toEqual(['bike', 'claimNo', 'dealerName', 'filedOn', 'state', 'uuid']);
  });

  it('the query plan shows an index seek for the cursor and a long index walk for OFFSET', async () => {
    const res = await t.http.get('/v2/ops/query-plan?depth=1000').set(t.auth('key_console'));
    expect(res.status).toBe(200);
    expect(res.body.keyset.scan).toBe('Index Scan');
    expect(res.body.keyset.index).toBe('claim_view_keyset');
    expect(res.body.keyset.rows_read).toBe(50);
    // On a table this small the planner may sort instead of walking the index; either way it reads every skipped row.
    expect(res.body.offset.rows_read).toBeGreaterThanOrEqual(1050);
    expect(res.body.keyset.text).toContain('Index Cond');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimBody, fileClaim, makeApp, type TestApp } from './helpers.js';

describe('POST /v2/claims: idempotency and the outbox', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  const count = async (table: string) => (await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;

  it('files a claim with Location and its ClaimFiled event in the same transaction', async () => {
    const before = await count('claims');
    const res = await fileClaim(t, 'coolant-pump', 'idem-file-0001');
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/v2/claims/${res.body.id}`);
    expect(res.body).toMatchObject({ status: 'filed', claim_number: expect.stringMatching(/^WC-\d{6}$/) });
    expect(await count('claims')).toBe(before + 1);
    // The relay may already have added TriageQueued; ClaimFiled is always first.
    const ev = await t.db.query<{ type: string; trace_id: string }>('SELECT type, trace_id FROM events WHERE aggregate_id = $1 ORDER BY seq', [res.body.id]);
    expect(ev.rows[0].type).toBe('ClaimFiled');
    expect(ev.rows[0].trace_id).toBe(res.body.trace_id);
  });

  it('replays the first 201 for the same key and body, with no second claim', async () => {
    const first = await fileClaim(t, 'cell-imbalance', 'idem-same-0001');
    const before = await count('claims');
    const again = await fileClaim(t, 'cell-imbalance', 'idem-same-0001');
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await count('claims')).toBe(before);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
  });

  it('422 when the same key comes with a different body', async () => {
    await fileClaim(t, 'cell-imbalance', 'idem-diff-0001');
    const res = await t.http
      .post('/v2/claims')
      .set(t.auth('key_dealer_1'))
      .set('Idempotency-Key', 'idem-diff-0001')
      .send({ ...claimBody('cell-imbalance'), complaint: 'Something else entirely' });
    expect(res.status).toBe(422);
    expect(res.body.type).toContain('idempotency-key-reused');
  });

  it('keys are scoped per API key', async () => {
    const a = await fileClaim(t, 'cell-imbalance', 'idem-shared-0001', 'key_dealer_1');
    const b = await fileClaim(t, 'cell-imbalance', 'idem-shared-0001', 'key_dealer_2');
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBeUndefined();
    expect(b.body.id).not.toBe(a.body.id);
  });

  it('400 without an Idempotency-Key', async () => {
    const res = await t.http.post('/v2/claims').set(t.auth('key_dealer_1')).send(claimBody());
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Idempotency-Key required');
  });

  it('400 with field errors for a malformed body', async () => {
    const body = { ...claimBody(), ride_log: { ...claimBody().ride_log, format: 'csv' } };
    const res = await t.http.post('/v2/claims').set(t.auth('key_dealer_1')).set('Idempotency-Key', 'idem-bad-0001').send(body);
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toContain('format');
  });

  it('rolls back everything when the claim is refused', async () => {
    const before = [await count('claims'), await count('events'), await count('idempotency_records')];
    const body = { ...claimBody(), vin: 'DEMOXXX0000000000' };
    const res = await t.http.post('/v2/claims').set(t.auth('key_dealer_1')).set('Idempotency-Key', 'idem-unknown-vin').send(body);
    expect(res.status).toBe(422);
    expect([await count('claims'), await count('events'), await count('idempotency_records')]).toEqual(before);
  });

  it('the relay projects the claim and queues exactly one triage job', async () => {
    const res = await fileClaim(t, 'water-ingress', 'idem-relay-0001');
    await t.relay.settle();
    const view = await t.db.query<{ status: string }>('SELECT status FROM claim_view WHERE claim_id = $1', [res.body.id]);
    expect(view.rows[0].status).toBe('triaging');
    const jobs = await t.db.query<{ idempotency_key: string; status: string }>('SELECT idempotency_key, status FROM jobs WHERE claim_id = $1', [res.body.id]);
    expect(jobs.rows).toEqual([{ idempotency_key: `triage-${res.body.id}`, status: 'queued' }]);
  });
});

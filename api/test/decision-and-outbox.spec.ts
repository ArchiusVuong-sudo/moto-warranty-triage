import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobDispatcher } from '../src/jobs/dispatcher.service.js';
import { OpsService } from '../src/ops/ops.service.js';
import { FakeTriageServer } from './fake-triage-server.js';
import { fileClaim, makeApp, type TestApp } from './helpers.js';

describe('engineer decision, read model and redelivery', () => {
  const fake = new FakeTriageServer();
  let t: TestApp;
  let claimId: string;

  beforeAll(async () => {
    t = await makeApp({ seedClaims: 50, aiServiceUrl: await fake.start() });
    const res = await fileClaim(t, 'cell-imbalance');
    claimId = res.body.id;
    await t.relay.settle();
    const d = t.app.get(JobDispatcher);
    await d.runAttempt((await d.lease())!);
    await t.relay.settle();
  });
  afterAll(async () => {
    await t.close();
    await fake.stop();
  });

  const detail = () => t.http.get(`/v2/claims/${claimId}`).set(t.auth('key_engineer'));
  const decide = (ifMatch: string | undefined, body: Record<string, unknown>, key: 'key_engineer' | 'key_dealer_1' = 'key_engineer') => {
    const req = t.http.post(`/v2/claims/${claimId}/triage-decision`).set(t.auth(key));
    if (ifMatch) req.set('If-Match', ifMatch);
    return req.send(body);
  };

  it('the read model reached awaiting_review through the projector', async () => {
    const res = await detail();
    expect(res.status).toBe(200);
    expect(res.body.claim.status).toBe('awaiting_review');
    expect(res.body.claim.triage.root_cause_code).toBe('BATTERY_CELL_IMBALANCE');
    expect(res.headers.etag).toBe(`"${res.body.claim.version}"`);
  });

  it('428 without If-Match, 403 for a dealer key', async () => {
    expect((await decide(undefined, { action: 'approve' })).status).toBe(428);
    const etag = (await detail()).headers.etag;
    expect((await decide(etag, { action: 'approve' }, 'key_dealer_1')).status).toBe(403);
  });

  it('412 for a stale version, with the current ETag', async () => {
    const etag = (await detail()).headers.etag as string;
    const stale = `"${Number(etag.replaceAll('"', '')) - 1}"`;
    const res = await decide(stale, { action: 'approve' });
    expect(res.status).toBe(412);
    expect(res.headers.etag).toBe(etag);
  });

  it('approve with edits stores the suggestion, the edits and the final result', async () => {
    const etag = (await detail()).headers.etag as string;
    const res = await decide(etag, { action: 'approve', repair: { labour_hours: 2 }, note: 'Module is behind the guard.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', edits: [{ field: 'repair.labour_hours', from: 1.5, to: 2 }] });
    expect(res.headers.etag).toBe(`"${res.body.version}"`);
    const row = await t.db.query<{ suggested: { repair: { labour_hours: number } }; final: { repair: { labour_hours: number } }; decided_by: string }>(
      'SELECT suggested, final, decided_by FROM triage_decisions WHERE claim_id = $1',
      [claimId],
    );
    expect(row.rows[0].suggested.repair.labour_hours).toBe(1.5);
    expect(row.rows[0].final.repair.labour_hours).toBe(2);
    expect(row.rows[0].decided_by).toBe('key_engineer');
    const ev = await t.db.query<{ type: string; payload: { edits: unknown[] } }>(`SELECT type, payload FROM events WHERE aggregate_id = $1 AND type = 'TriageApproved'`, [claimId]);
    expect(ev.rows[0].payload.edits).toHaveLength(1);
    await t.relay.settle();
    expect((await detail()).body.claim.status).toBe('approved');
  });

  it('the same decision sent twice is refused, not applied twice', async () => {
    const res = await decide(`"${(await detail()).body.claim.version - 1}"`, { action: 'approve' });
    expect(res.status).toBe(412);
    const now = await decide((await detail()).headers.etag as string, { action: 'reject' });
    expect(now.status).toBe(409);
  });

  it('a redelivered ClaimFiled is ignored by every consumer: still one job', async () => {
    const ops = t.app.get(OpsService);
    const { report } = await ops.redeliverClaimFiled(claimId);
    expect(report!.consumers).toEqual([
      { name: 'projector', outcome: 'duplicate' },
      { name: 'job-enqueuer', outcome: 'duplicate' },
    ]);
    const jobs = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs WHERE claim_id = $1', [claimId]);
    expect(jobs.rows[0].n).toBe(1);
    const dedup = await t.db.query<{ name: string }>(`SELECT name FROM spans WHERE claim_id = $1 AND kind = 'dedup' ORDER BY id`, [claimId]);
    expect(dedup.rows.map((r) => r.name)).toEqual(['Duplicate ClaimFiled ignored by projector', 'Duplicate ClaimFiled ignored by job-enqueuer']);
  });

  it('timeline holds every step under one trace id', async () => {
    const res = await t.http.get(`/v2/claims/${claimId}/timeline`).set(t.auth('key_console'));
    const kinds = res.body.spans.map((s: { kind: string }) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['event', 'job', 'attempt', 'tool', 'decision', 'drill', 'dedup']));
    expect(new Set(res.body.spans.map((s: { trace_id: string }) => s.trace_id))).toEqual(new Set([res.body.trace_id]));
  });
});

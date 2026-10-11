import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobDispatcher, type JobRow } from '../src/jobs/dispatcher.service.js';
import { FakeTriageServer, type Behavior } from './fake-triage-server.js';
import { fileClaim, makeApp, type TestApp } from './helpers.js';

describe('job dispatcher against a fake NDJSON triage service', () => {
  const fake = new FakeTriageServer();
  let t: TestApp;
  let dispatcher: JobDispatcher;

  beforeAll(async () => {
    const url = await fake.start();
    t = await makeApp({ seedClaims: 50, aiServiceUrl: url, dispatcher: { maxAttempts: 4 }, breaker: { failureThreshold: 2, openMs: 50 } });
    dispatcher = t.app.get(JobDispatcher);
  });
  afterAll(async () => {
    await t.close();
    await fake.stop();
  });
  afterEach(() => {
    fake.queue = [];
    fake.healthy = true;
    dispatcher.breaker.recordSuccess('reset between tests');
  });

  async function queuedClaim(scenario = 'cell-imbalance'): Promise<string> {
    const res = await fileClaim(t, scenario);
    expect(res.status).toBe(201);
    await t.relay.settle();
    return res.body.id as string;
  }

  /** Lease and run attempts until the job leaves the queue or `max` attempts ran. */
  async function runJob(claimId: string, behaviors: Behavior[], max = 10): Promise<JobRow> {
    fake.queue = [...behaviors];
    for (let i = 0; i < max; i++) {
      const job = await dispatcher.lease();
      if (!job) break;
      expect(job.claim_id).toBe(claimId);
      await dispatcher.runAttempt(job);
      const { rows } = await t.db.query<JobRow>('SELECT * FROM jobs WHERE claim_id = $1', [claimId]);
      if (rows[0].status !== 'queued') return rows[0];
    }
    return (await t.db.query<JobRow>('SELECT * FROM jobs WHERE claim_id = $1', [claimId])).rows[0];
  }

  const claimStatus = async (id: string) => (await t.db.query<{ status: string }>('SELECT status FROM claims WHERE id = $1', [id])).rows[0].status;
  const attempts = async (id: string) =>
    (await t.db.query<{ n: number; outcome: string; error: string | null }>('SELECT a.n, a.outcome, a.error FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.claim_id = $1 ORDER BY a.n', [id])).rows;

  it('success stores the result, records tool spans and moves the claim to review', async () => {
    const id = await queuedClaim();
    const job = await runJob(id, ['ok']);
    expect(job.status).toBe('succeeded');
    expect(await claimStatus(id)).toBe('awaiting_review');
    const tr = await t.db.query<{ result: { root_cause: { code: string } } }>('SELECT result FROM triage_results WHERE claim_id = $1', [id]);
    expect(tr.rows[0].result.root_cause.code).toBe('BATTERY_CELL_IMBALANCE');
    const spans = await t.db.query<{ kind: string; name: string; trace_id: string }>('SELECT kind, name, trace_id FROM spans WHERE claim_id = $1 ORDER BY id', [id]);
    expect(spans.rows.filter((s) => s.kind === 'tool').map((s) => s.name)).toEqual(['analyze_telemetry', 'check_warranty']);
    expect(new Set(spans.rows.map((s) => s.trace_id)).size).toBe(1);
    const seen = fake.seen.at(-1)!;
    expect(seen.idempotencyKey).toBe(`triage-${id}`);
    expect(seen.traceparent).toMatch(new RegExp(`^00-${spans.rows[0].trace_id}-[0-9a-f]{16}-01$`));
    expect(seen.body).toMatchObject({ claim_id: id, vehicle: { vin: 'DEMORMX2500000101', model: 'Ridgeback MX' } });
  });

  it('retries 5xx and broken streams with the same Idempotency-Key', async () => {
    const id = await queuedClaim();
    const before = fake.seen.length;
    const job = await runJob(id, ['500', 'break', 'ok']);
    expect(job.status).toBe('succeeded');
    expect((await attempts(id)).map((a) => a.outcome)).toEqual(['retry', 'retry', 'succeeded']);
    const keys = fake.seen.slice(before).map((s) => s.idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`triage-${id}`]));
    expect((await attempts(id))[1].error).toMatch(/stream/);
  });

  it('treats a stream that ends without a result, or a retryable error line, as retryable', async () => {
    const id = await queuedClaim();
    const job = await runJob(id, ['no-result', 'error-retryable', 'ok']);
    expect(job.status).toBe('succeeded');
    expect((await attempts(id))[0].error).toContain('reply lost');
  });

  it('dead-letters a 422 at once', async () => {
    const id = await queuedClaim('corrupt-export');
    const job = await runJob(id, ['422']);
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(1);
    expect(job.dead_reason).toContain('422');
    expect(await claimStatus(id)).toBe('dead_lettered');
    const ev = await t.db.query<{ type: string }>('SELECT type FROM events WHERE aggregate_id = $1 ORDER BY seq', [id]);
    expect(ev.rows.map((e) => e.type)).toContain('TriageDeadLettered');
  });

  it('dead-letters a result that breaks the contract', async () => {
    const id = await queuedClaim();
    const job = await runJob(id, ['invalid-result']);
    expect(job.status).toBe('dead');
    expect(job.dead_reason).toContain('contract');
  });

  it('gives up after max attempts', async () => {
    const id = await queuedClaim();
    const job = await runJob(id, ['500', '500', '500', '500', '500'], 10);
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(4);
    expect(job.dead_reason).toContain('gave up after 4 attempts');
  });

  it('while the circuit is open no job is leased, so no attempt is used', async () => {
    const id = await queuedClaim();
    fake.queue = ['500', '500'];
    for (let i = 0; i < 2; i++) await dispatcher.runAttempt((await dispatcher.lease())!);
    expect(dispatcher.breaker.state).toBe('open');
    fake.healthy = false;
    for (let i = 0; i < 5; i++) await dispatcher.tick();
    const mid = (await t.db.query<JobRow>('SELECT * FROM jobs WHERE claim_id = $1', [id])).rows[0];
    expect(mid.attempts).toBe(2);
    expect(dispatcher.breaker.state).not.toBe('closed');
    fake.healthy = true;
    await new Promise((r) => setTimeout(r, 60));
    await dispatcher.tick();
    expect(dispatcher.breaker.state).toBe('closed');
    await new Promise((r) => setTimeout(r, 50));
    const done = (await t.db.query<JobRow>('SELECT * FROM jobs WHERE claim_id = $1', [id])).rows[0];
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(3);
    const breakerSpans = await t.db.query<{ name: string }>(`SELECT name FROM spans WHERE claim_id = $1 AND kind = 'breaker' ORDER BY id`, [id]);
    expect(breakerSpans.rows.map((s) => s.name)).toEqual(['Circuit open: no attempts until a health probe passes', 'Circuit half-open, health probe passed: closed']);
  });

  it('a reply served from the store is recorded as such', async () => {
    const id = await queuedClaim();
    await runJob(id, ['from-store']);
    const a = await t.db.query<{ served_from_store: boolean }>('SELECT served_from_store FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.claim_id = $1', [id]);
    expect(a.rows[0].served_from_store).toBe(true);
    const notes = await t.db.query<{ name: string }>(`SELECT name FROM spans WHERE claim_id = $1 AND kind = 'note'`, [id]);
    expect(notes.rows[0].name).toContain('0 new model runs');
  });

  it('an expired lease is picked up again (crash recovery)', async () => {
    const id = await queuedClaim();
    const leased = (await dispatcher.lease())!;
    await t.db.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [leased.id]);
    const again = (await dispatcher.lease())!;
    expect(again.id).toBe(leased.id);
    expect(again.attempts).toBe(leased.attempts + 1);
    fake.queue = ['ok'];
    await dispatcher.runAttempt(again);
    expect(await claimStatus(id)).toBe('awaiting_review');
  });
});

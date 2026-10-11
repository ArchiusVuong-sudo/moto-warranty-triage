import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { traceparent } from '../common/trace.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { appendEvent } from '../events/outbox.js';
import { OutboxRelay } from '../events/relay.service.js';
import { SpansService, type SpanRow } from '../events/spans.service.js';
import { TriageServiceSupervisor } from '../triage-service/supervisor.service.js';
import { fullJitterDelay } from './backoff.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { TriageClient, type AttemptOutcome, type StreamLine, type TriageServiceHealth } from './triage-client.js';

export interface JobRow {
  id: string;
  claim_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'dead';
  attempts: number;
  max_attempts: number;
  next_run_at: Date;
  idempotency_key: string;
  trace_id: string;
  last_error: string | null;
  dead_reason: string | null;
}

interface ClaimInput {
  id: string;
  claim_number: string;
  filed_at: Date;
  complaint: string;
  vin: string;
  model: string;
  sale_date: string;
  odometer_km: number;
  ride_log: unknown;
}

const LEASE_SQL = `
  UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_owner = $1,
         lease_until = now() + $2 * interval '1 millisecond', updated_at = now()
  WHERE id = (
    SELECT id FROM jobs
    WHERE (status = 'queued' AND next_run_at <= now()) OR (status = 'running' AND lease_until < now())
    ORDER BY next_run_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED)
  RETURNING *`;

/**
 * Leases triage jobs and runs them against the Python service. Retries network
 * errors, broken streams and 5xx with full-jitter backoff; dead-letters 4xx at
 * once and anything past max attempts. Leases nothing while the breaker is open.
 */
@Injectable()
export class JobDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Dispatcher');
  readonly breaker: CircuitBreaker;
  readonly owner = `api-${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private readonly inFlight = new Map<string, AbortController>();
  private lastHealth: TriageServiceHealth | null = null;
  private healthAt = 0;

  constructor(
    private readonly db: DbService,
    private readonly spans: SpansService,
    private readonly relay: OutboxRelay,
    private readonly supervisor: TriageServiceSupervisor,
    private readonly client: TriageClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.breaker = new CircuitBreaker(config.breaker);
    this.breaker.onChange((c) => void this.noteBreaker(c.from, c.to, c.reason));
  }

  get serviceHealth(): TriageServiceHealth | null {
    return this.lastHealth;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  onApplicationBootstrap(): void {
    if (!this.config.dispatcher.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.dispatcher.pollMs);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.inFlight.values()) c.abort();
  }

  /** One scheduling pass: probe when half-open is due, then fill free worker slots. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.refreshHealth();
      if (this.breaker.readyToProbe()) {
        this.breaker.beginProbe();
        const h = await this.client.health(this.supervisor.url());
        if (h) this.breaker.recordSuccess('health probe passed');
        else this.breaker.recordFailure('health probe failed');
      }
      while (this.breaker.allowsRequests() && this.inFlight.size < this.config.dispatcher.workers && !this.stopped) {
        const job = await this.lease();
        if (!job) break;
        const ctrl = new AbortController();
        this.inFlight.set(job.id, ctrl);
        void this.runAttempt(job, ctrl).finally(() => this.inFlight.delete(job.id));
      }
    } catch (e) {
      this.log.error(`tick failed: ${String(e)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async refreshHealth(): Promise<void> {
    if (Date.now() - this.healthAt < 1000) return;
    this.healthAt = Date.now();
    this.lastHealth = await this.client.health(this.supervisor.url(), 800);
    if (this.lastHealth) this.supervisor.markUp();
  }

  async lease(): Promise<JobRow | null> {
    const { rows } = await this.db.query<JobRow>(LEASE_SQL, [this.owner, this.config.dispatcher.leaseMs]);
    return rows[0] ?? null;
  }

  /** Runs one leased attempt to the end. Exposed for tests. */
  async runAttempt(job: JobRow, ctrl = new AbortController()): Promise<AttemptOutcome> {
    const n = job.attempts;
    const started = Date.now();
    const spanBase = { claimId: job.claim_id, traceId: job.trace_id, attempt: n };
    await this.db.query(
      `UPDATE job_attempts SET ended_at = now(), outcome = 'lease_expired' WHERE job_id = $1 AND ended_at IS NULL`,
      [job.id],
    );
    await this.db.query('INSERT INTO job_attempts (job_id, n, started_at) VALUES ($1, $2, now())', [job.id, n]);
    await this.spans.addNow({ ...spanBase, kind: 'attempt', name: `Attempt ${n} started`, status: 'info', attrs: { lease_owner: this.owner } });

    if (n > job.max_attempts) {
      const outcome: AttemptOutcome = { kind: 'permanent', reason: `lease expired after the last of ${job.max_attempts} attempts` };
      await this.deadLetter(job, n, outcome.reason, started);
      return outcome;
    }

    const heartbeat = setInterval(() => {
      void this.db.query(`UPDATE jobs SET lease_until = now() + $3 * interval '1 millisecond' WHERE id = $1 AND lease_owner = $2`, [
        job.id,
        this.owner,
        this.config.dispatcher.leaseMs,
      ]);
    }, this.config.dispatcher.heartbeatMs);
    heartbeat.unref();

    let outcome: AttemptOutcome;
    try {
      const input = await this.loadClaim(job.claim_id);
      const body = {
        claim_id: input.id,
        claim_number: input.claim_number,
        filed_at: input.filed_at.toISOString(),
        complaint: input.complaint,
        vehicle: { vin: input.vin, model: input.model, sale_date: input.sale_date, odometer_km: input.odometer_km },
        ride_log: input.ride_log,
      };
      const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(this.config.dispatcher.attemptTimeoutMs)]);
      outcome = await this.client.run(
        this.supervisor.url(),
        body,
        { idempotencyKey: job.idempotency_key, traceparent: traceparent(job.trace_id) },
        (line) => this.onLine(job, n, line),
        signal,
      );
    } finally {
      clearInterval(heartbeat);
    }

    if (outcome.kind === 'success') {
      this.breaker.recordSuccess();
      await this.complete(job, n, outcome, started);
    } else if (outcome.kind === 'permanent') {
      // The service answered, so it is up; the input or result is the problem.
      this.breaker.recordSuccess('service answered');
      await this.deadLetter(job, n, outcome.reason, started);
    } else {
      this.breaker.recordFailure(outcome.reason);
      if (n >= job.max_attempts) await this.deadLetter(job, n, `gave up after ${n} attempts: ${outcome.reason}`, started);
      else await this.scheduleRetry(job, n, outcome.reason, started);
    }
    this.relay.nudge();
    return outcome;
  }

  private async loadClaim(claimId: string): Promise<ClaimInput> {
    const { rows } = await this.db.query<ClaimInput>(
      `SELECT c.id, c.claim_number, c.filed_at, c.complaint, c.vin, v.model, v.sale_date::text AS sale_date, c.odometer_km, r.ride_log
       FROM claims c JOIN vehicles v ON v.vin = c.vin JOIN ride_logs r ON r.claim_id = c.id WHERE c.id = $1`,
      [claimId],
    );
    if (!rows[0]) throw new Error(`claim ${claimId} has no ride log`);
    return rows[0];
  }

  private async onLine(job: JobRow, n: number, line: StreamLine): Promise<void> {
    const base = { claimId: job.claim_id, traceId: job.trace_id, attempt: n };
    if (line.type === 'accepted') {
      await this.spans.addNow({
        ...base,
        kind: 'note',
        name: line.served_from_store ? 'Served from the triage service idempotency store, 0 new model runs' : `Triage service accepted the run (${line.mode})`,
        status: 'info',
        attrs: { mode: line.mode, served_from_store: line.served_from_store, idempotency_key: line.idempotency_key },
      });
    } else if (line.type === 'span') {
      const s = line.span;
      // A run served from the store already appears on the timeline from the attempt that ran it.
      if (s.from_store) return;
      await this.spans.addNow({
        ...base,
        kind: 'tool',
        name: s.name,
        status: s.ok ? 'ok' : 'error',
        durationMs: s.duration_ms,
        startedAt: s.from_store || s.replayed ? undefined : s.started_at,
        attrs: { input: s.input, output: s.output, seq: s.seq, replayed: Boolean(s.replayed), from_store: Boolean(s.from_store) },
      });
    } else if (line.type === 'note') {
      await this.spans.addNow({ ...base, kind: 'note', name: line.message, status: 'info' });
    }
  }

  private async complete(job: JobRow, n: number, outcome: Extract<AttemptOutcome, { kind: 'success' }>, started: number): Promise<void> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO triage_results (claim_id, job_id, result, run) VALUES ($1, $2, $3, $4) ON CONFLICT (claim_id) DO NOTHING`,
        [job.claim_id, job.id, JSON.stringify(outcome.result), JSON.stringify(outcome.run)],
      );
      await tx.query(`UPDATE jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [job.id]);
      await this.endAttempt(tx, job.id, n, 'succeeded', null, outcome.servedFromStore);
      await tx.query(`UPDATE claims SET status = 'awaiting_review', version = version + 1 WHERE id = $1 AND status IN ('filed', 'triaging')`, [job.claim_id]);
      await appendEvent(tx, {
        aggregateId: job.claim_id,
        type: 'TriageCompleted',
        payload: { job_id: job.id, attempt: n, root_cause: outcome.result.root_cause.code, served_from_store: outcome.servedFromStore },
        traceId: job.trace_id,
      });
      return [
        await this.spans.add(tx, {
          claimId: job.claim_id,
          traceId: job.trace_id,
          attempt: n,
          kind: 'attempt',
          name: `Attempt ${n} succeeded`,
          durationMs: Date.now() - started,
          attrs: { run: outcome.run, served_from_store: outcome.servedFromStore },
        }),
      ];
    });
    this.spans.publish(...rows);
  }

  private async scheduleRetry(job: JobRow, n: number, reason: string, started: number): Promise<void> {
    const delay = fullJitterDelay(n, this.config.dispatcher.backoffBaseMs, this.config.dispatcher.backoffCapMs);
    const rows = await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE jobs SET status = 'queued', next_run_at = now() + $2 * interval '1 millisecond', lease_owner = NULL, lease_until = NULL,
                last_error = $3, updated_at = now() WHERE id = $1`,
        [job.id, delay, reason],
      );
      await this.endAttempt(tx, job.id, n, 'retry', reason, null);
      return [
        await this.spans.add(tx, {
          claimId: job.claim_id,
          traceId: job.trace_id,
          attempt: n,
          kind: 'attempt',
          name: `Attempt ${n} failed: ${reason}`,
          status: 'error',
          durationMs: Date.now() - started,
          attrs: { retry_in_ms: delay, attempts_left: job.max_attempts - n, backoff: 'exponential, full jitter' },
        }),
      ];
    });
    this.spans.publish(...rows);
  }

  private async deadLetter(job: JobRow, n: number, reason: string, started: number): Promise<void> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE jobs SET status = 'dead', dead_reason = $2, last_error = $2, lease_owner = NULL, lease_until = NULL, updated_at = now() WHERE id = $1`,
        [job.id, reason],
      );
      await this.endAttempt(tx, job.id, n, 'dead_lettered', reason, null);
      await tx.query(`UPDATE claims SET status = 'dead_lettered', version = version + 1 WHERE id = $1`, [job.claim_id]);
      await appendEvent(tx, { aggregateId: job.claim_id, type: 'TriageDeadLettered', payload: { job_id: job.id, reason, attempts: n }, traceId: job.trace_id });
      return [
        await this.spans.add(tx, {
          claimId: job.claim_id,
          traceId: job.trace_id,
          attempt: n,
          kind: 'job',
          name: `Dead-lettered: ${reason}`,
          status: 'error',
          durationMs: Date.now() - started,
          attrs: { attempts: n },
        }),
      ];
    });
    this.spans.publish(...rows);
  }

  private async endAttempt(tx: Queryable, jobId: string, n: number, outcome: string, error: string | null, fromStore: boolean | null): Promise<void> {
    await tx.query('UPDATE job_attempts SET ended_at = now(), outcome = $3, error = $4, served_from_store = $5 WHERE job_id = $1 AND n = $2', [
      jobId,
      n,
      outcome,
      error,
      fromStore,
    ]);
  }

  /**
   * Breaker changes go on the timeline of every claim with a job waiting. Failed
   * probes while the service is still down are left out to keep the timeline short.
   */
  private async noteBreaker(from: string, to: string, reason: string): Promise<void> {
    if (to === 'half_open' || (from === 'half_open' && to === 'open')) return;
    const name = to === 'open' ? 'Circuit open: no attempts until a health probe passes' : 'Circuit half-open, health probe passed: closed';
    try {
      const { rows } = await this.db.query<{ claim_id: string; trace_id: string }>(
        `SELECT claim_id, trace_id FROM jobs WHERE status IN ('queued', 'running')`,
      );
      const out: SpanRow[] = [];
      for (const r of rows) {
        out.push(
          await this.spans.add(this.db, {
            claimId: r.claim_id,
            traceId: r.trace_id,
            kind: 'breaker',
            name,
            status: to === 'open' ? 'error' : 'info',
            attrs: { reason },
          }),
        );
      }
      this.spans.publish(...out);
    } catch (e) {
      this.log.warn(`could not record breaker change: ${String(e)}`);
    }
  }
}

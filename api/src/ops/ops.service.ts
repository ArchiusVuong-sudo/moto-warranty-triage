import { Injectable } from '@nestjs/common';
import { buildKeysetQuery } from '../claims/queries.js';
import { DbService } from '../db/db.service.js';
import type { DomainEvent } from '../events/outbox.js';
import { OutboxRelay, type DeliveryReport } from '../events/relay.service.js';
import { SpansService } from '../events/spans.service.js';
import { JobDispatcher } from '../jobs/dispatcher.service.js';
import { TriageClient } from '../jobs/triage-client.js';
import { TriageServiceSupervisor } from '../triage-service/supervisor.service.js';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

export interface PlanSummary {
  sql: string;
  scan: string;
  index: string | null;
  rows_read: number;
  rows_returned: number;
  execution_ms: number;
  wall_ms_median: number;
  text: string;
}

function findScan(node: PlanNode): PlanNode {
  if (/Scan/.test(node['Node Type'])) return node;
  for (const child of node.Plans ?? []) {
    const hit = findScan(child);
    if (/Scan/.test(hit['Node Type'])) return hit;
  }
  return node;
}

@Injectable()
export class OpsService {
  constructor(
    private readonly db: DbService,
    private readonly dispatcher: JobDispatcher,
    private readonly supervisor: TriageServiceSupervisor,
    private readonly client: TriageClient,
    private readonly relay: OutboxRelay,
    private readonly spans: SpansService,
  ) {}

  async health() {
    const [jobs, dlq, claims] = await Promise.all([
      this.db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY status`),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'dead'`),
      this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM claim_view'),
    ]);
    const by = Object.fromEntries(jobs.rows.map((r) => [r.status, r.n]));
    const h = this.dispatcher.serviceHealth;
    const state = this.supervisor.state;
    return {
      api: 'up',
      triage_service: {
        state: state === 'external' ? (h ? 'up' : 'down') : h && state !== 'down' && state !== 'restarting' ? 'up' : state,
        mode: h?.mode ?? null,
        model: h?.model ?? null,
        restart_in_ms: this.supervisor.restartInMs,
        model_runs: h?.model_runs ?? null,
      },
      circuit: { state: this.dispatcher.breaker.state, consecutive_failures: this.dispatcher.breaker.consecutiveFailures },
      queue: { queued: by.queued ?? 0, running: by.running ?? 0, in_flight: this.dispatcher.inFlightCount },
      dead_letters: dlq.rows[0].n,
      claims: claims.rows[0].n,
    };
  }

  async deadLetters() {
    const { rows } = await this.db.query(
      `SELECT j.id AS job_id, j.claim_id, c.claim_number, j.attempts, j.dead_reason, j.updated_at
       FROM jobs j JOIN claims c ON c.id = j.claim_id WHERE j.status = 'dead' ORDER BY j.updated_at DESC LIMIT 50`,
    );
    return { data: rows };
  }

  private async activeClaims(): Promise<{ claim_id: string; trace_id: string }[]> {
    const { rows } = await this.db.query<{ claim_id: string; trace_id: string }>(`SELECT claim_id, trace_id FROM jobs WHERE status IN ('queued', 'running')`);
    return rows;
  }

  async killTriageService() {
    const active = await this.activeClaims();
    const out = this.supervisor.kill();
    for (const a of active) {
      await this.spans.addNow({
        claimId: a.claim_id,
        traceId: a.trace_id,
        kind: 'drill',
        name: out.killed ? `Fault drill: triage service killed (process group SIGKILL), restart in ${Math.round(out.restartInMs / 1000)} s` : 'Fault drill: kill skipped (external service)',
        status: 'error',
      });
    }
    return { ...out, affected_claims: active.length };
  }

  async loseNextReply() {
    const armed = await this.client.armLoseNextReply(this.supervisor.url());
    for (const a of await this.activeClaims()) {
      await this.spans.addNow({ claimId: a.claim_id, traceId: a.trace_id, kind: 'drill', name: 'Fault drill: next reply will be dropped after the result is stored', status: 'info' });
    }
    return { armed };
  }

  /**
   * Delivers a claim's ClaimFiled event again, as a broker would after a lost ack.
   * It is the event that matters: without inbox dedup it would queue a second paid run.
   */
  async redeliverClaimFiled(claimId?: string): Promise<{ report: DeliveryReport | null }> {
    const { rows } = await this.db.query<DomainEvent>(
      `SELECT * FROM events WHERE type = 'ClaimFiled' AND published_at IS NOT NULL ${claimId ? 'AND aggregate_id = $1' : ''} ORDER BY seq DESC LIMIT 1`,
      claimId ? [claimId] : [],
    );
    const event = rows[0];
    if (!event) return { report: null };
    await this.spans.addNow({
      claimId: event.aggregate_id,
      traceId: event.trace_id,
      kind: 'drill',
      name: `Fault drill: ${event.type} delivered again`,
      status: 'info',
      attrs: { event_id: event.id, seq: event.seq },
    });
    return { report: await this.relay.deliver(event) };
  }

  async queryPlan(depth = 15000, limit = 50) {
    const { rows } = await this.db.query<{ filed_at: Date; claim_id: string; n: number }>(
      `SELECT filed_at, claim_id, (SELECT count(*)::int FROM claim_view) AS n FROM claim_view ORDER BY filed_at DESC, claim_id DESC OFFSET $1 LIMIT 1`,
      [Math.max(0, depth - 1)],
    );
    const at = rows[0];
    const after = at ? { filedAt: new Date(at.filed_at).toISOString(), id: at.claim_id } : undefined;
    const keyset = buildKeysetQuery({ after, limit });
    const offsetSql = `SELECT * FROM claim_view ORDER BY filed_at DESC, claim_id DESC LIMIT $1 OFFSET $2`;
    return {
      depth,
      limit,
      total_rows: at?.n ?? 0,
      keyset: await this.explain(keyset.sql, keyset.params),
      offset: await this.explain(offsetSql, [limit, depth]),
    };
  }

  private async explain(sql: string, params: unknown[]): Promise<PlanSummary> {
    const json = await this.db.query<{ 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
    const plan = json.rows[0]['QUERY PLAN'][0];
    const text = await this.db.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`, params);
    const scan = findScan(plan.Plan);
    const walls: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await this.db.query(sql, params);
      walls.push(performance.now() - t0);
    }
    walls.sort((a, b) => a - b);
    return {
      sql,
      scan: scan['Node Type'],
      index: scan['Index Name'] ?? null,
      rows_read: (scan['Actual Rows'] ?? 0) * (scan['Actual Loops'] ?? 1),
      rows_returned: plan.Plan['Actual Rows'] ?? 0,
      execution_ms: Math.round(plan['Execution Time'] * 1000) / 1000,
      wall_ms_median: Math.round(walls[2] * 1000) / 1000,
      text: text.rows.map((r) => r['QUERY PLAN']).join('\n'),
    };
  }
}

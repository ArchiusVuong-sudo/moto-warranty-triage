import { Inject } from '@nestjs/common';
import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { Principal } from '../auth/principal.js';
import { ProblemException } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { SpansService, type SpanRow } from '../events/spans.service.js';
import { CursorCodec, CursorError, filterHash } from './cursor.js';
import type { ClaimStatus } from './dto.js';

export interface ClaimViewRow {
  claim_id: string;
  claim_number: string;
  dealer_id: number;
  dealer_name: string;
  vin: string;
  model: string;
  complaint: string;
  status: ClaimStatus;
  filed_at: Date;
  version: number;
  root_cause_code: string | null;
  confidence: number | null;
  warranty_decision: string | null;
  historical: boolean;
}

export function toClaimSummary(r: ClaimViewRow) {
  return {
    id: r.claim_id,
    claim_number: r.claim_number,
    dealer: { id: r.dealer_id, name: r.dealer_name },
    vin: r.vin,
    model: r.model,
    complaint: r.complaint,
    status: r.status,
    filed_at: new Date(r.filed_at).toISOString(),
    version: r.version,
    triage: r.root_cause_code ? { root_cause_code: r.root_cause_code, confidence: r.confidence, warranty_decision: r.warranty_decision } : null,
    historical: r.historical,
  };
}

/** Dealer keys only ever see their own dealer's claims. */
export function effectiveDealer(principal: Principal, requested?: number): number | undefined {
  return principal.dealerId ?? requested;
}

export class ListClaimsQuery {
  constructor(
    readonly principal: Principal,
    readonly limit: number,
    readonly cursor: string | undefined,
    readonly status: ClaimStatus | undefined,
    readonly dealerId: number | undefined,
  ) {}
}

export interface ClaimPage {
  data: ReturnType<typeof toClaimSummary>[];
  next_cursor: string | null;
  filters: Record<string, unknown>;
}

export interface KeysetInput {
  status?: string;
  dealerId?: number;
  after?: { filedAt: string; id: string };
  limit: number;
}

/** The v2 list query. Row-value comparison on (filed_at, claim_id) matches the index order, so Postgres seeks instead of skipping rows. */
export function buildKeysetQuery(input: KeysetInput): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (input.status) where.push(`status = ${add(input.status)}`);
  if (input.dealerId !== undefined) where.push(`dealer_id = ${add(input.dealerId)}`);
  if (input.after) where.push(`(filed_at, claim_id) < (${add(input.after.filedAt)}::timestamptz, ${add(input.after.id)}::uuid)`);
  const sql = `SELECT * FROM claim_view${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY filed_at DESC, claim_id DESC LIMIT ${add(input.limit)}`;
  return { sql, params };
}

/** Keyset pagination over the read model: an index range scan from the cursor, stable while new claims arrive. */
@QueryHandler(ListClaimsQuery)
export class ListClaimsHandler implements IQueryHandler<ListClaimsQuery, ClaimPage> {
  private readonly codec: CursorCodec;

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.codec = new CursorCodec(config.cursorSecret);
  }

  async execute(q: ListClaimsQuery): Promise<ClaimPage> {
    const dealer = effectiveDealer(q.principal, q.dealerId);
    const filters = { status: q.status, dealer_id: dealer };
    const fh = filterHash(filters);
    let after: KeysetInput['after'];
    if (q.cursor) {
      try {
        after = this.codec.decode(q.cursor, fh);
      } catch (e) {
        if (e instanceof CursorError) throw new ProblemException(400, 'invalid-cursor', 'Invalid cursor', e.message);
        throw e;
      }
    }
    const { sql, params } = buildKeysetQuery({ status: q.status, dealerId: dealer, after, limit: q.limit + 1 });
    const { rows } = await this.db.query<ClaimViewRow>(sql, params);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const next = rows.length > q.limit && last ? this.codec.encode({ filedAt: new Date(last.filed_at).toISOString(), id: last.claim_id }, fh) : null;
    return { data: page.map(toClaimSummary), next_cursor: next, filters };
  }
}

export class ListClaimsV1Query {
  constructor(
    readonly principal: Principal,
    readonly page: number,
    readonly perPage: number,
  ) {}
}

/** v1 kept for old dealer tools: OFFSET pages and the old field names. */
@QueryHandler(ListClaimsV1Query)
export class ListClaimsV1Handler implements IQueryHandler<ListClaimsV1Query> {
  constructor(private readonly db: DbService) {}

  async execute(q: ListClaimsV1Query) {
    const dealer = q.principal.dealerId;
    const where = dealer !== null ? 'WHERE dealer_id = $3' : '';
    const params: unknown[] = [q.perPage, (q.page - 1) * q.perPage];
    if (dealer !== null) params.push(dealer);
    const { rows } = await this.db.query<ClaimViewRow>(
      `SELECT * FROM claim_view ${where} ORDER BY filed_at DESC, claim_id DESC LIMIT $1 OFFSET $2`,
      params,
    );
    const total = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM claim_view ${dealer !== null ? 'WHERE dealer_id = $1' : ''}`, dealer !== null ? [dealer] : []);
    return {
      claims: rows.map((r) => ({
        claimNo: r.claim_number,
        uuid: r.claim_id,
        dealerName: r.dealer_name,
        bike: r.model,
        state: r.status.toUpperCase(),
        filedOn: new Date(r.filed_at).toISOString().slice(0, 10),
      })),
      page: q.page,
      perPage: q.perPage,
      totalCount: total.rows[0].n,
    };
  }
}

export class GetClaimQuery {
  constructor(
    readonly principal: Principal,
    readonly claimId: string,
  ) {}
}

export interface ClaimDetail {
  claim: ReturnType<typeof toClaimSummary>;
  odometer_km: number;
  trace_id: string;
  vehicle: { sale_date: string; firmware: string | null };
  triage: { result: unknown; run: unknown; created_at: Date } | null;
  decision: { decision: string; final: unknown; edits: unknown; note: string | null; decided_by: string; decided_at: Date } | null;
  job: { id: string; status: string; attempts: number; max_attempts: number; last_error: string | null; dead_reason: string | null; next_run_at: Date } | null;
  attempts: { n: number; started_at: Date; ended_at: Date | null; outcome: string | null; error: string | null; served_from_store: boolean | null }[];
}

@QueryHandler(GetClaimQuery)
export class GetClaimHandler implements IQueryHandler<GetClaimQuery, ClaimDetail> {
  constructor(private readonly db: DbService) {}

  async execute(q: GetClaimQuery): Promise<ClaimDetail> {
    if (!/^[0-9a-f-]{36}$/i.test(q.claimId)) throw new ProblemException(404, 'not-found', 'Claim not found', `No claim ${q.claimId}.`);
    const { rows } = await this.db.query<ClaimViewRow & { odometer_km: number; trace_id: string; sale_date: string; firmware: string | null }>(
      `SELECT v.*, c.odometer_km, c.trace_id, ve.sale_date::text AS sale_date, r.ride_log ->> 'firmware' AS firmware
       FROM claim_view v JOIN claims c ON c.id = v.claim_id JOIN vehicles ve ON ve.vin = c.vin LEFT JOIN ride_logs r ON r.claim_id = c.id
       WHERE v.claim_id = $1`,
      [q.claimId],
    );
    const row = rows[0];
    // Another dealer's claim is a 404, not a 403: do not confirm it exists.
    if (!row || (q.principal.dealerId !== null && row.dealer_id !== q.principal.dealerId)) {
      throw new ProblemException(404, 'not-found', 'Claim not found', `No claim ${q.claimId}.`);
    }
    const [tr, td, job] = await Promise.all([
      this.db.query<ClaimDetail['triage'] & object>('SELECT result, run, created_at FROM triage_results WHERE claim_id = $1', [q.claimId]),
      this.db.query<NonNullable<ClaimDetail['decision']>>('SELECT decision, final, edits, note, decided_by, decided_at FROM triage_decisions WHERE claim_id = $1', [q.claimId]),
      this.db.query<NonNullable<ClaimDetail['job']>>(
        'SELECT id, status, attempts, max_attempts, last_error, dead_reason, next_run_at FROM jobs WHERE claim_id = $1 ORDER BY created_at DESC LIMIT 1',
        [q.claimId],
      ),
    ]);
    const attempts = job.rows[0]
      ? (await this.db.query<ClaimDetail['attempts'][number]>('SELECT n, started_at, ended_at, outcome, error, served_from_store FROM job_attempts WHERE job_id = $1 ORDER BY n', [job.rows[0].id])).rows
      : [];
    return {
      claim: toClaimSummary(row),
      odometer_km: row.odometer_km,
      trace_id: row.trace_id,
      vehicle: { sale_date: row.sale_date, firmware: row.firmware },
      triage: tr.rows[0] ?? null,
      decision: td.rows[0] ?? null,
      job: job.rows[0] ?? null,
      attempts,
    };
  }
}

export class GetTimelineQuery {
  constructor(
    readonly principal: Principal,
    readonly claimId: string,
  ) {}
}

@QueryHandler(GetTimelineQuery)
export class GetTimelineHandler implements IQueryHandler<GetTimelineQuery, { trace_id: string | null; spans: SpanRow[] }> {
  constructor(
    private readonly db: DbService,
    private readonly spans: SpansService,
  ) {}

  async execute(q: GetTimelineQuery) {
    const { rows } = await this.db.query<{ trace_id: string; dealer_id: number }>('SELECT trace_id, dealer_id FROM claims WHERE id = $1', [q.claimId]);
    if (!rows[0] || (q.principal.dealerId !== null && rows[0].dealer_id !== q.principal.dealerId)) {
      throw new ProblemException(404, 'not-found', 'Claim not found', `No claim ${q.claimId}.`);
    }
    return { trace_id: rows[0].trace_id, spans: await this.spans.forClaim(q.claimId) };
  }
}

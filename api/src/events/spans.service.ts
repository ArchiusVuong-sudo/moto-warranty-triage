import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '../db/db.service.js';
import { LiveEvents } from '../stream/live-events.js';

export type SpanKind = 'event' | 'job' | 'attempt' | 'tool' | 'note' | 'breaker' | 'dedup' | 'drill' | 'decision';

export interface SpanInput {
  claimId: string;
  traceId: string;
  kind: SpanKind;
  name: string;
  attempt?: number | null;
  status?: 'ok' | 'error' | 'info';
  durationMs?: number | null;
  startedAt?: string;
  attrs?: Record<string, unknown>;
}

export interface SpanRow {
  id: number;
  claim_id: string;
  trace_id: string;
  kind: SpanKind;
  name: string;
  started_at: Date;
  duration_ms: number | null;
  attempt: number | null;
  status: string;
  attrs: Record<string, unknown>;
}

/** The claim timeline: every step under the claim's trace id. */
@Injectable()
export class SpansService {
  constructor(
    private readonly db: DbService,
    private readonly live: LiveEvents,
  ) {}

  /** Insert inside a caller's transaction; publish the returned rows after commit. */
  async add(q: Queryable, s: SpanInput): Promise<SpanRow> {
    const { rows } = await q.query<SpanRow>(
      `INSERT INTO spans (claim_id, trace_id, kind, name, attempt, status, duration_ms, started_at, attrs)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), $9) RETURNING *`,
      [s.claimId, s.traceId, s.kind, s.name, s.attempt ?? null, s.status ?? 'ok', s.durationMs ?? null, s.startedAt ?? null, JSON.stringify(s.attrs ?? {})],
    );
    return rows[0];
  }

  publish(...rows: SpanRow[]): void {
    for (const r of rows) this.live.publish({ type: 'span', data: r as unknown as Record<string, unknown> });
  }

  async addNow(s: SpanInput): Promise<SpanRow> {
    const row = await this.add(this.db, s);
    this.publish(row);
    return row;
  }

  async forClaim(claimId: string): Promise<SpanRow[]> {
    const { rows } = await this.db.query<SpanRow>('SELECT * FROM spans WHERE claim_id = $1 ORDER BY id', [claimId]);
    return rows;
  }
}

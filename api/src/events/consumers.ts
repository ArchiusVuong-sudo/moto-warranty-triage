import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { Queryable } from '../db/db.service.js';
import { appendEvent, type DomainEvent, type EventType } from './outbox.js';
import type { SpanInput } from './spans.service.js';

export interface ConsumerResult {
  spans: SpanInput[];
  claimChanged: boolean;
}

export interface EventConsumer {
  readonly name: string;
  handles(type: EventType): boolean;
  /** Runs in the relay's transaction, after the inbox check passed. */
  apply(tx: Queryable, event: DomainEvent): Promise<ConsumerResult>;
}

export const CLAIM_VIEW_UPSERT = `
  INSERT INTO claim_view (claim_id, claim_number, dealer_id, dealer_name, vin, model, complaint, status, filed_at, version,
                          root_cause_code, confidence, warranty_decision, historical, updated_at)
  SELECT c.id, c.claim_number, c.dealer_id, d.name, c.vin, v.model, c.complaint, c.status, c.filed_at, c.version,
         COALESCE(td.final, tr.result) -> 'root_cause' ->> 'code',
         (COALESCE(td.final, tr.result) -> 'root_cause' ->> 'confidence')::float8,
         COALESCE(td.final, tr.result) -> 'warranty' ->> 'decision',
         false, now()
  FROM claims c
  JOIN dealers d ON d.id = c.dealer_id
  JOIN vehicles v ON v.vin = c.vin
  LEFT JOIN triage_results tr ON tr.claim_id = c.id
  LEFT JOIN triage_decisions td ON td.claim_id = c.id
  WHERE c.id = $1
  ON CONFLICT (claim_id) DO UPDATE SET
    status = EXCLUDED.status, version = EXCLUDED.version, root_cause_code = EXCLUDED.root_cause_code,
    confidence = EXCLUDED.confidence, warranty_decision = EXCLUDED.warranty_decision, updated_at = now()`;

/** CQRS projector: keeps claim_view (the query side) in step with the write model. */
@Injectable()
export class ClaimProjector implements EventConsumer {
  readonly name = 'projector';

  handles(): boolean {
    return true;
  }

  async apply(tx: Queryable, event: DomainEvent): Promise<ConsumerResult> {
    await tx.query(CLAIM_VIEW_UPSERT, [event.aggregate_id]);
    return { spans: [], claimChanged: true };
  }
}

/** On ClaimFiled, queue one triage job. The job's Idempotency-Key is fixed here and reused by every attempt. */
@Injectable()
export class TriageEnqueuer implements EventConsumer {
  readonly name = 'job-enqueuer';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  handles(type: EventType): boolean {
    return type === 'ClaimFiled';
  }

  async apply(tx: Queryable, event: DomainEvent): Promise<ConsumerResult> {
    const jobId = randomUUID();
    await tx.query(
      `INSERT INTO jobs (id, claim_id, kind, status, max_attempts, idempotency_key, trace_id)
       VALUES ($1, $2, 'triage', 'queued', $3, $4, $5)`,
      [jobId, event.aggregate_id, this.config.dispatcher.maxAttempts, `triage-${event.aggregate_id}`, event.trace_id],
    );
    await tx.query(`UPDATE claims SET status = 'triaging', version = version + 1 WHERE id = $1 AND status = 'filed'`, [event.aggregate_id]);
    await appendEvent(tx, { aggregateId: event.aggregate_id, type: 'TriageQueued', payload: { job_id: jobId }, traceId: event.trace_id });
    return {
      claimChanged: true,
      spans: [
        {
          claimId: event.aggregate_id,
          traceId: event.trace_id,
          kind: 'job',
          name: 'Triage job queued',
          attrs: { job_id: jobId, idempotency_key: `triage-${event.aggregate_id}`, max_attempts: this.config.dispatcher.maxAttempts },
        },
      ],
    };
  }
}

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/db.service.js';

export type EventType = 'ClaimFiled' | 'TriageQueued' | 'TriageCompleted' | 'TriageDeadLettered' | 'TriageApproved' | 'TriageRejected';

export interface DomainEvent {
  seq: number;
  id: string;
  aggregate_id: string;
  type: EventType;
  payload: Record<string, unknown>;
  trace_id: string;
  created_at: Date;
}

/** Write an event in the caller's transaction. It commits with the state change or not at all; the relay publishes it later. */
export async function appendEvent(
  tx: Queryable,
  e: { aggregateId: string; type: EventType; payload: Record<string, unknown>; traceId: string },
): Promise<DomainEvent> {
  const { rows } = await tx.query<DomainEvent>(
    'INSERT INTO events (id, aggregate_id, type, payload, trace_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [randomUUID(), e.aggregateId, e.type, JSON.stringify(e.payload), e.traceId],
  );
  return rows[0];
}

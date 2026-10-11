import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '../auth/principal.js';
import { ProblemException } from '../common/problem.js';
import { newTraceId } from '../common/trace.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { appendEvent } from '../events/outbox.js';
import { OutboxRelay } from '../events/relay.service.js';
import { SpansService, type SpanRow } from '../events/spans.service.js';
import type { TriageResult } from '../jobs/contract.js';
import type { FileClaimDto, TriageDecisionDto } from './dto.js';

export function canonicalHash(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return createHash('sha256').update(JSON.stringify(sort(value))).digest('hex');
}

export class FileClaimCommand {
  constructor(
    readonly principal: Principal,
    readonly idempotencyKey: string,
    readonly body: FileClaimDto,
  ) {}
}

export interface FileClaimResult {
  status: number;
  body: Record<string, unknown>;
  replayed: boolean;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Files a claim. The claim, its ride log, the ClaimFiled event and the
 * idempotency record commit in one transaction, so a retry with the same
 * Idempotency-Key and body gets the first answer back and never a second claim.
 */
@CommandHandler(FileClaimCommand)
export class FileClaimHandler implements ICommandHandler<FileClaimCommand, FileClaimResult> {
  constructor(
    private readonly db: DbService,
    private readonly spans: SpansService,
    private readonly relay: OutboxRelay,
  ) {}

  async execute(cmd: FileClaimCommand): Promise<FileClaimResult> {
    const hash = canonicalHash(cmd.body);
    try {
      return await this.fileOnce(cmd, hash);
    } catch (e) {
      // On a server Postgres two concurrent first requests race on the primary key; the loser replays the winner.
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) return await this.fileOnce(cmd, hash);
      throw e;
    }
  }

  private async fileOnce(cmd: FileClaimCommand, hash: string): Promise<FileClaimResult> {
    const { principal, idempotencyKey, body } = cmd;
    let published: SpanRow[] = [];
    const result = await this.db.transaction(async (tx) => {
      const prior = await tx.query<{ request_hash: string; status_code: number; response_body: Record<string, unknown> }>(
        'SELECT request_hash, status_code, response_body FROM idempotency_records WHERE api_key_id = $1 AND idem_key = $2',
        [principal.keyId, idempotencyKey],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== hash) {
          throw new ProblemException(422, 'idempotency-key-reused', 'Idempotency-Key reused', 'This Idempotency-Key was already used with a different request body.');
        }
        return { status: prior.rows[0].status_code, body: prior.rows[0].response_body, replayed: true };
      }
      const vehicle = await tx.query<{ vin: string; dealer_id: number }>('SELECT vin, dealer_id FROM vehicles WHERE vin = $1', [body.vin]);
      if (!vehicle.rows[0]) throw new ProblemException(422, 'unknown-vehicle', 'Unknown vehicle', `No vehicle with VIN ${body.vin}.`);
      if (body.ride_log.vin !== body.vin) throw new ProblemException(422, 'vin-mismatch', 'VIN mismatch', 'The ride log belongs to another VIN.');
      const dealerId = principal.dealerId;
      if (dealerId === null) throw new ProblemException(403, 'dealer-only', 'Dealer key required', 'Only dealer keys file claims.');

      const id = randomUUID();
      const traceId = newTraceId();
      const { rows } = await tx.query<{ claim_number: string; filed_at: Date }>(
        `INSERT INTO claims (id, claim_number, dealer_id, vin, complaint, odometer_km, status, filed_at, trace_id, created_by)
         VALUES ($1, 'WC-' || lpad(nextval('claim_number_seq')::text, 6, '0'), $2, $3, $4, $5, 'filed', date_trunc('milliseconds', now()), $6, $7)
         RETURNING claim_number, filed_at`,
        [id, dealerId, body.vin, body.complaint, body.odometer_km, traceId, principal.keyId],
      );
      await tx.query('INSERT INTO ride_logs (claim_id, ride_log, rows) VALUES ($1, $2, $3)', [id, JSON.stringify(body.ride_log), body.ride_log.rows.length]);
      const event = await appendEvent(tx, { aggregateId: id, type: 'ClaimFiled', payload: { claim_number: rows[0].claim_number, vin: body.vin, dealer_id: dealerId }, traceId });
      published = [
        await this.spans.add(tx, {
          claimId: id,
          traceId,
          kind: 'event',
          name: 'ClaimFiled',
          attrs: { event_id: event.id, idempotency_key: idempotencyKey, api_key: principal.keyId, ride_log_rows: body.ride_log.rows.length },
        }),
      ];
      const response = {
        id,
        claim_number: rows[0].claim_number,
        status: 'filed',
        filed_at: rows[0].filed_at.toISOString(),
        trace_id: traceId,
        links: { self: `/v2/claims/${id}`, timeline: `/v2/claims/${id}/timeline` },
      };
      await tx.query(
        'INSERT INTO idempotency_records (api_key_id, idem_key, request_hash, status_code, response_body, claim_id) VALUES ($1, $2, $3, 201, $4, $5)',
        [principal.keyId, idempotencyKey, hash, JSON.stringify(response), id],
      );
      return { status: 201, body: response, replayed: false };
    });
    this.spans.publish(...published);
    if (!result.replayed) this.relay.nudge();
    return result;
  }
}

export class DecideTriageCommand {
  constructor(
    readonly principal: Principal,
    readonly claimId: string,
    readonly ifMatch: string | undefined,
    readonly body: TriageDecisionDto,
  ) {}
}

export interface FieldEdit {
  field: string;
  from: unknown;
  to: unknown;
}

/** Applies an engineer's repair edits to the suggestion and lists what changed. */
export function applyEdits(suggested: TriageResult, body: TriageDecisionDto): { final: TriageResult; edits: FieldEdit[] } {
  const final: TriageResult = structuredClone(suggested);
  const edits: FieldEdit[] = [];
  if (body.repair?.labour_hours !== undefined && body.repair.labour_hours !== suggested.repair.labour_hours) {
    edits.push({ field: 'repair.labour_hours', from: suggested.repair.labour_hours, to: body.repair.labour_hours });
    final.repair.labour_hours = body.repair.labour_hours;
  }
  if (body.repair?.parts && canonicalHash(body.repair.parts) !== canonicalHash(suggested.repair.parts)) {
    edits.push({ field: 'repair.parts', from: suggested.repair.parts, to: body.repair.parts });
    final.repair.parts = body.repair.parts.map((p) => ({ part_number: p.part_number, description: p.description, qty: p.qty }));
  }
  return { final, edits };
}

export function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  return m ? Number(m[1]) : NaN;
}

/** Engineer sign-off. Optimistic concurrency via If-Match on the claim version; the decision is an event next to the suggestion. */
@CommandHandler(DecideTriageCommand)
export class DecideTriageHandler implements ICommandHandler<DecideTriageCommand, { version: number; status: string; edits: FieldEdit[] }> {
  constructor(
    private readonly db: DbService,
    private readonly spans: SpansService,
    private readonly relay: OutboxRelay,
  ) {}

  async execute(cmd: DecideTriageCommand): Promise<{ version: number; status: string; edits: FieldEdit[] }> {
    const expected = parseIfMatch(cmd.ifMatch);
    if (expected === null) throw new ProblemException(428, 'precondition-required', 'If-Match required', 'Send If-Match with the ETag from GET /v2/claims/{id}.');
    if (Number.isNaN(expected)) throw new ProblemException(400, 'bad-if-match', 'Malformed If-Match', 'Use the ETag value, for example "4".');
    let published: SpanRow[] = [];
    const out = await this.db.transaction(async (tx: Queryable) => {
      const { rows } = await tx.query<{ id: string; version: number; status: string; trace_id: string }>(
        'SELECT id, version, status, trace_id FROM claims WHERE id = $1 FOR UPDATE',
        [cmd.claimId],
      );
      const claim = rows[0];
      if (!claim) throw new ProblemException(404, 'not-found', 'Claim not found', `No claim ${cmd.claimId}.`);
      if (claim.version !== expected) {
        throw new ProblemException(412, 'stale-version', 'Claim changed', `Claim is at version ${claim.version}, request was for ${expected}. Reload and retry.`, { current_version: claim.version }, { ETag: `"${claim.version}"` });
      }
      if (claim.status !== 'awaiting_review') throw new ProblemException(409, 'not-awaiting-review', 'Not awaiting review', `Claim status is ${claim.status}.`);
      const tr = await tx.query<{ result: TriageResult }>('SELECT result FROM triage_results WHERE claim_id = $1', [cmd.claimId]);
      if (!tr.rows[0]) throw new ProblemException(409, 'no-triage-result', 'No triage result', 'This claim has no triage result to review.');
      const suggested = tr.rows[0].result;
      const approve = cmd.body.action === 'approve';
      const { final, edits } = approve ? applyEdits(suggested, cmd.body) : { final: null, edits: [] as FieldEdit[] };
      const status = approve ? 'approved' : 'rejected';
      await tx.query(
        'INSERT INTO triage_decisions (claim_id, decision, suggested, final, edits, note, decided_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [cmd.claimId, status, JSON.stringify(suggested), final ? JSON.stringify(final) : null, JSON.stringify(edits), cmd.body.note ?? null, cmd.principal.keyId],
      );
      const upd = await tx.query<{ version: number }>('UPDATE claims SET status = $2, version = version + 1 WHERE id = $1 RETURNING version', [cmd.claimId, status]);
      const type = approve ? 'TriageApproved' : 'TriageRejected';
      const event = await appendEvent(tx, { aggregateId: cmd.claimId, type, payload: { edits, note: cmd.body.note ?? null, decided_by: cmd.principal.keyId }, traceId: claim.trace_id });
      published = [
        await this.spans.add(tx, {
          claimId: cmd.claimId,
          traceId: claim.trace_id,
          kind: 'decision',
          name: edits.length ? `${type} with ${edits.length} edit${edits.length > 1 ? 's' : ''}` : type,
          attrs: { event_id: event.id, edits, note: cmd.body.note ?? null, decided_by: cmd.principal.label },
        }),
      ];
      return { version: upd.rows[0].version, status, edits };
    });
    this.spans.publish(...published);
    this.relay.nudge();
    return out;
  }
}

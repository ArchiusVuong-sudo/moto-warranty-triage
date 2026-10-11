import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService, type Queryable } from '../db/db.service.js';
import { LiveEvents } from '../stream/live-events.js';
import { ClaimProjector, TriageEnqueuer, type EventConsumer } from './consumers.js';
import type { DomainEvent } from './outbox.js';
import { SpansService, type SpanRow } from './spans.service.js';

export interface DeliveryReport {
  event: DomainEvent;
  consumers: { name: string; outcome: 'applied' | 'duplicate' | 'skipped' }[];
}

/**
 * Outbox relay. Reads unpublished events in commit order and hands each to every
 * consumer. Delivery is at least once; each consumer dedupes by event id in
 * processed_events, inside the same transaction as its own writes.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('OutboxRelay');
  private readonly consumers: EventConsumer[];
  private timer?: NodeJS.Timeout;
  private running = false;
  private again = false;
  private stopped = false;

  constructor(
    private readonly db: DbService,
    private readonly spans: SpansService,
    private readonly live: LiveEvents,
    projector: ClaimProjector,
    enqueuer: TriageEnqueuer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.consumers = [projector, enqueuer];
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.nudge(), this.config.relayPollMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Ask for a pass now (called after commits). Passes never overlap. */
  nudge(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.drain()
      .catch((e: unknown) => this.log.error(`relay pass failed: ${String(e)}`))
      .finally(() => {
        this.running = false;
        if (this.again) {
          this.again = false;
          this.nudge();
        }
      });
  }

  /** Publish every pending event. Resolves when the outbox is empty. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const { rows } = await this.db.query<DomainEvent>('SELECT * FROM events WHERE published_at IS NULL ORDER BY seq LIMIT 50');
      if (!rows.length) return total;
      for (const e of rows) {
        await this.deliver(e);
        await this.db.query('UPDATE events SET published_at = now() WHERE seq = $1', [e.seq]);
        total++;
      }
    }
  }

  /** Deliver one event to every consumer. Used by the relay and by the redelivery drill. */
  async deliver(event: DomainEvent): Promise<DeliveryReport> {
    const report: DeliveryReport = { event, consumers: [] };
    for (const c of this.consumers) {
      if (!c.handles(event.type)) {
        report.consumers.push({ name: c.name, outcome: 'skipped' });
        continue;
      }
      const { rows, changed } = await this.db.transaction(async (tx) => {
        const fresh = await claimInbox(tx, c.name, event.id);
        const out: SpanRow[] = [];
        if (!fresh) {
          out.push(
            await this.spans.add(tx, {
              claimId: event.aggregate_id,
              traceId: event.trace_id,
              kind: 'dedup',
              name: `Duplicate ${event.type} ignored by ${c.name}`,
              status: 'info',
              attrs: { event_id: event.id, consumer: c.name },
            }),
          );
          return { rows: out, changed: false, dup: true };
        }
        const result = await c.apply(tx, event);
        for (const s of result.spans) out.push(await this.spans.add(tx, s));
        return { rows: out, changed: result.claimChanged, dup: false };
      }).then((r) => {
        report.consumers.push({ name: c.name, outcome: r.dup ? 'duplicate' : 'applied' });
        return r;
      });
      this.spans.publish(...rows);
      if (changed) await this.publishClaim(event.aggregate_id);
    }
    return report;
  }

  private async publishClaim(claimId: string): Promise<void> {
    const { rows } = await this.db.query('SELECT * FROM claim_view WHERE claim_id = $1', [claimId]);
    if (rows[0]) this.live.publish({ type: 'claim', data: rows[0] });
  }
}

/** Inbox dedup: true the first time this consumer sees the event id. */
export async function claimInbox(tx: Queryable, consumer: string, eventId: string): Promise<boolean> {
  const { rows } = await tx.query(
    'INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
    [consumer, eventId],
  );
  return rows.length === 1;
}

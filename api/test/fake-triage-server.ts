import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

export type Behavior = 'ok' | 'from-store' | '500' | '422' | 'break' | 'invalid-result' | 'error-retryable' | 'no-result';

export const VALID_RESULT = JSON.parse(readFileSync(join(loadConfig({}).repoRoot, 'fixtures', 'cell-imbalance.json'), 'utf8')).result as Record<string, unknown>;

export interface SeenRequest {
  idempotencyKey: string | undefined;
  traceparent: string | undefined;
  body: Record<string, unknown>;
}

/** Stand-in for the Python service: speaks the same NDJSON protocol and fails on cue. */
export class FakeTriageServer {
  private server?: Server;
  readonly seen: SeenRequest[] = [];
  queue: Behavior[] = [];
  healthy = true;
  url = '';

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/health') {
      res.writeHead(this.healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'replay', model: null, boot_id: 'fake', in_flight: 0, model_runs: { live_today: 0, today: 0, total: 0 } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    this.seen.push({ idempotencyKey: req.headers['idempotency-key'] as string | undefined, traceparent: req.headers.traceparent as string | undefined, body: JSON.parse(raw) });
    const behavior = this.queue.shift() ?? 'ok';
    const line = (o: unknown) => res.write(JSON.stringify(o) + '\n');
    if (behavior === '500' || behavior === '422') {
      const status = Number(behavior);
      res.writeHead(status, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ title: status === 422 ? 'Ride log failed validation' : 'Boom', detail: 'scripted', status }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const fromStore = behavior === 'from-store';
    line({ type: 'accepted', served_from_store: fromStore, mode: 'replay', idempotency_key: req.headers['idempotency-key'], trace_id: null });
    line({ type: 'span', span: { name: 'analyze_telemetry', input: {}, output: { samples: 600, events: [] }, ok: true, started_at: new Date().toISOString(), duration_ms: 1.2, seq: 1, from_store: fromStore } });
    if (behavior === 'break') {
      res.socket?.destroy();
      return;
    }
    line({ type: 'span', span: { name: 'check_warranty', input: { cause_code: 'BATTERY_CELL_IMBALANCE', confidence: 0.9 }, output: { decision: 'covered', clause: 'W2' }, ok: true, started_at: new Date().toISOString(), duration_ms: 0.4, seq: 2 } });
    if (behavior === 'no-result') return void res.end();
    if (behavior === 'error-retryable') {
      line({ type: 'error', code: 'model_unavailable', message: 'overloaded', retryable: true });
      return void res.end();
    }
    const result = behavior === 'invalid-result' ? { ...VALID_RESULT, warranty: { decision: 'maybe', clause: 'W9', reason: 'x' } } : VALID_RESULT;
    line({ type: 'result', result, run: { mode: 'replay', model_runs: fromStore ? 0 : 1, served_from_store: fromStore, duration_ms: 10, cost_usd: 0.01 } });
    res.end();
  }
}

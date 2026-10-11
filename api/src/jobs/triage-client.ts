import type { TriageContract, TriageResult } from './contract.js';

export type StreamLine =
  | { type: 'accepted'; served_from_store: boolean; mode: string; idempotency_key: string; trace_id: string | null }
  | { type: 'span'; span: ToolSpan }
  | { type: 'note'; message: string }
  | { type: 'result'; result: unknown; run: RunMeta }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface ToolSpan {
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  ok: boolean;
  started_at: string;
  duration_ms: number;
  seq: number;
  replayed?: boolean;
  from_store?: boolean;
}

export interface RunMeta {
  mode: 'live' | 'replay';
  model?: string;
  duration_ms?: number;
  cost_usd?: number;
  num_turns?: number;
  input_tokens?: number;
  output_tokens?: number;
  model_runs: number;
  served_from_store: boolean;
  guardrails?: string[];
  source?: Record<string, unknown>;
  [k: string]: unknown;
}

export type AttemptOutcome =
  | { kind: 'success'; result: TriageResult; run: RunMeta; servedFromStore: boolean }
  | { kind: 'retryable'; reason: string; httpStatus?: number }
  | { kind: 'permanent'; reason: string; httpStatus?: number };

export interface TriageServiceHealth {
  status: string;
  mode: 'live' | 'replay';
  model: string | null;
  boot_id: string;
  in_flight: number;
  model_runs: { live_today: number; today: number; total: number };
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function describe(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'attempt timed out';
  const code = err?.cause?.code;
  if (code === 'ECONNREFUSED') return 'connection refused (service down)';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'connection reset mid-stream';
  return [err?.message, err?.cause?.message].filter(Boolean).join(': ') || String(e);
}

/** NDJSON client for the Python triage service. It classifies every failure as retryable or permanent. */
export class TriageClient {
  constructor(private readonly contract: TriageContract) {}

  async run(
    baseUrl: string,
    body: unknown,
    headers: { idempotencyKey: string; traceparent: string },
    onLine: (line: StreamLine) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<AttemptOutcome> {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/triage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': headers.idempotencyKey, traceparent: headers.traceparent },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      return { kind: 'retryable', reason: describe(e) };
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const p = (await res.json()) as { title?: string; detail?: string };
        detail = [p.title, p.detail].filter(Boolean).join(': ');
      } catch {
        /* body was not JSON */
      }
      const reason = `triage service answered ${res.status}: ${detail}`.slice(0, 400);
      return RETRYABLE_STATUS.has(res.status) ? { kind: 'retryable', reason, httpStatus: res.status } : { kind: 'permanent', reason, httpStatus: res.status };
    }
    if (!res.body) return { kind: 'retryable', reason: 'empty response body' };

    let servedFromStore = false;
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!raw) continue;
          let line: StreamLine;
          try {
            line = JSON.parse(raw) as StreamLine;
          } catch {
            return { kind: 'retryable', reason: 'malformed stream line' };
          }
          if (line.type === 'accepted') servedFromStore = line.served_from_store;
          await onLine(line);
          if (line.type === 'result') {
            const errors = this.contract.errors(line.result);
            if (errors.length) return { kind: 'permanent', reason: `result broke the contract: ${errors.join('; ')}` };
            return { kind: 'success', result: line.result as TriageResult, run: line.run, servedFromStore };
          }
          if (line.type === 'error') {
            const reason = `${line.code}: ${line.message}`;
            return line.retryable ? { kind: 'retryable', reason } : { kind: 'permanent', reason };
          }
        }
      }
    } catch (e) {
      return { kind: 'retryable', reason: `stream broken: ${describe(e)}` };
    }
    return { kind: 'retryable', reason: 'stream ended before a result (reply lost)' };
  }

  async health(baseUrl: string, timeoutMs = 1500): Promise<TriageServiceHealth | null> {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? ((await res.json()) as TriageServiceHealth) : null;
    } catch {
      return null;
    }
  }

  async armLoseNextReply(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/admin/drills/lose-next-reply`, { method: 'POST', signal: AbortSignal.timeout(2000) });
      return res.ok && ((await res.json()) as { armed: boolean }).armed;
    } catch {
      return false;
    }
  }
}

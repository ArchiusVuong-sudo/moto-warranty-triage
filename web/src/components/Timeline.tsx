import { AlertTriangle, CheckCircle2, CircleDot, Copy, FlaskConical, Gavel, Hammer, PlayCircle, RotateCcw, ShieldAlert, Sparkles, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Span, SpanKind } from '../types';
import { fmtMs } from '../format';
import { cx } from './ui';

const ICON: Record<SpanKind, ReactNode> = {
  event: <CircleDot size={14} />,
  job: <Hammer size={14} />,
  attempt: <PlayCircle size={14} />,
  tool: <Wrench size={14} />,
  note: <Sparkles size={14} />,
  breaker: <ShieldAlert size={14} />,
  dedup: <Copy size={14} />,
  drill: <FlaskConical size={14} />,
  decision: <Gavel size={14} />,
};

function iconFor(s: Span): ReactNode {
  if (s.kind === 'attempt' && s.status === 'error') return <RotateCcw size={14} />;
  if (s.kind === 'attempt' && s.name.endsWith('succeeded')) return <CheckCircle2 size={14} />;
  if (s.kind === 'job' && s.status === 'error') return <AlertTriangle size={14} />;
  return ICON[s.kind];
}

function tone(s: Span): string {
  if (s.status === 'error') return 'text-rose-600 bg-rose-50 ring-rose-200';
  if (s.kind === 'tool') return 'text-indigo-600 bg-indigo-50 ring-indigo-200';
  if (s.kind === 'decision' || (s.kind === 'attempt' && s.name.endsWith('succeeded'))) return 'text-emerald-600 bg-emerald-50 ring-emerald-200';
  if (s.kind === 'drill' || s.kind === 'dedup') return 'text-amber-700 bg-amber-50 ring-amber-200';
  return 'text-slate-500 bg-slate-50 ring-slate-200';
}

function inputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const entries = Object.entries(input as Record<string, unknown>);
  if (!entries.length) return 'whole ride';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

function outputSummary(name: string, output: Record<string, unknown> | undefined): string {
  if (!output) return '';
  if (output.error) return String(output.error);
  if (name === 'analyze_telemetry') {
    const ev = (output.events as { kind: string; window: string }[] | undefined) ?? [];
    const kinds = [...new Set(ev.map((e) => e.kind.replaceAll('_', ' ')))];
    return `${output.samples} samples, ${ev.length} events${kinds.length ? `: ${kinds.slice(0, 3).join(', ')}` : ''}`;
  }
  if (name === 'lookup_fault_code') return output.found ? `${output.title}` : 'unknown code';
  if (name === 'search_service_bulletins') return ((output.results as { id: string }[]) ?? []).map((r) => r.id).join(', ') || 'no match';
  if (name === 'check_warranty') return `${output.decision} under ${output.clause}`;
  return '';
}

function SpanRow({ s, t0 }: { s: Span; t0: number }) {
  const [open, setOpen] = useState(false);
  const offset = (new Date(s.started_at).getTime() - t0) / 1000;
  const isTool = s.kind === 'tool';
  const attrs = s.attrs ?? {};
  return (
    <li className="animate-slide-in relative pl-8" data-testid="timeline-span" data-kind={s.kind}>
      <span className={cx('absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full ring-1', tone(s))}>{iconFor(s)}</span>
      <div className="flex items-start justify-between gap-3">
        <button className={cx('min-w-0 text-left', isTool && 'cursor-pointer')} onClick={() => isTool && setOpen(!open)}>
          <div className="text-[13px] leading-snug text-slate-800">
            {isTool ? <span className="font-mono text-[12.5px] font-medium text-indigo-700">{s.name}</span> : s.name}
            {isTool && Boolean(attrs.replayed) && <span className="ml-1.5 rounded bg-violet-50 px-1 text-[10px] font-medium text-violet-700">replay</span>}
          </div>
          {isTool && (
            <div className="mt-0.5 truncate text-[11.5px] text-slate-500">
              <span className="text-slate-400">{inputSummary(attrs.input)}</span>
              {' -> '}
              {outputSummary(s.name, attrs.output as Record<string, unknown>)}
            </div>
          )}
          {s.kind === 'attempt' && typeof attrs.retry_in_ms === 'number' && (
            <div className="mt-0.5 text-[11.5px] text-slate-500">
              Retry in {fmtMs(attrs.retry_in_ms as number)} ({String(attrs.backoff)}), {String(attrs.attempts_left)} attempts left
            </div>
          )}
          {s.kind === 'breaker' && <div className="mt-0.5 text-[11.5px] text-slate-500">{String(attrs.reason ?? '')}</div>}
          {s.kind === 'decision' && Array.isArray(attrs.edits) && attrs.edits.length > 0 && (
            <div className="mt-0.5 text-[11.5px] text-slate-500">
              {(attrs.edits as { field: string; from: unknown; to: unknown }[]).map((e) => `${e.field}: ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`).join('; ')}
            </div>
          )}
        </button>
        <div className="shrink-0 text-right font-mono text-[11px] text-slate-400">
          <div>+{offset.toFixed(1)}s</div>
          {s.duration_ms != null && s.kind !== 'tool' && <div>{fmtMs(s.duration_ms)}</div>}
        </div>
      </div>
      {open && (
        <pre className="scroll-thin mt-2 max-h-56 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] leading-relaxed text-slate-100">
          {JSON.stringify({ input: attrs.input, output: attrs.output }, null, 2)}
        </pre>
      )}
    </li>
  );
}

export function Timeline({ spans, traceId }: { spans: Span[]; traceId: string }) {
  const t0 = spans.length ? new Date(spans[0].started_at).getTime() : Date.now();
  return (
    <div>
      <div className="mb-3 flex items-center justify-between text-[11px] text-slate-500">
        <span>
          trace <span className="font-mono text-slate-700">{traceId.slice(0, 16)}</span>
        </span>
        <span>{spans.length} steps</span>
      </div>
      {spans.length === 0 ? (
        <p className="text-sm text-slate-500">No steps recorded for this claim.</p>
      ) : (
        <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-3 before:top-2 before:w-px before:bg-slate-200" data-testid="timeline">
          {spans.map((s) => (
            <SpanRow key={s.id} s={s} t0={t0} />
          ))}
        </ol>
      )}
    </div>
  );
}

import { BookText, Check, FileWarning, Gauge, Hash, Scale, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ClaimDetail, TriageResult } from '../types';
import { CAUSE_LABEL, fmtInt, fmtMs, fmtUsd } from '../format';
import { Badge, Button, Card, Spinner, cx } from './ui';

const EVIDENCE_ICON: Record<TriageResult['evidence'][number]['kind'], ReactNode> = {
  telemetry: <Gauge size={13} />,
  fault_code: <Hash size={13} />,
  bulletin: <BookText size={13} />,
  policy: <Scale size={13} />,
};

const DECISION_STYLE = {
  covered: { label: 'Covered', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  not_covered: { label: 'Not covered', cls: 'bg-rose-50 text-rose-800 ring-rose-200' },
  needs_inspection: { label: 'Needs inspection', cls: 'bg-amber-50 text-amber-800 ring-amber-200' },
};

export function TriageCard({
  detail,
  onDecide,
  deciding,
  decideError,
}: {
  detail: ClaimDetail;
  onDecide: (action: 'approve' | 'reject', repair: TriageResult['repair'] | undefined, note: string) => void;
  deciding: boolean;
  decideError: string | null;
}) {
  const triage = detail.triage!;
  const shown = detail.decision?.final ?? triage.result;
  const r = shown;
  const run = triage.run;
  const editable = detail.claim.status === 'awaiting_review';
  const [labour, setLabour] = useState(String(r.repair.labour_hours));
  const [qty, setQty] = useState<number[]>(r.repair.parts.map((p) => p.qty));
  const [note, setNote] = useState('');

  useEffect(() => {
    setLabour(String(r.repair.labour_hours));
    setQty(r.repair.parts.map((p) => p.qty));
    setNote('');
  }, [detail.claim.id, detail.claim.version]);

  const labourNum = Number(labour);
  const labourValid = labour.trim() !== '' && Number.isFinite(labourNum) && labourNum >= 0 && labourNum <= 20;
  const edited = useMemo(
    () => labourNum !== triage.result.repair.labour_hours || qty.some((q, i) => q !== triage.result.repair.parts[i]?.qty),
    [labourNum, qty, triage.result],
  );
  const dec = DECISION_STYLE[r.warranty.decision];
  const conf = Math.round(r.root_cause.confidence * 100);

  return (
    <Card
      title="Triage result"
      icon={<ShieldCheck size={15} className="text-indigo-500" />}
      right={
        <div className="flex items-center gap-1.5">
          <Badge tone={run.mode === 'live' ? 'emerald' : 'violet'}>{run.mode === 'live' ? 'Live run' : 'Replay'}</Badge>
          {detail.decision && <Badge tone={detail.decision.decision === 'approved' ? 'emerald' : 'slate'}>{detail.decision.decision === 'approved' ? 'Approved by engineer' : 'Rejected by engineer'}</Badge>}
        </div>
      }
      bodyClass="space-y-4"
    >
      <div data-testid="triage-card">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Root cause</div>
            <div className="mt-0.5 text-[15px] font-semibold leading-snug text-slate-900">{r.root_cause.title}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700" data-testid="root-cause-code">
                {r.root_cause.code}
              </code>
              <span>{CAUSE_LABEL[r.root_cause.code]}</span>
              <span className="text-slate-300">|</span>
              <span>{r.root_cause.component}</span>
            </div>
          </div>
          <div className="w-28 shrink-0 text-right">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Confidence</div>
            <div className="text-lg font-semibold text-slate-900">{conf}%</div>
            <div className="mt-1 h-1.5 rounded-full bg-slate-100">
              <div className={cx('h-1.5 rounded-full', conf >= 75 ? 'bg-emerald-500' : conf >= 50 ? 'bg-amber-500' : 'bg-rose-500')} style={{ width: `${conf}%` }} />
            </div>
          </div>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-slate-600">{r.summary}</p>
      </div>

      <div>
        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">Evidence</div>
        <ul className="space-y-1.5">
          {r.evidence.map((e, i) => (
            <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug">
              <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded-md bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 ring-1 ring-slate-200">
                {EVIDENCE_ICON[e.kind]}
                {e.ref}
              </span>
              <span className="text-slate-700">{e.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={cx('rounded-lg p-3 ring-1 ring-inset', dec.cls)} data-testid="warranty-decision">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {r.warranty.decision === 'not_covered' ? <FileWarning size={15} /> : <Scale size={15} />}
            {dec.label} under {r.warranty.clause}
          </div>
          <span className="rounded bg-white/70 px-1.5 py-0.5 text-[10.5px] font-medium">Decided by rules, not the model</span>
        </div>
        <p className="mt-1 text-[12.5px] leading-snug opacity-90">{r.warranty.reason}</p>
        {run.guardrails?.length ? <p className="mt-1 text-[11px] opacity-75">Guardrail: {run.guardrails.join('; ')}</p> : null}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Parts and labour</span>
          {edited && editable && <Badge tone="indigo">Edited</Badge>}
        </div>
        <table className="w-full text-[12.5px]">
          <tbody>
            {r.repair.parts.length === 0 && (
              <tr>
                <td className="py-1 text-slate-500">No parts (software update)</td>
              </tr>
            )}
            {r.repair.parts.map((p, i) => (
              <tr key={p.part_number} className="border-b border-slate-100">
                <td className="py-1.5 pr-2 font-mono text-[11.5px] text-slate-500">{p.part_number}</td>
                <td className="py-1.5 pr-2 text-slate-800">{p.description}</td>
                <td className="w-20 py-1.5 text-right">
                  {editable ? (
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={qty[i] ?? p.qty}
                      onChange={(ev) => setQty(qty.map((q, j) => (j === i ? Math.max(1, Math.min(20, Number(ev.target.value) || 1)) : q)))}
                      className="h-7 w-14 rounded-md border border-slate-200 px-1.5 text-right text-[12.5px]"
                      aria-label={`Quantity ${p.part_number}`}
                    />
                  ) : (
                    <span className="text-slate-700">x{p.qty}</span>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td className="py-1.5 pr-2 text-slate-500" colSpan={2}>
                Labour (hours)
              </td>
              <td className="py-1.5 text-right">
                {editable ? (
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    max={20}
                    value={labour}
                    onChange={(ev) => setLabour(ev.target.value)}
                    className={cx('h-7 w-14 rounded-md border px-1.5 text-right text-[12.5px]', labourValid ? 'border-slate-200' : 'border-rose-400')}
                    aria-label="Labour hours"
                    data-testid="labour-input"
                  />
                ) : (
                  <span className="text-slate-700">{r.repair.labour_hours} h</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-[1.5fr_1fr_1fr_1.2fr] gap-2 rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-500 ring-1 ring-slate-100" data-testid="run-stats">
        <div>
          <div className="text-slate-400">Model</div>
          <div className="truncate font-medium text-slate-700">{run.model ?? run.source?.model ?? '-'}</div>
        </div>
        <div>
          <div className="text-slate-400">{run.mode === 'replay' ? 'Recorded latency' : 'Latency'}</div>
          <div className="font-medium text-slate-700">{fmtMs(run.duration_ms)}</div>
        </div>
        <div>
          <div className="text-slate-400">{run.mode === 'replay' ? 'Recorded cost' : 'Cost'}</div>
          <div className="font-medium text-slate-700">{fmtUsd(run.cost_usd)}</div>
        </div>
        <div>
          <div className="text-slate-400">Tokens in / out</div>
          <div className="font-medium text-slate-700">
            {fmtInt(run.input_tokens)} / {fmtInt(run.output_tokens)}
          </div>
        </div>
        <div className="col-span-4 text-[10.5px] text-slate-400">
          {run.mode === 'replay' ? `Replay of a live run recorded ${run.source?.recorded_at ?? ''} on ${run.source?.model ?? ''}. ` : ''}
          {run.served_from_store ? 'Served from the idempotency store, 0 new model runs. ' : `${run.model_runs} model run${run.model_runs === 1 ? '' : 's'}, ${run.num_turns ?? '-'} turns.`}
        </div>
      </div>

      {editable && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Note for the dealer (optional)"
            className="h-8 w-full rounded-md border border-slate-200 px-2.5 text-[12.5px] placeholder:text-slate-400"
          />
          {decideError && <div className="rounded-md bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 ring-1 ring-rose-200">{decideError}</div>}
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-slate-400">Sends If-Match: "{detail.claim.version}" as engineer key</span>
            <div className="flex gap-2">
              <Button variant="danger" disabled={deciding} onClick={() => onDecide('reject', undefined, note)} data-testid="reject">
                <X size={14} /> Reject
              </Button>
              <Button
                variant="success"
                disabled={deciding || !labourValid}
                data-testid="approve"
                onClick={() =>
                  onDecide('approve', edited ? { labour_hours: labourNum, parts: triage.result.repair.parts.map((p, i) => ({ ...p, qty: qty[i] ?? p.qty })) } : undefined, note)
                }
              >
                {deciding ? <Spinner className="h-3.5 w-3.5" /> : <Check size={14} />} {edited ? 'Approve with edits' : 'Approve'}
              </Button>
            </div>
          </div>
        </div>
      )}
      {detail.decision && (
        <div className="rounded-lg bg-slate-50 p-2.5 text-[12px] text-slate-600 ring-1 ring-slate-100">
          {detail.decision.decision === 'approved' ? 'Approved' : 'Rejected'} by {detail.decision.decided_by.replace('key_', '')} {new Date(detail.decision.decided_at).toLocaleTimeString()}
          {detail.decision.edits.length > 0 && <> with edits: {detail.decision.edits.map((e) => `${e.field} ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`).join('; ')}</>}
          {detail.decision.note && <> · "{detail.decision.note}"</>}. The model suggestion is kept next to the decision.
        </div>
      )}
    </Card>
  );
}

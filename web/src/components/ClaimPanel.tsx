import { Archive, Bike, Clock, FileSearch, ListTree, Loader2, Skull } from 'lucide-react';
import type { ClaimDetail, Span, TriageResult } from '../types';
import { CAUSE_LABEL, relativeTime } from '../format';
import { TriageCard } from './TriageCard';
import { Timeline } from './Timeline';
import { Badge, Card, Spinner, StatusPill } from './ui';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="truncate text-[13px] text-slate-800">{children}</div>
    </div>
  );
}

export function ClaimPanel({
  detail,
  spans,
  loading,
  error,
  onDecide,
  deciding,
  decideError,
}: {
  detail: ClaimDetail | null;
  spans: Span[];
  loading: boolean;
  error: string | null;
  onDecide: (action: 'approve' | 'reject', repair: TriageResult['repair'] | undefined, note: string) => void;
  deciding: boolean;
  decideError: string | null;
}) {
  if (error) return <div className="m-6 rounded-lg bg-rose-50 p-4 text-sm text-rose-700 ring-1 ring-rose-200">{error}</div>;
  if (!detail) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-slate-500">
        {loading ? (
          <Spinner className="h-6 w-6 text-slate-300" />
        ) : (
          <>
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
              <FileSearch size={22} className="text-indigo-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700">Pick a claim from the inbox</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
                Or file a new one as a dealer: the API queues a triage job, the Python agent streams each tool call here, and an engineer signs off.
              </p>
            </div>
          </>
        )}
      </div>
    );
  }
  const c = detail.claim;
  const job = detail.job;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claim-panel">
      <div className="border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-base font-semibold text-slate-900" data-testid="claim-number">
              {c.claim_number}
            </h2>
            <StatusPill status={c.status} />
            {c.historical && (
              <Badge tone="slate">
                <Archive size={12} /> Historical
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Clock size={13} /> Filed {relativeTime(c.filed_at)} · version <span className="font-mono text-slate-700">{c.version}</span>
          </div>
        </div>
        <p className="mt-1 text-[13px] text-slate-700">{c.complaint}</p>
        <div className="mt-2.5 grid grid-cols-5 gap-4">
          <Field label="Bike">
            <span className="inline-flex items-center gap-1">
              <Bike size={13} className="text-slate-400" /> {c.model}
            </span>
          </Field>
          <Field label="VIN">
            <span className="font-mono text-[12px]">{c.vin}</span>
          </Field>
          <Field label="Dealer">{c.dealer.name}</Field>
          <Field label="Odometer">{detail.odometer_km.toLocaleString('en-US')} km</Field>
          <Field label="Firmware">{detail.vehicle.firmware ?? '-'}</Field>
        </div>
      </div>

      <div className="scroll-thin grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 overflow-y-auto p-4">
        <div className="space-y-4">
          {detail.triage && <TriageCard detail={detail} onDecide={onDecide} deciding={deciding} decideError={decideError} />}
          {!detail.triage && c.historical && (
            <Card title="Imported history" icon={<Archive size={15} className="text-slate-400" />}>
              <p className="text-[13px] leading-relaxed text-slate-600">
                One of 20,000 synthetic historical claims seeded for pagination. Only its read-model summary exists:
              </p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                <Field label="Root cause">{c.triage ? CAUSE_LABEL[c.triage.root_cause_code] : '-'}</Field>
                <Field label="Confidence">{c.triage?.confidence != null ? `${Math.round(c.triage.confidence * 100)}%` : '-'}</Field>
                <Field label="Warranty">{c.triage?.warranty_decision?.replace('_', ' ') ?? '-'}</Field>
              </div>
            </Card>
          )}
          {!detail.triage && !c.historical && c.status !== 'dead_lettered' && (
            <Card title="Triage in progress" icon={<Loader2 size={15} className="animate-spin text-sky-500" />}>
              <p className="text-[13px] text-slate-600" data-testid="triage-running">
                {job ? `Job ${job.status}, attempt ${Math.max(1, job.attempts)} of ${job.max_attempts}.` : 'Waiting for the outbox relay to queue the job.'} The timeline updates live as each tool runs.
              </p>
              {job?.last_error && <p className="mt-2 text-xs text-rose-600">Last error: {job.last_error}</p>}
            </Card>
          )}
          {c.status === 'dead_lettered' && !c.historical && (
            <Card title="Dead-lettered" icon={<Skull size={15} className="text-rose-500" />}>
              <p className="text-[13px] leading-relaxed text-slate-700" data-testid="dead-reason">
                {job?.dead_reason ?? 'The job failed permanently.'}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                A 4xx from the triage service is permanent, so the job went to the dead-letter list at once instead of using its {job?.max_attempts ?? 6} attempts.
              </p>
            </Card>
          )}
          {detail.attempts.length > 0 && (
            <Card title="Job attempts" icon={<ListTree size={15} className="text-slate-400" />} bodyClass="p-0">
              <table className="w-full text-[12px]">
                <tbody>
                  {detail.attempts.map((a) => (
                    <tr key={a.n} className="border-b border-slate-100 last:border-0">
                      <td className="w-10 px-4 py-2 font-mono text-slate-500">#{a.n}</td>
                      <td className="py-2 pr-2">
                        <span className={a.outcome === 'succeeded' ? 'text-emerald-700' : a.outcome ? 'text-rose-700' : 'text-sky-700'}>{a.outcome ?? 'running'}</span>
                        {a.served_from_store && <span className="ml-1.5 text-slate-500">(from idempotency store)</span>}
                      </td>
                      <td className="max-w-[260px] truncate py-2 pr-4 text-right text-slate-500" title={a.error ?? ''}>
                        {a.error ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
        <Card title="Timeline" icon={<ListTree size={15} className="text-indigo-500" />} className="self-start">
          <Timeline spans={spans} traceId={detail.trace_id} />
        </Card>
      </div>
    </div>
  );
}

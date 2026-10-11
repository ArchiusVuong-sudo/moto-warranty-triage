import { ChevronDown, Inbox as InboxIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ClaimStatus, ClaimSummary } from '../types';
import { CAUSE_LABEL, relativeTime } from '../format';
import { Button, Spinner, StatusPill, cx } from './ui';

export const FILTERS: { id: ClaimStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'awaiting_review', label: 'Awaiting review' },
  { id: 'triaging', label: 'Triaging' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'dead_lettered', label: 'Dead-lettered' },
];

export function Inbox({
  claims,
  total,
  filter,
  onFilter,
  selectedId,
  onSelect,
  hasMore,
  loading,
  error,
  onLoadMore,
  flashIds,
}: {
  claims: ClaimSummary[];
  total: number | null;
  filter: ClaimStatus | 'all';
  onFilter: (f: ClaimStatus | 'all') => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
  flashIds: Set<string>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the selected claim in view, for example a claim just filed while the list was scrolled down.
  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector(`[data-claim-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, claims.length]);

  return (
    <section className="flex min-h-0 w-[540px] shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-100 px-4 pb-2.5 pt-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Inbox</h2>
          <span className="text-xs text-slate-500" data-testid="claim-total">
            {total != null ? `${total.toLocaleString('en-US')} synthetic claims` : ''}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => onFilter(f.id)}
              className={cx('rounded-full px-2.5 py-1 text-xs font-medium transition', filter === f.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[96px_1fr_118px] gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        <span>Claim</span>
        <span>Bike and complaint</span>
        <span className="text-right">Status</span>
      </div>
      <div ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto" data-testid="inbox-list">
        {error && <div className="m-4 rounded-lg bg-rose-50 p-3 text-xs text-rose-700 ring-1 ring-rose-200">{error}</div>}
        {!error && !loading && claims.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-slate-500">
            <InboxIcon size={22} className="text-slate-300" />
            No claims with this status.
          </div>
        )}
        {claims.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            data-testid="inbox-row"
            data-claim-number={c.claim_number}
            data-claim-id={c.id}
            className={cx(
              'grid w-full grid-cols-[96px_1fr_118px] items-center gap-3 border-b border-slate-100 px-4 py-2.5 text-left transition',
              selectedId === c.id ? 'bg-indigo-50/70' : 'hover:bg-slate-50',
              flashIds.has(c.id) && 'animate-slide-in bg-amber-50/60',
            )}
          >
            <div className="min-w-0">
              <div className="font-mono text-[12px] font-medium text-slate-800">{c.claim_number}</div>
              <div className="text-[11px] text-slate-400">{relativeTime(c.filed_at)}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13px] text-slate-800">{c.complaint}</div>
              <div className="truncate text-[11px] text-slate-500">
                {c.model} · {c.dealer.name}
                {c.triage && <span className="text-slate-400"> · {CAUSE_LABEL[c.triage.root_cause_code] ?? c.triage.root_cause_code}</span>}
              </div>
            </div>
            <div className="flex justify-end">
              <StatusPill status={c.status} />
            </div>
          </button>
        ))}
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-500">
            <Spinner className="text-slate-400" /> Loading claims
          </div>
        )}
        {hasMore && !loading && (
          <div className="p-3">
            <Button className="w-full" onClick={onLoadMore} data-testid="load-more">
              <ChevronDown size={15} /> Load more
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

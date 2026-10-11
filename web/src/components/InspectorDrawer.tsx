import { Database, Gauge, History, ListOrdered, Play } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { api, requestLog, type LoggedRequest } from '../api';
import { Badge, Button, Drawer, Spinner, cx } from './ui';

type Tab = 'requests' | 'plan' | 'burst' | 'versions';

interface PlanSummary {
  sql: string;
  scan: string;
  index: string | null;
  rows_read: number;
  rows_returned: number;
  execution_ms: number;
  wall_ms_median: number;
  text: string;
}

function statusTone(s: number) {
  return s >= 500 ? 'text-rose-700' : s >= 400 ? 'text-amber-700' : 'text-emerald-700';
}

function Headers({ h }: { h: Record<string, string> }) {
  return (
    <div className="space-y-0.5 font-mono text-[11px]">
      {Object.entries(h).map(([k, v]) => (
        <div key={k} className="break-all">
          <span className="text-sky-700">{k}</span>: <span className="text-slate-700">{v}</span>
        </div>
      ))}
    </div>
  );
}

function Requests() {
  const log = useSyncExternalStore(requestLog.subscribe, requestLog.snapshot);
  const [open, setOpen] = useState<number | null>(log[0]?.id ?? null);
  if (!log.length) return <p className="p-5 text-sm text-slate-500">No requests yet.</p>;
  return (
    <ul className="divide-y divide-slate-100" data-testid="request-log">
      {log.map((r: LoggedRequest) => (
        <li key={r.id}>
          <button className="flex w-full items-center gap-3 px-5 py-2 text-left hover:bg-slate-50" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <span className={cx('w-9 font-mono text-[12px] font-semibold', statusTone(r.status))}>{r.status}</span>
            <span className="w-11 font-mono text-[11px] text-slate-500">{r.method}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-slate-800">{r.path}</span>
            <span className="text-[11px] text-slate-400">{r.role}</span>
            <span className="w-14 text-right font-mono text-[11px] text-slate-400">{r.ms} ms</span>
          </button>
          {open === r.id && (
            <div className="grid grid-cols-2 gap-4 bg-slate-50/70 px-5 py-3">
              <div>
                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">Request headers</div>
                <Headers h={r.requestHeaders} />
              </div>
              <div>
                <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400">Response headers</div>
                <Headers h={r.responseHeaders} />
              </div>
              {r.body != null && <pre className="col-span-2 whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-rose-700 ring-1 ring-slate-200">{JSON.stringify(r.body, null, 2)}</pre>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function PlanCard({ title, p, tone }: { title: string; p: PlanSummary; tone: 'good' | 'bad' }) {
  return (
    <div className={cx('rounded-xl p-4 ring-1', tone === 'good' ? 'bg-emerald-50/50 ring-emerald-200' : 'bg-amber-50/50 ring-amber-200')} data-testid={`plan-${tone === 'good' ? 'keyset' : 'offset'}`}>
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-slate-800">{title}</div>
        <Badge tone={tone === 'good' ? 'emerald' : 'amber'}>{p.scan}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
        <div>
          <div>Rows read</div>
          <div className="text-base font-semibold text-slate-900">{p.rows_read.toLocaleString('en-US')}</div>
        </div>
        <div>
          <div>Execution</div>
          <div className="text-base font-semibold text-slate-900">{p.execution_ms.toFixed(2)} ms</div>
        </div>
        <div>
          <div>Wall, median of 5</div>
          <div className="text-base font-semibold text-slate-900">{p.wall_ms_median.toFixed(2)} ms</div>
        </div>
      </div>
      <div className="mt-2 text-[11px] text-slate-500">
        Index: <span className="font-mono text-slate-700">{p.index ?? 'none'}</span>
      </div>
      <pre className="scroll-thin mt-2 overflow-x-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[10.5px] leading-relaxed text-slate-200">{p.text}</pre>
    </div>
  );
}

function QueryPlan() {
  const [data, setData] = useState<{ depth: number; total_rows: number; keyset: PlanSummary; offset: PlanSummary } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setLoading(true);
    setError(null);
    const res = await api<typeof data>('GET', '/v2/ops/query-plan?depth=15000', { role: 'console' });
    setLoading(false);
    if (res.ok) setData(res.data);
    else setError(`HTTP ${res.status}`);
  }
  return (
    <div className="space-y-4 p-5">
      <p className="text-[13px] leading-relaxed text-slate-600">
        Page 301 of the inbox (rows 15,001 to 15,050). The keyset query seeks to the cursor on the <span className="font-mono">(filed_at, claim_id)</span> index. OFFSET walks and throws away 15,000 rows first. Both run with EXPLAIN ANALYZE on the live database.
      </p>
      <Button variant="primary" onClick={run} disabled={loading} data-testid="run-plan">
        {loading ? <Spinner className="h-3.5 w-3.5" /> : <Play size={14} />} Run EXPLAIN ANALYZE
      </Button>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      {data && (
        <div className="space-y-3">
          <PlanCard title="v2 keyset cursor" p={data.keyset} tone="good" />
          <PlanCard title="v1 OFFSET 15000" p={data.offset} tone="bad" />
        </div>
      )}
    </div>
  );
}

function Burst() {
  const [cells, setCells] = useState<{ status: number; retryAfter: string | null; remaining: string | null }[]>([]);
  const [running, setRunning] = useState(false);
  async function burst() {
    setRunning(true);
    setCells([]);
    for (let i = 0; i < 30; i++) {
      const res = await api('GET', '/v2/claims?limit=1', { role: 'dealer' });
      setCells((c) => [...c, { status: res.status, retryAfter: res.headers.get('retry-after'), remaining: res.headers.get('ratelimit-remaining') }]);
    }
    setRunning(false);
  }
  const ok = cells.filter((c) => c.status === 200).length;
  const limited = cells.filter((c) => c.status === 429);
  return (
    <div className="space-y-4 p-5">
      <p className="text-[13px] leading-relaxed text-slate-600">
        The dealer key has a token bucket of 20 requests, refilled at 1 per second. 30 requests back to back should end in 429s, each with Retry-After.
      </p>
      <Button variant="primary" onClick={burst} disabled={running} data-testid="burst">
        {running ? <Spinner className="h-3.5 w-3.5" /> : <Gauge size={14} />} Burst 30 requests (dealer key)
      </Button>
      {cells.length > 0 && (
        <>
          <div className="grid grid-cols-10 gap-1.5" data-testid="burst-grid">
            {cells.map((c, i) => (
              <div
                key={i}
                title={c.status === 429 ? `429, Retry-After ${c.retryAfter}s` : `200, remaining ${c.remaining}`}
                className={cx('flex h-11 flex-col items-center justify-center rounded-md font-mono text-[11px] font-semibold', c.status === 200 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800')}
              >
                {c.status}
                {c.status === 429 && <span className="text-[9.5px] font-normal">retry {c.retryAfter}s</span>}
              </div>
            ))}
          </div>
          {!running && <p className="text-[12px] text-slate-600" data-testid="burst-summary">
            {ok} allowed, {limited.length} refused with 429{limited[0] ? `, Retry-After ${limited[0].retryAfter} s` : ''}. Open the Requests tab for the RateLimit headers.
          </p>}
        </>
      )}
    </div>
  );
}

function Versions() {
  const [v1, setV1] = useState<{ status: number; headers: Record<string, string>; body: unknown } | null>(null);
  const [v2, setV2] = useState<{ status: number; headers: Record<string, string>; body: unknown } | null>(null);
  async function load() {
    const pick = (h: Headers, names: string[]) => Object.fromEntries(names.map((n) => [n, h.get(n) ?? '']).filter(([, v]) => v));
    const a = await api<{ claims: unknown[] }>('GET', '/v1/claims?page=2&per_page=2', { role: 'console' });
    setV1({ status: a.status, headers: pick(a.headers, ['deprecation', 'sunset', 'link']), body: a.data });
    const b = await api<{ data: unknown[] }>('GET', '/v2/claims?limit=2', { role: 'console' });
    setV2({ status: b.status, headers: pick(b.headers, ['link', 'ratelimit-remaining']), body: { ...b.data, data: (b.data.data ?? []).slice(0, 1) } });
  }
  const Block = ({ title, d }: { title: string; d: NonNullable<typeof v1> }) => (
    <div className="rounded-xl ring-1 ring-slate-200" data-testid={`version-${title.slice(0, 2).toLowerCase()}`}>
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-[13px] font-semibold text-slate-800">
        {title} <span className={cx('font-mono text-xs', statusTone(d.status))}>{d.status}</span>
      </div>
      <div className="space-y-2 p-4">
        <Headers h={d.headers} />
        <pre className="scroll-thin max-h-44 overflow-auto rounded-lg bg-slate-900 p-2.5 font-mono text-[10.5px] text-slate-200">{JSON.stringify(d.body, null, 2)}</pre>
      </div>
    </div>
  );
  return (
    <div className="space-y-4 p-5">
      <p className="text-[13px] leading-relaxed text-slate-600">
        v1 still answers old dealer tools with offset pages and the old field names, and announces its end with Deprecation, Sunset and a successor link. v2 uses cursors.
      </p>
      <Button variant="primary" onClick={load} data-testid="load-versions">
        <History size={14} /> Call v1 and v2
      </Button>
      {v1 && <Block title="v1 /v1/claims (deprecated)" d={v1} />}
      {v2 && <Block title="v2 /v2/claims" d={v2} />}
    </div>
  );
}

export function InspectorDrawer({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('requests');
  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'requests', label: 'Requests', icon: <ListOrdered size={14} /> },
    { id: 'plan', label: 'Query plan', icon: <Database size={14} /> },
    { id: 'burst', label: 'Rate limit', icon: <Gauge size={14} /> },
    { id: 'versions', label: 'Versions', icon: <History size={14} /> },
  ];
  return (
    <Drawer title="API inspector" subtitle="Every request this console makes, with the headers that matter" onClose={onClose} width="w-[640px]">
      <div className="sticky top-0 z-10 flex gap-1 border-b border-slate-100 bg-white px-4 py-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
            className={cx('inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium', tab === t.id ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'requests' && <Requests />}
      {tab === 'plan' && <QueryPlan />}
      {tab === 'burst' && <Burst />}
      {tab === 'versions' && <Versions />}
    </Drawer>
  );
}

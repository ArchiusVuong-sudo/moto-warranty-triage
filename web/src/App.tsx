import { useCallback, useEffect, useRef, useState } from 'react';
import { api, keyFor, problemText, setKeys } from './api';
import { ClaimPanel } from './components/ClaimPanel';
import { DrillsDrawer } from './components/DrillsDrawer';
import { FileClaimModal } from './components/FileClaimModal';
import { Header } from './components/Header';
import { HealthBar } from './components/HealthBar';
import { Inbox } from './components/Inbox';
import { InspectorDrawer } from './components/InspectorDrawer';
import { Spinner } from './components/ui';
import type { ClaimDetail, ClaimPage, ClaimStatus, ClaimSummary, DemoConfig, Health, Span, TriageResult } from './types';

/** claim_view rows arrive raw over SSE; this mirrors the API's toClaimSummary. */
function fromView(r: Record<string, unknown>): ClaimSummary {
  return {
    id: String(r.claim_id),
    claim_number: String(r.claim_number),
    dealer: { id: Number(r.dealer_id), name: String(r.dealer_name) },
    vin: String(r.vin),
    model: String(r.model),
    complaint: String(r.complaint),
    status: r.status as ClaimStatus,
    filed_at: new Date(String(r.filed_at)).toISOString(),
    version: Number(r.version),
    triage: r.root_cause_code ? { root_cause_code: String(r.root_cause_code), confidence: r.confidence as number | null, warranty_decision: (r.warranty_decision as string) ?? null } : null,
    historical: Boolean(r.historical),
  };
}

export default function App() {
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState(false);

  const [filter, setFilter] = useState<ClaimStatus | 'all'>('all');
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [spans, setSpans] = useState<Span[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [decideError, setDecideError] = useState<string | null>(null);

  const [modal, setModal] = useState<'file' | 'drills' | 'inspector' | null>(null);
  const selectedRef = useRef<string | null>(null);
  const filterRef = useRef(filter);
  selectedRef.current = selectedId;
  filterRef.current = filter;

  useEffect(() => {
    api<DemoConfig>('GET', '/demo/config', { log: false }).then((r) => {
      if (!r.ok) return setBootError(`Could not load the demo config (HTTP ${r.status}).`);
      setKeys(r.data);
      setConfig(r.data);
    }, (e: unknown) => setBootError(String(e)));
  }, []);

  const loadClaims = useCallback(async (f: ClaimStatus | 'all', after: string | null) => {
    setListLoading(true);
    setListError(null);
    const qs = new URLSearchParams({ limit: '50' });
    if (f !== 'all') qs.set('status', f);
    if (after) qs.set('cursor', after);
    const res = await api<ClaimPage>('GET', `/v2/claims?${qs}`, { role: 'console' });
    setListLoading(false);
    if (!res.ok) return setListError(problemText(res.data));
    setClaims((prev) => (after ? [...prev, ...res.data.data.filter((c) => !prev.some((p) => p.id === c.id))] : res.data.data));
    setCursor(res.data.next_cursor);
  }, []);

  useEffect(() => {
    if (config) void loadClaims(filter, null);
  }, [config, filter, loadClaims]);

  const refreshDetail = useCallback(async (id: string) => {
    const [d, t] = await Promise.all([api<ClaimDetail>('GET', `/v2/claims/${id}`, { role: 'console' }), api<{ spans: Span[] }>('GET', `/v2/claims/${id}/timeline`, { role: 'console', log: false })]);
    if (selectedRef.current !== id) return;
    if (!d.ok) {
      setDetailError(problemText(d.data));
      return;
    }
    setDetail(d.data);
    if (t.ok) setSpans(t.data.spans);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    setDetail(null);
    setSpans([]);
    setDetailError(null);
    setDecideError(null);
    setDetailLoading(true);
    void refreshDetail(selectedId).finally(() => setDetailLoading(false));
  }, [selectedId, refreshDetail]);

  // Live updates: health, read-model rows and timeline spans over one SSE stream.
  const refreshTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!config) return;
    const es = new EventSource(`/v2/stream?access_token=${encodeURIComponent(keyFor('console'))}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    const scheduleRefresh = (id: string) => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void refreshDetail(id), 150);
    };
    es.addEventListener('health', (e) => setHealth(JSON.parse((e as MessageEvent).data) as Health));
    es.addEventListener('claim', (e) => {
      const c = fromView(JSON.parse((e as MessageEvent).data) as Record<string, unknown>);
      const f = filterRef.current;
      setClaims((prev) => {
        const i = prev.findIndex((p) => p.id === c.id);
        if (i >= 0) {
          if (f !== 'all' && c.status !== f) return prev.filter((p) => p.id !== c.id);
          const next = prev.slice();
          next[i] = c;
          return next;
        }
        if (f !== 'all' && c.status !== f) return prev;
        if (prev.length && new Date(c.filed_at) < new Date(prev[0].filed_at)) return prev;
        return [c, ...prev];
      });
      setFlash((s) => new Set(s).add(c.id));
      window.setTimeout(() => setFlash((s) => {
        const n = new Set(s);
        n.delete(c.id);
        return n;
      }), 1200);
      if (selectedRef.current === c.id) scheduleRefresh(c.id);
    });
    es.addEventListener('span', (e) => {
      const s = JSON.parse((e as MessageEvent).data) as Span;
      if (s.claim_id !== selectedRef.current) return;
      setSpans((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s].sort((a, b) => a.id - b.id)));
      if (s.kind !== 'tool') scheduleRefresh(s.claim_id);
    });
    return () => es.close();
  }, [config, refreshDetail]);

  async function decide(action: 'approve' | 'reject', repair: TriageResult['repair'] | undefined, note: string) {
    if (!detail) return;
    setDeciding(true);
    setDecideError(null);
    const body: Record<string, unknown> = { action };
    if (repair) body.repair = repair;
    if (note.trim()) body.note = note.trim();
    const res = await api<{ version: number }>('POST', `/v2/claims/${detail.claim.id}/triage-decision`, { role: 'engineer', body, headers: { 'if-match': `"${detail.claim.version}"` } });
    setDeciding(false);
    if (!res.ok) {
      setDecideError(res.status === 412 ? 'Someone changed this claim first (412). Reloaded the latest version.' : `${res.status} ${problemText(res.data)}`);
    }
    await refreshDetail(detail.claim.id);
  }

  if (bootError) return <div className="m-10 rounded-xl bg-rose-50 p-5 text-sm text-rose-700 ring-1 ring-rose-200">{bootError}</div>;
  if (!config)
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-500">
        <Spinner className="text-slate-400" /> Loading console
      </div>
    );

  const selected = claims.find((c) => c.id === selectedId) ?? detail?.claim ?? null;
  return (
    <div className="flex h-full min-w-[1280px] flex-col">
      <Header health={health} onFile={() => setModal('file')} onDrills={() => setModal('drills')} onInspector={() => setModal('inspector')} />
      <HealthBar health={health} connected={connected} />
      <main className="flex min-h-0 flex-1">
        <Inbox
          claims={claims}
          total={health?.claims ?? null}
          filter={filter}
          onFilter={(f) => {
            setClaims([]);
            setCursor(null);
            setFilter(f);
          }}
          selectedId={selectedId}
          onSelect={setSelectedId}
          hasMore={Boolean(cursor)}
          loading={listLoading}
          error={listError}
          onLoadMore={() => cursor && void loadClaims(filter, cursor)}
          flashIds={flash}
        />
        <ClaimPanel detail={detail} spans={spans} loading={detailLoading} error={detailError} onDecide={decide} deciding={deciding} decideError={decideError} />
      </main>
      {modal === 'file' && (
        <FileClaimModal
          scenarios={config.scenarios}
          onClose={() => setModal(null)}
          onFiled={(id, close) => {
            setSelectedId(id);
            if (close) setModal(null);
          }}
        />
      )}
      {modal === 'drills' && (
        <DrillsDrawer
          onClose={() => setModal(null)}
          selected={selected}
          health={health}
          onOpenClaim={(id) => {
            setSelectedId(id);
            setModal(null);
          }}
        />
      )}
      {modal === 'inspector' && <InspectorDrawer onClose={() => setModal(null)} />}
    </div>
  );
}

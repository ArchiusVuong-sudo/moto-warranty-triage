import { ArrowRight, Bike, RefreshCw, Send } from 'lucide-react';
import { useState } from 'react';
import { api, keyFor, maskKey, problemText } from '../api';
import type { Scenario } from '../types';
import { Badge, Button, Spinner, cx } from './ui';

interface Sent {
  status: number;
  replayed: boolean;
  location: string | null;
  body: Record<string, unknown>;
  ms: number;
}

function uuid(): string {
  return crypto.randomUUID();
}

export function FileClaimModal({ scenarios, onClose, onFiled }: { scenarios: Scenario[]; onClose: () => void; onFiled: (claimId: string, close: boolean) => void }) {
  const [picked, setPicked] = useState<Scenario>(scenarios[0]);
  const [idemKey, setIdemKey] = useState(uuid());
  const [sending, setSending] = useState(false);
  const [responses, setResponses] = useState<Sent[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const doc = await api<{ ride_log: Record<string, unknown> }>('GET', `/demo/scenarios/${picked.id}`, { log: false });
      const body = { vin: picked.vehicle.vin, complaint: picked.complaint, odometer_km: picked.vehicle.odometer_km, ride_log: doc.data.ride_log };
      const res = await api<Record<string, unknown>>('POST', '/v2/claims', { role: 'dealer', body, headers: { 'idempotency-key': idemKey } });
      if (!res.ok) {
        setError(`${res.status} ${problemText(res.data)}`);
        return;
      }
      const sent = { status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true', location: res.headers.get('location'), body: res.data, ms: res.ms };
      setResponses((r) => [...r, sent]);
      if (!sent.replayed) onFiled(String(res.data.id), false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  function pick(s: Scenario) {
    setPicked(s);
    setIdemKey(uuid());
    setResponses([]);
    setError(null);
  }

  const first = responses[0];
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 backdrop-blur-[1px]" onClick={onClose}>
      <div className="animate-slide-in flex h-[680px] w-[1080px] overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200" onClick={(e) => e.stopPropagation()} data-testid="file-claim-modal">
        <div className="flex w-[380px] shrink-0 flex-col border-r border-slate-100 bg-slate-50/60">
          <div className="px-5 pb-3 pt-5">
            <h2 className="text-base font-semibold text-slate-900">File a claim as a dealer</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">Pick a synthetic ride-log export. Each one points to a different fault.</p>
          </div>
          <div className="scroll-thin flex-1 space-y-1.5 overflow-y-auto px-3 pb-4">
            {scenarios.map((s) => (
              <button
                key={s.id}
                onClick={() => pick(s)}
                data-testid="scenario"
                data-scenario={s.id}
                className={cx('w-full rounded-xl px-3 py-2.5 text-left ring-1 transition', picked.id === s.id ? 'bg-white ring-indigo-300 shadow-sm' : 'ring-transparent hover:bg-white hover:ring-slate-200')}
              >
                <div className="text-[13px] font-medium text-slate-800">{s.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                  <Bike size={12} /> {s.vehicle.model} · {s.vehicle.odometer_km.toLocaleString('en-US')} km · {s.rows} rows
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div className="text-sm font-medium text-slate-800">Request preview</div>
            <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100">
              Close
            </button>
          </div>
          <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-5">
            <pre className="rounded-xl bg-slate-900 p-4 font-mono text-[12px] leading-relaxed text-slate-200" data-testid="request-preview">
              <span className="text-emerald-300">POST</span> /v2/claims{'\n'}
              <span className="text-sky-300">Authorization</span>: Bearer {maskKey(keyFor('dealer'))}
              {'  '}
              <span className="text-slate-500"># dealer key, scope claims:write</span>
              {'\n'}
              <span className="text-sky-300">Idempotency-Key</span>: {idemKey}
              {'\n'}
              <span className="text-sky-300">Content-Type</span>: application/json{'\n\n'}
              {JSON.stringify({ vin: picked.vehicle.vin, complaint: picked.complaint, odometer_km: picked.vehicle.odometer_km, ride_log: `{ ${picked.rows} rows x 16 columns at 1 Hz, fault codes }` }, null, 2)}
            </pre>
            {error && <div className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 ring-1 ring-rose-200">{error}</div>}
            {responses.map((r, i) => (
              <div key={i} className="animate-slide-in rounded-xl ring-1 ring-slate-200" data-testid="file-response">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2">
                  <div className="flex items-center gap-2 text-[13px]">
                    <Badge tone="emerald">{r.status} Created</Badge>
                    {r.replayed ? <Badge tone="indigo">Idempotent-Replayed: true</Badge> : <span className="text-xs text-slate-500">new claim</span>}
                  </div>
                  <span className="font-mono text-[11px] text-slate-400">{r.ms} ms</span>
                </div>
                <div className="space-y-1 px-4 py-2.5 font-mono text-[11.5px] text-slate-600">
                  <div>
                    Location: <span className="text-slate-800">{r.location}</span>
                  </div>
                  <div>
                    claim_number: <span className="text-slate-800">{String(r.body.claim_number)}</span> · id {String(r.body.id).slice(0, 8)}
                  </div>
                  {r.replayed && first && <div className="text-indigo-700">Same claim as the first response: {String(first.body.id) === String(r.body.id) ? 'yes, no duplicate filed' : 'no'}</div>}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
            <span className="text-[11px] text-slate-400">Synthetic VIN and ride log.</span>
            <div className="flex gap-2">
              {first ? (
                <>
                  <Button onClick={send} disabled={sending} data-testid="send-again">
                    {sending ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw size={14} />} Send again, same key
                  </Button>
                  <Button variant="primary" onClick={() => onFiled(String(first.body.id), true)} data-testid="open-claim">
                    Open claim <ArrowRight size={14} />
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={send} disabled={sending} data-testid="submit-claim">
                  {sending ? <Spinner className="h-3.5 w-3.5" /> : <Send size={14} />} Submit claim
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

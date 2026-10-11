import { Copy, PlugZap, Skull, Unplug } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, problemText } from '../api';
import type { ClaimSummary, Health } from '../types';
import { relativeTime } from '../format';
import { Button, Drawer, Spinner } from './ui';

interface DeadLetter {
  job_id: string;
  claim_id: string;
  claim_number: string;
  attempts: number;
  dead_reason: string;
  updated_at: string;
}

function Drill({ icon, title, body, button, onRun, busy, result, disabled, testId }: { icon: ReactNode; title: string; body: ReactNode; button: string; onRun: () => void; busy: boolean; result: string | null; disabled?: boolean; testId: string }) {
  return (
    <div className="rounded-xl p-4 ring-1 ring-slate-200">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 ring-1 ring-amber-200">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-slate-800">{title}</div>
          <div className="mt-1 text-[12px] leading-relaxed text-slate-600">{body}</div>
          <div className="mt-3 flex items-center gap-3">
            <Button size="sm" variant="primary" onClick={onRun} disabled={busy || disabled} data-testid={testId}>
              {busy && <Spinner className="h-3 w-3" />} {button}
            </Button>
            {result && <span className="text-[11.5px] text-slate-600">{result}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function DrillsDrawer({ onClose, selected, health, onOpenClaim }: { onClose: () => void; selected: ClaimSummary | null; health: Health | null; onOpenClaim: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [dead, setDead] = useState<DeadLetter[] | null>(null);

  async function loadDead() {
    const res = await api<{ data: DeadLetter[] }>('GET', '/v2/ops/dead-letters', { role: 'console', log: false });
    if (res.ok) setDead(res.data.data);
  }
  useEffect(() => {
    void loadDead();
  }, [health?.dead_letters]);

  async function run(id: string, path: string, describe: (data: Record<string, unknown>) => string) {
    setBusy(id);
    const res = await api<Record<string, unknown>>('POST', path, { role: 'console' });
    setBusy(null);
    setResults((r) => ({ ...r, [id]: res.ok ? describe(res.data) : `${res.status} ${problemText(res.data)}` }));
  }

  const external = health?.triage_service.state === 'external';
  return (
    <Drawer title="Fault drills" subtitle="Break things on purpose and watch the claim timeline" onClose={onClose} width="w-[520px]">
      <div className="space-y-3 p-5">
        <Drill
          testId="drill-kill"
          icon={<Unplug size={16} />}
          title="Kill the triage service"
          body="SIGKILL to the Python service's whole process group, mid-run. The supervisor restarts it about 6 s later. The attempt fails, the circuit opens so no attempts are spent while it is down, a health probe closes it, and the job finishes."
          button="Kill triage service"
          busy={busy === 'kill'}
          disabled={external}
          result={results.kill ?? (external ? 'Not available with AI_SERVICE_URL' : null)}
          onRun={() => run('kill', '/v2/ops/drills/kill-triage-service', (d) => (d.killed ? `Killed. Restart in ${Math.round(Number(d.restart_in_ms) / 1000)} s.` : 'Nothing to kill.'))}
        />
        <Drill
          testId="drill-lose"
          icon={<PlugZap size={16} />}
          title="Lose the next reply"
          body="The triage service finishes the next run and stores the result, then drops the connection before sending it. The retry carries the same Idempotency-Key and is served from the store: 0 new model runs."
          button="Lose next reply"
          busy={busy === 'lose'}
          result={results.lose ?? null}
          onRun={() => run('lose', '/v2/ops/drills/lose-next-reply', (d) => (d.armed ? 'Armed. File a claim (or let the queued one run).' : 'Could not reach the service.'))}
        />
        <Drill
          testId="drill-redeliver"
          icon={<Copy size={16} />}
          title="Redeliver ClaimFiled"
          body={
            <>
              Hands {selected ? <span className="font-mono">{selected.claim_number}</span> : 'the latest claim'}'s ClaimFiled event to every consumer again, as a broker would after a lost ack. Without inbox dedup it would queue a second paid run.
            </>
          }
          button="Redeliver event"
          busy={busy === 'redeliver'}
          result={results.redeliver ?? null}
          onRun={() =>
            run('redeliver', `/v2/ops/drills/redeliver-claim-filed${selected && !selected.historical ? `?claim_id=${selected.id}` : ''}`, (d) => {
              const rep = d.report as { consumers: { name: string; outcome: string }[] } | null;
              return rep ? rep.consumers.map((c) => `${c.name}: ${c.outcome}`).join(', ') : 'No event to redeliver yet.';
            })
          }
        />
        <div className="pt-2">
          <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-slate-800">
            <Skull size={15} className="text-rose-500" /> Dead-letter list
          </div>
          {dead === null ? (
            <Spinner className="text-slate-300" />
          ) : dead.length === 0 ? (
            <p className="text-[12px] text-slate-500">Empty. File "Corrupt telemetry export" to see a 422 land here.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="dead-letters">
              {dead.map((d) => (
                <li key={d.job_id}>
                  <button onClick={() => onOpenClaim(d.claim_id)} className="w-full rounded-lg bg-rose-50/60 px-3 py-2 text-left ring-1 ring-rose-100 hover:bg-rose-50">
                    <div className="flex justify-between text-[12px]">
                      <span className="font-mono font-medium text-slate-800">{d.claim_number}</span>
                      <span className="text-slate-500">
                        {d.attempts} attempt{d.attempts === 1 ? '' : 's'} · {relativeTime(d.updated_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] text-rose-800">{d.dead_reason}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Drawer>
  );
}

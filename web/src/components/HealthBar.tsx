import { Activity, Cpu, Inbox, ShieldAlert, ShieldCheck, ShieldQuestion, Skull, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Health } from '../types';
import { cx } from './ui';

function Item({ icon, label, value, tone = 'slate', testId }: { icon: ReactNode; label: string; value: ReactNode; tone?: 'slate' | 'emerald' | 'amber' | 'rose' | 'violet'; testId?: string }) {
  const dot = { slate: 'bg-slate-400', emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', violet: 'bg-violet-500' }[tone];
  return (
    <div className="flex items-center gap-2 px-3 text-xs" data-testid={testId}>
      <span className="text-slate-400">{icon}</span>
      <span className="text-slate-500">{label}</span>
      <span className="flex items-center gap-1.5 font-medium text-slate-800">
        <span className={cx('h-1.5 w-1.5 rounded-full', dot, tone === 'rose' && 'animate-pulse')} />
        {value}
      </span>
    </div>
  );
}

export function HealthBar({ health, connected }: { health: Health | null; connected: boolean }) {
  if (!health) {
    return <div className="flex h-10 shrink-0 items-center border-b border-slate-200 bg-slate-50 px-5 text-xs text-slate-500">Connecting to the API...</div>;
  }
  const svc = health.triage_service;
  const svcUp = svc.state === 'up';
  const restarting = svc.state === 'restarting' || svc.state === 'down';
  const circuit = health.circuit.state;
  return (
    <div className="flex h-10 shrink-0 items-center divide-x divide-slate-200 border-b border-slate-200 bg-slate-50/80 px-2">
      <Item icon={<Activity size={14} />} label="API" value={connected ? 'Up' : 'Reconnecting'} tone={connected ? 'emerald' : 'amber'} testId="health-api" />
      <Item
        icon={<Cpu size={14} />}
        label="Triage service"
        testId="health-service"
        tone={svcUp ? (svc.mode === 'live' ? 'emerald' : 'violet') : 'rose'}
        value={svcUp ? `Up, ${svc.mode === 'live' ? `live on ${svc.model}` : 'replay'}` : restarting ? `Down${svc.restart_in_ms != null ? `, restart in ${Math.ceil(svc.restart_in_ms / 1000)} s` : ''}` : svc.state}
      />
      <Item
        icon={circuit === 'closed' ? <ShieldCheck size={14} /> : circuit === 'open' ? <ShieldAlert size={14} /> : <ShieldQuestion size={14} />}
        label="Circuit"
        testId="health-circuit"
        tone={circuit === 'closed' ? 'emerald' : circuit === 'open' ? 'rose' : 'amber'}
        value={circuit === 'closed' ? 'Closed' : circuit === 'open' ? 'Open' : 'Half-open'}
      />
      <Item icon={<Workflow size={14} />} label="Queue" value={`${health.queue.queued} queued, ${health.queue.running} running`} tone={health.queue.running ? 'amber' : 'slate'} testId="health-queue" />
      <Item icon={<Skull size={14} />} label="Dead letters" value={health.dead_letters} tone={health.dead_letters ? 'rose' : 'slate'} testId="health-dlq" />
      <Item icon={<Inbox size={14} />} label="Model runs today" value={svc.model_runs ? `${svc.model_runs.live_today} live, ${svc.model_runs.today - svc.model_runs.live_today} replayed` : '-'} />
    </div>
  );
}

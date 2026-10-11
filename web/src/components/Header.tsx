import { BookOpen, FilePlus2, FlaskConical, Network, Zap } from 'lucide-react';
import { useRef } from 'react';
import type { Health } from '../types';
import { Badge, Button } from './ui';

export function Header({ health, onFile, onDrills, onInspector }: { health: Health | null; onFile: () => void; onDrills: () => void; onInspector: () => void }) {
  // Keep showing the last known mode while the triage service restarts.
  const lastMode = useRef<'live' | 'replay' | null>(null);
  if (health?.triage_service.mode) lastMode.current = health.triage_service.mode;
  const mode = lastMode.current;
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
          <Zap size={17} strokeWidth={2.4} />
        </div>
        <div className="leading-tight">
          <h1 className="text-[15px] font-semibold text-slate-900">Warranty Triage Console</h1>
          <p className="text-[11px] text-slate-500">Electric motorcycle claims, triaged by a Python agent behind a NestJS API</p>
        </div>
        <div className="ml-3 flex items-center gap-1.5">
          <Badge tone="amber">Synthetic data</Badge>
          {mode === 'live' && (
            <Badge tone="emerald">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> AI: live
            </Badge>
          )}
          {mode === 'replay' && <Badge tone="violet">Replay mode</Badge>}
        </div>
      </div>
      <nav className="flex items-center gap-2">
        <Button variant="ghost" onClick={onInspector} data-testid="open-inspector">
          <Network size={15} /> API inspector
        </Button>
        <Button variant="ghost" onClick={onDrills} data-testid="open-drills">
          <FlaskConical size={15} /> Fault drills
        </Button>
        <a href="/docs" target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100">
          <BookOpen size={15} /> API docs
        </a>
        <Button variant="primary" onClick={onFile} data-testid="open-file-claim">
          <FilePlus2 size={15} /> File claim as dealer
        </Button>
      </nav>
    </header>
  );
}

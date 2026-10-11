import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { ClaimStatus } from '../types';
import { STATUS_LABEL } from '../format';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

export function Button({ variant = 'secondary', size = 'md', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-600/20',
    secondary: 'bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 hover:ring-slate-300',
    ghost: 'text-slate-600 hover:bg-slate-100',
    danger: 'bg-white text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50',
    success: 'bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm shadow-emerald-600/20',
  };
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        styles[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const STATUS_STYLE: Record<ClaimStatus, string> = {
  filed: 'bg-slate-100 text-slate-700 ring-slate-200',
  triaging: 'bg-sky-50 text-sky-700 ring-sky-200',
  awaiting_review: 'bg-amber-50 text-amber-800 ring-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  rejected: 'bg-slate-100 text-slate-600 ring-slate-300',
  dead_lettered: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export function StatusPill({ status }: { status: ClaimStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset', STATUS_STYLE[status])}>
      {status === 'triaging' && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Badge({ tone = 'slate', children, className }: { tone?: 'slate' | 'amber' | 'emerald' | 'violet' | 'rose' | 'sky' | 'indigo'; children: ReactNode; className?: string }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 ring-slate-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200',
    rose: 'bg-rose-50 text-rose-700 ring-rose-200',
    sky: 'bg-sky-50 text-sky-700 ring-sky-200',
    indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone], className)}>{children}</span>;
}

export function Card({ title, icon, right, children, className, bodyClass }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('rounded-xl bg-white ring-1 ring-slate-200/80 shadow-sm', className)}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-slate-800">
            {icon}
            {title}
          </h3>
          {right}
        </header>
      )}
      <div className={cx('p-4', bodyClass)}>{children}</div>
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">{children}</code>;
}

export function Drawer({ title, subtitle, onClose, children, width = 'w-[560px]' }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; width?: string }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/20 backdrop-blur-[1px]" onClick={onClose}>
      <aside className={cx('animate-drawer-in flex h-full flex-col bg-white shadow-2xl ring-1 ring-slate-200', width)} onClick={(e) => e.stopPropagation()}>
        <header className="flex items-start justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100" aria-label="Close">
            Close
          </button>
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  );
}

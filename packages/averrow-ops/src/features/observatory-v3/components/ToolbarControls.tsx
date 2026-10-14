/**
 * Toolbar parts: period segmented control, source select, refresh button and the
 * filters popover that holds period + source when the toolbar is too narrow for
 * them inline (and on phones, where the summary button is that popover's trigger).
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PERIOD_IDS, SOURCE_IDS, type Period, type Source } from '../lib/url-state';

export const PERIOD_LABELS: Record<Period, string> = { '24h': '24H', '7d': '7D', '30d': '30D', '90d': '90D' };
export const SOURCE_LABELS: Record<Source, string> = { all: 'All sources', feeds: 'Feeds', spam_trap: 'Spam trap' };

const GLASS = {
  background: 'var(--bg-card)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  border: '1px solid var(--border-base)',
  boxShadow: 'var(--card-shadow)',
} as const;

/** 24H · 7D · 30D · 90D. A radio group: arrow keys move AND select (the choice is cheap and reversible). */
export function PeriodSegment({ period, onChange, touch = false, className }: { period: Period; onChange: (p: Period) => void; touch?: boolean; className?: string }) {
  const refs = useRef(new Map<Period, HTMLButtonElement>());
  const move = (e: React.KeyboardEvent, i: number) => {
    let n = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % PERIOD_IDS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + PERIOD_IDS.length) % PERIOD_IDS.length;
    if (n < 0) return;
    e.preventDefault();
    const id = PERIOD_IDS[n]!;
    onChange(id);
    refs.current.get(id)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Period"
      className={cn('inline-flex items-center gap-[3px] rounded-xl p-[3px]', className)}
      style={{ ...GLASS, height: touch ? 48 : 40 }}
    >
      {PERIOD_IDS.map((id, i) => {
        const on = id === period;
        return (
          <button
            key={id}
            ref={el => { if (el) refs.current.set(id, el); else refs.current.delete(id); }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={e => move(e, i)}
            className={cn('ds-focusable rounded-[9px] px-2.5 font-mono text-[11px] font-bold tracking-[0.06em] cursor-pointer transition-[background,color] duration-150 motion-reduce:transition-none', touch ? 'min-h-[42px] min-w-[44px]' : 'min-h-[32px]')}
            style={{
              border: `1px solid ${on ? 'var(--pill-active-border)' : 'transparent'}`,
              background: on ? 'linear-gradient(135deg, var(--amber-glow), var(--pill-active-fill-2-strong))' : 'transparent',
              color: on ? 'var(--amber-text)' : 'var(--text-secondary)',
            }}
          >
            {PERIOD_LABELS[id]}
          </button>
        );
      })}
    </div>
  );
}

export function SourceSelect({ source, onChange, touch = false, className }: { source: Source; onChange: (s: Source) => void; touch?: boolean; className?: string }) {
  return (
    <label className={cn('relative inline-flex items-center', className)} style={{ ...GLASS, borderRadius: 12, height: touch ? 48 : 40 }}>
      <span className="sr-only">Source</span>
      <select
        aria-label="Source"
        value={source}
        onChange={e => onChange(e.target.value as Source)}
        className="ds-focusable appearance-none bg-transparent font-mono text-[11px] font-bold cursor-pointer h-full pl-3 pr-8 rounded-xl [color-scheme:inherit]"
        style={{ color: 'var(--text-secondary)', border: 'none', minWidth: touch ? 120 : 104 }}
      >
        {SOURCE_IDS.map(id => <option key={id} value={id}>{SOURCE_LABELS[id]}</option>)}
      </select>
      <ChevronDown size={13} aria-hidden className="pointer-events-none absolute right-2.5" style={{ color: 'var(--text-tertiary)' }} />
    </label>
  );
}

export function RefreshButton({ onClick, busy, touch = false, className }: { onClick: () => void; busy: boolean; touch?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Refresh Observatory data"
      title="Refresh"
      aria-busy={busy}
      className={cn('ds-focusable inline-flex items-center justify-center rounded-xl transition-colors motion-reduce:transition-none shrink-0', className)}
      style={{ ...GLASS, width: touch ? 48 : 40, height: touch ? 48 : 40, color: busy ? 'var(--amber-text)' : 'var(--text-secondary)', cursor: 'pointer' }}
    >
      <RefreshCw size={14} className={busy ? 'animate-spin motion-reduce:animate-none' : ''} />
    </button>
  );
}

/** Period + source behind one button ("7D · All sources"). The popover closes on Escape and on an outside press. */
export function FiltersPopover({
  period, source, children, touch = false, className, align = 'right', triggerClassName,
}: { period: Period; source: Source; children: ReactNode; touch?: boolean; className?: string; align?: 'left' | 'right'; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        aria-label={`Filters: ${PERIOD_LABELS[period]}, ${SOURCE_LABELS[source]}`}
        onClick={() => setOpen(o => !o)}
        className={cn('ds-focusable inline-flex items-center gap-2 rounded-xl px-3 font-mono text-[11px] cursor-pointer', triggerClassName)}
        style={{ ...GLASS, height: touch ? 48 : 40, color: 'var(--text-secondary)' }}
      >
        <span style={{ color: 'var(--amber-text)' }}>{PERIOD_LABELS[period]}</span>
        <span aria-hidden style={{ color: 'var(--text-tertiary)' }}>·</span>
        <span className="truncate max-w-[110px]" style={{ color: 'var(--amber-text)' }}>{SOURCE_LABELS[source]}</span>
        <ChevronDown size={13} aria-hidden className={cn('shrink-0 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-180')} style={{ color: 'var(--text-tertiary)' }} />
      </button>
      <div
        id={id}
        role="dialog"
        aria-label="Filters"
        hidden={!open}
        className={cn('absolute top-full mt-2 z-40 w-[min(320px,calc(100vw-24px))] rounded-xl p-3 flex flex-col gap-3 animate-sheet-in motion-reduce:animate-none', align === 'right' ? 'right-0' : 'left-0')}
        style={{ background: 'var(--bg-card-deep)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', border: '1px solid var(--border-base)', boxShadow: 'var(--card-shadow-elevated)' }}
      >
        {children}
      </div>
    </div>
  );
}

export const FILTER_LABEL = 'font-mono text-[10px] uppercase tracking-wider';

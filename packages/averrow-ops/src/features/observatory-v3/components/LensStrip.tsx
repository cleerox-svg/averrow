/**
 * Lens strip: one tab per question the map answers. A lens is the single
 * exclusive primary question, so exactly one is selected.
 *
 * Keyboard: Left/Right/Home/End MOVE focus, Enter/Space ACTIVATES (manual
 * activation) — arrowing across the strip must not fire a data request for every
 * lens it passes. A click or tap activates at once.
 *
 * Narrow screens: the strip scrolls horizontally; the ends fade out under an edge
 * mask with chevrons that page it, and the active tab is scrolled into view when
 * it changes. Tabs are 44px high on touch.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePrefersReducedMotion } from '../lib/use-motion';
import { LENS_DEFS, LENS_IDS, type LensId } from '../lib/lenses';

export interface LensStripProps {
  lens: LensId;
  onChange: (lens: LensId) => void;
  /** 44px tabs (phone / coarse pointer). */
  touch?: boolean;
  className?: string;
}

const EDGE = 28;

export function LensStrip({ lens, onChange, touch = false, className }: LensStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<LensId, HTMLButtonElement>());
  const reduced = usePrefersReducedMotion();
  const [edges, setEdges] = useState({ left: false, right: false });
  // Roving tab stop: arrow keys move it without selecting.
  const [rove, setRove] = useState<LensId | null>(null);
  const stop = rove ?? lens;

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { left: el.scrollLeft > 1, right: max > 1 && el.scrollLeft < max - 1 };
    setEdges(prev => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect(); };
  }, [measure]);

  // The active tab is always in view (a deep link to ?lens=actors on a phone).
  useEffect(() => {
    const tab = tabRefs.current.get(lens);
    if (tab && typeof tab.scrollIntoView === 'function') {
      tab.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }
  }, [lens, reduced]);

  const page = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: reduced ? 'auto' : 'smooth' });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % LENS_IDS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + LENS_IDS.length) % LENS_IDS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = LENS_IDS.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onChange(LENS_IDS[index]!);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    const id = LENS_IDS[next]!;
    setRove(id);
    tabRefs.current.get(id)?.focus();
  };

  const mask = `linear-gradient(90deg, ${edges.left ? 'transparent 0, #000 ' + EDGE + 'px' : '#000 0'}, ${edges.right ? '#000 calc(100% - ' + EDGE + 'px), transparent 100%' : '#000 100%'})`;

  return (
    <div
      className={cn('relative min-w-0 flex items-center rounded-xl', className)}
      style={{
        background: 'var(--bg-card)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--border-base)',
        boxShadow: 'var(--card-shadow)',
        height: touch ? 48 : 40,
      }}
    >
      <div
        ref={scrollRef}
        role="tablist"
        aria-label="Observatory lens"
        aria-orientation="horizontal"
        onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRove(null); }}
        className="flex items-center gap-[3px] px-1 overflow-x-auto min-w-0 h-full"
        style={{ scrollbarWidth: 'none', WebkitMaskImage: mask, maskImage: mask }}
      >
        {LENS_IDS.map((id, i) => {
          const active = id === lens;
          return (
            <button
              key={id}
              ref={el => { if (el) tabRefs.current.set(id, el); else tabRefs.current.delete(id); }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={id === stop ? 0 : -1}
              title={LENS_DEFS[id].question}
              onClick={() => onChange(id)}
              onFocus={() => setRove(id)}
              onKeyDown={e => onKeyDown(e, i)}
              className={cn(
                'ds-focusable shrink-0 inline-flex items-center justify-center whitespace-nowrap rounded-[9px] px-3 font-mono text-[11px] font-bold tracking-[0.06em] cursor-pointer',
                'transition-[background,color,box-shadow] duration-150 motion-reduce:transition-none',
                touch ? 'min-h-[44px]' : 'min-h-[32px]',
              )}
              style={{
                border: `1px solid ${active ? 'var(--pill-active-border)' : 'transparent'}`,
                background: active ? 'linear-gradient(135deg, var(--amber-glow), var(--pill-active-fill-2-strong))' : 'transparent',
                color: active ? 'var(--amber-text)' : 'var(--text-secondary)',
                boxShadow: active ? 'inset 0 1px 0 var(--pill-active-rim-strong), 0 0 12px var(--amber-glow)' : 'none',
              }}
            >
              {LENS_DEFS[id].label}
            </button>
          );
        })}
      </div>
      {(['left', 'right'] as const).map(side => edges[side] && (
        <button
          key={side}
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => page(side === 'left' ? -1 : 1)}
          className={cn('absolute top-0 bottom-0 inline-flex items-center justify-center', side === 'left' ? 'left-0 rounded-l-xl' : 'right-0 rounded-r-xl')}
          style={{ width: touch ? 28 : 22, background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          {side === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      ))}
      <span className="sr-only" aria-live="polite">{LENS_DEFS[lens].question}</span>
    </div>
  );
}

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
import { LABEL } from '../lib/chrome-classes';

export interface LensStripProps {
  lens: LensId;
  onChange: (lens: LensId) => void;
  /** 44px tabs (phone / coarse pointer). */
  touch?: boolean;
  /** id of the map region the selected lens redraws: every tab names it with aria-controls. */
  controls?: string;
  className?: string;
}

export function LensStrip({ lens, onChange, touch = false, controls, className }: LensStripProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<LensId, HTMLButtonElement>());
  const reduced = usePrefersReducedMotion();
  const [edges, setEdges] = useState({ overflowing: false, left: false, right: false });
  // Roving tab stop: arrow keys move it without selecting.
  const [rove, setRove] = useState<LensId | null>(null);
  const stop = rove ?? lens;

  const measure = useCallback(() => {
    const el = scrollRef.current;
    const outer = outerRef.current;
    if (!el || !outer) return;
    // Does the row of tabs fit the strip? Measured from the tabs themselves and the strip's OUTER width, never from the
    // scroller (whose width changes when the chevron slots appear), so showing the slots cannot flip the answer back.
    const ids = LENS_IDS.map(id => tabRefs.current.get(id)).filter((t): t is HTMLButtonElement => !!t);
    const first = ids[0];
    const last = ids[ids.length - 1];
    const contentW = first && last ? last.offsetLeft + last.offsetWidth - first.offsetLeft + 8 : 0;
    const overflowing = outer.clientWidth > 0 && contentW > outer.clientWidth - 2;
    const max = el.scrollWidth - el.clientWidth;
    const next = { overflowing, left: overflowing && el.scrollLeft > 1, right: overflowing && max > 1 && el.scrollLeft < max - 1 };
    setEdges(prev => (prev.overflowing === next.overflowing && prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (outerRef.current) ro?.observe(outerRef.current);
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect(); };
  }, [measure]);

  // The active tab is always in view, centred so it is not under the edge fade (a deep link to ?lens=actors on a phone).
  useEffect(() => {
    const tab = tabRefs.current.get(lens);
    if (tab && typeof tab.scrollIntoView === 'function') {
      tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
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

  const chevron = touch ? 28 : 24;
  // When the tabs do not fit, both paging slots are reserved (the chevron inside shows only while that side has more to
  // scroll to). The slots are flex siblings of the scroller, never laid over it, so tab text can not sit under a chevron.
  const slot = (side: 'left' | 'right') => edges.overflowing && (
    <span key={side} className="shrink-0 inline-flex items-center justify-center" style={{ width: chevron }}>
      {edges[side] && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => page(side === 'left' ? -1 : 1)}
          className="inline-flex items-center justify-center w-full h-full"
          style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          {side === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      )}
    </span>
  );

  return (
    <div
      ref={outerRef}
      className={cn('relative min-w-0 flex items-center rounded-xl', className)}
      style={{
        background: 'var(--bg-card)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--border-base)',
        boxShadow: 'var(--card-shadow-elevated)',
        height: touch ? 48 : 40,
      }}
    >
      {slot('left')}
      <div
        ref={scrollRef}
        role="tablist"
        aria-label="Observatory lens"
        aria-orientation="horizontal"
        onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setRove(null); }}
        className="flex items-center gap-[3px] px-1 overflow-x-auto min-w-0 flex-1 h-full"
        style={{ scrollbarWidth: 'none' }}
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
              aria-controls={controls}
              tabIndex={id === stop ? 0 : -1}
              title={LENS_DEFS[id].question}
              onClick={() => onChange(id)}
              onFocus={() => setRove(id)}
              onKeyDown={e => onKeyDown(e, i)}
              className={cn(
                'ds-focusable shrink-0 inline-flex items-center justify-center whitespace-nowrap rounded-[9px] px-2.5 font-semibold cursor-pointer',
                LABEL,
                'transition-[background,color] duration-150 motion-reduce:transition-none',
                touch ? 'min-h-[44px]' : 'min-h-[32px]',
                // the active tab's border would double the focus ring: the ring replaces it while focused
                'focus-visible:!border-transparent',
              )}
              style={{
                border: `1px solid ${active ? 'var(--primary-border)' : 'transparent'}`,
                background: active ? 'var(--primary-tint)' : 'transparent',
                color: active ? 'var(--primary-text)' : 'var(--text-secondary)',
              }}
            >
              {LENS_DEFS[id].label}
            </button>
          );
        })}
      </div>
      {slot('right')}
      <span className="sr-only" aria-live="polite">{LENS_DEFS[lens].question}</span>
    </div>
  );
}

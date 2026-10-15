/**
 * Headline bar — the Observatory footer's intel feed. One threat event at a time,
 * as the sentence the server wrote for it, with its kind tag and age.
 *
 *   rotation   every 6 s; a CRITICAL event holds for 12 s, goes first in the queue,
 *              and a critical one that arrives while you watch jumps in at once
 *   control    previous / next / pause; hover and keyboard focus also hold it
 *   a11y       one polite announcement per event (the visible text is not a live
 *              region, so its age ticking never re-announces); reduced motion = no
 *              slide, no auto-advance, no jump: manual stepping only
 *   states     empty ("No new threat events in the last hour"), loading, failed,
 *              and a quiet PARTIAL tag when the server could not read some kinds
 *   click      the headline asks the page to fly to the event and open its drawer;
 *              "All N" opens the event rail
 *
 * It owns no data: the page hands it the query result.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RefreshCw } from 'lucide-react';
import { usePageVisible } from '../lib/use-motion';
import { useNow } from '../lib/use-now';
import {
  KIND_SPOKEN, eventAge, eventAgeSpoken, freshCriticals, holdFor, orderQueue, stepIndex, totalCount, KIND_CHIP_LABEL,
  type EventsResult, type ObservatoryEvent,
} from '../lib/events';
import { EventChip } from './EventChip';

export const EMPTY_COPY = 'No new threat events in the last hour';

export interface HeadlineBarProps {
  /** Query result; `undefined` until the first load. */
  result: EventsResult | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Click on the headline: fly there, apply the target, open the drawer. */
  onOpenEvent: (e: ObservatoryEvent) => void;
  /** "All N ›". Omitted = no rail to open here, so no pill. */
  onOpenAll?: () => void;
  /** Phone: two rows in the 72px band. */
  phone?: boolean;
  reducedMotion: boolean;
}

const ICON_BTN =
  'ds-focusable inline-flex shrink-0 items-center justify-center rounded-md transition-colors motion-reduce:transition-none ' +
  'hover:bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]';

export function HeadlineBar({ result, loading, error, onRetry, onOpenEvent, onOpenAll, phone = false, reducedMotion }: HeadlineBarProps) {
  const now = useNow(30_000);
  const visible = usePageVisible();
  const events = result?.events;
  const queue = useMemo(() => orderQueue(events ?? []), [events]);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [userPaused, setUserPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const found = currentId === null ? -1 : queue.findIndex(e => e.id === currentId);
  const current: ObservatoryEvent | null = found >= 0 ? queue[found]! : queue[0] ?? null;
  const index = current ? (found >= 0 ? found : 0) : -1;

  // The displayed event is the tracked one (it falls back to the head of the queue when the current one drops out).
  useEffect(() => {
    if (current && current.id !== currentId) setCurrentId(current.id);
  }, [current, currentId]);

  const holding = userPaused || hovered || focused;
  const holdingRef = useRef(holding);
  holdingRef.current = holding;

  // A critical event that was not in the queue before jumps it. The first batch only seeds the seen-set. Never while
  // someone is holding the bar, and never under reduced motion (nothing moves on its own there).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!result) return;
    if (seen.current === null) { seen.current = new Set(queue.map(e => e.id)); return; }
    const fresh = freshCriticals(queue, seen.current);
    for (const e of queue) seen.current.add(e.id);
    if (fresh.length > 0 && !reducedMotion && !holdingRef.current) setCurrentId(fresh[0]!.id);
  }, [queue, result, reducedMotion]);

  // Auto-advance: one timer per displayed event; holding or hiding the tab cancels it and the hold restarts on release.
  const running = !!current && queue.length > 1 && !reducedMotion && !holding && visible;
  const currentKey = current?.id ?? null;
  const currentHold = current ? holdFor(current) : 0;
  useEffect(() => {
    if (!running || currentKey === null) return;
    const t = setTimeout(() => {
      const q = queueRef.current;
      const next = q[stepIndex(q, currentKey, 1)];
      if (next) setCurrentId(next.id);
    }, currentHold);
    return () => clearTimeout(t);
  }, [running, currentKey, currentHold]);

  // Each event is announced once, politely; stepping by hand to one already heard announces it again (you asked for it).
  const announced = useRef(new Set<string>());
  const manualStep = useRef(false);
  useEffect(() => {
    if (!current) return;
    const again = manualStep.current;
    manualStep.current = false;
    if (announced.current.has(current.id) && !again) return;
    announced.current.add(current.id);
    setAnnouncement(`${KIND_SPOKEN[current.kind]}: ${current.title}`);
  }, [current]);

  const step = useCallback((dir: 1 | -1) => {
    const q = queueRef.current;
    const i = stepIndex(q, currentKey, dir);
    if (i < 0) return;
    manualStep.current = true;
    setCurrentId(q[i]!.id);
  }, [currentKey]);

  const total = result ? totalCount(result.counts, result.events.length) : 0;
  const failed = result?.meta.failed_kinds ?? [];
  const showControls = !!current;

  const live = (
    // Just the dot: the shell's top bar owns the LIVE badge (a test pins that the Observatory renders no second one).
    <span className="flex shrink-0 items-center" title="Live feed">
      <span className="ev-live-dot" aria-hidden="true" />
    </span>
  );

  const controls = showControls && current && (
    <div className="flex shrink-0 items-center gap-0.5">
      {queue.length > 1 && (
        <>
          <button type="button" className={`${ICON_BTN} ${phone ? 'h-9 w-9' : 'h-7 w-7'}`} style={{ color: 'var(--text-tertiary)' }} onClick={() => step(-1)} aria-label="Previous event">
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span className="min-w-[44px] text-center font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }} aria-label={`Event ${index + 1} of ${queue.length}`}>
            {index + 1} / {queue.length}
          </span>
          <button type="button" className={`${ICON_BTN} ${phone ? 'h-9 w-9' : 'h-7 w-7'}`} style={{ color: 'var(--text-tertiary)' }} onClick={() => step(1)} aria-label="Next event">
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          {!reducedMotion && (
            <button
              type="button"
              className={`${ICON_BTN} ${phone ? 'h-9 w-9' : 'h-7 w-7'}`}
              style={{ color: userPaused ? 'var(--amber-text)' : 'var(--text-tertiary)' }}
              onClick={() => setUserPaused(p => !p)}
              aria-pressed={userPaused}
              aria-label={userPaused ? 'Resume rotation' : 'Pause rotation'}
            >
              {userPaused ? <Play size={12} aria-hidden="true" /> : <Pause size={12} aria-hidden="true" />}
            </button>
          )}
        </>
      )}
      {failed.length > 0 && (
        <span
          data-testid="events-partial"
          className="ml-1 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide"
          style={{ color: 'var(--text-muted)', border: '1px dashed var(--border-base)' }}
          title={`Some event kinds could not be loaded: ${failed.map(k => KIND_CHIP_LABEL[k].toLowerCase()).join(', ')}`}
        >
          PARTIAL
          <span className="sr-only"> — {failed.map(k => KIND_CHIP_LABEL[k].toLowerCase()).join(', ')} could not be loaded</span>
        </span>
      )}
      {onOpenAll && (
        <button
          type="button"
          onClick={onOpenAll}
          className={`ds-focusable ml-1 shrink-0 rounded-full px-2.5 font-mono text-[11px] ${phone ? 'min-h-[32px]' : 'py-0.5'}`}
          style={{ color: 'var(--amber-text)', border: '1px solid var(--amber-border)', background: 'var(--amber-glow)', cursor: 'pointer' }}
          aria-label={`Open all ${total} events`}
        >
          All {total} ›
        </button>
      )}
    </div>
  );

  const headline = current ? (
    <div className={`flex min-w-0 flex-1 gap-2.5 ${phone ? 'items-start' : 'items-center'}`}>
      {/* Re-keyed per event so the slide-in plays once; reduced motion has no animation class at all. */}
      <button
        key={current.id}
        type="button"
        onClick={() => onOpenEvent(current)}
        className={`ds-focusable flex min-w-0 flex-1 gap-2.5 rounded text-left ${phone ? 'items-start' : 'items-center'} ${reducedMotion ? '' : 'ev-hl-enter'}`}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)' }}
        title={current.title}
      >
        <EventChip kind={current.kind} className={phone ? 'self-start' : ''} />
        {/* A phone has two lines of room: the sentence is never cut mid-thought there. */}
        <span className={`min-w-0 flex-1 ${phone ? 'line-clamp-2 text-[12px] leading-[15px]' : 'truncate text-[13px]'}`} data-testid="headline-title">{current.title}</span>
      </button>
      <span className={`shrink-0 font-mono text-[11px] tabular-nums ${phone ? 'pt-0.5' : ''}`} style={{ color: 'var(--text-tertiary)' }} title={eventAgeSpoken(current.occurred_at, now)}>
        {eventAge(current.occurred_at, now)}
      </span>
    </div>
  ) : error && !result ? (
    <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
      <span role="status">Event feed unavailable</span>
      <button type="button" onClick={onRetry} className="ds-focusable inline-flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: 'none', border: '1px solid var(--border-base)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
        <RefreshCw size={10} aria-hidden="true" /> Retry
      </button>
    </div>
  ) : (
    <div className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }} role="status" data-testid={loading || !result ? 'events-loading' : 'events-empty'}>
      {loading || !result ? 'Loading events…' : EMPTY_COPY}
    </div>
  );

  return (
    <section
      aria-label="Live threat events"
      className="relative h-full overflow-hidden"
      style={{ background: 'var(--bg-card-deep)', borderTop: '1px solid var(--border-base)' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
    >
      {phone ? (
        <div className="flex h-full flex-col px-3">
          <div className="flex min-h-[34px] flex-1 items-center pt-1">{headline}</div>
          <div className="flex h-9 shrink-0 items-center justify-between gap-2">
            {live}
            {controls}
          </div>
        </div>
      ) : (
        <div className="flex h-full items-center gap-3 px-3">
          {live}
          {headline}
          {controls}
        </div>
      )}

      {running && current && (
        <div key={current.id} className="ev-progress" style={{ animationDuration: `${currentHold}ms` }} aria-hidden="true" data-testid="headline-progress" />
      )}

      {/* The one announcement per event. Separate from the visible text so the ticking age never re-announces. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="headline-announce">{announcement}</div>
    </section>
  );
}

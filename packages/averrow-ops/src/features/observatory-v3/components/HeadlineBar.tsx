/**
 * Headline bar — the Observatory footer's intel feed. One threat event at a time,
 * as the sentence the server wrote for it, with its kind tag and age.
 *
 *   rotation   every 6 s; a CRITICAL event holds for 12 s, goes first in the queue,
 *              and a critical one that arrives while you watch jumps in at once
 *   control    previous / next / pause. A MOUSE hovering the bar and KEYBOARD focus
 *              (:focus-visible) also hold it; a click or a tap does not (a tap
 *              leaves no pointer, a click leaves a focused button: neither is an
 *              intent to read). While held (not paused) a "Held" cue shows and the
 *              progress track dims, so a stalled bar is never a mystery
 *   a11y       a polite announcement for each CRITICAL event and each manual step,
 *              not every rotation (the visible text is not a live region, so its age
 *              ticking never re-announces); reduced motion = no slide, no
 *              auto-advance, no jump: manual stepping only
 *   touch      coarse pointers: every control is 44px (extended hit areas inside the
 *              72px phone band), 8px apart
 *   states     empty (copy true to the server window), loading, failed, and a
 *              focusable PARTIAL tag that names the kinds the server could not read
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
  KIND_SPOKEN, eventAge, eventAgeSpoken, emptyFeedCopy, freshCriticals, holdFor, orderQueue, stepIndex, totalCount, KIND_CHIP_LABEL,
  type EventsResult, type ObservatoryEvent,
} from '../lib/events';
import { EventChip } from './EventChip';
import { EventTitle } from './EventTitle';

/** The bar always shows the 1h request, so this is its empty sentence. */
export const EMPTY_COPY = emptyFeedCopy('1h');

/** `:focus-visible` = keyboard (or programmatic-after-keyboard) focus; a mouse click or a tap on a button is not. */
function focusVisible(el: EventTarget | null): boolean {
  try { return !!el && (el as Element).matches(':focus-visible'); } catch { return false; }
}

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

// `ev-hit` (index.css) gives a coarse pointer a 44px-wide button and a 44px-tall hit area past the visual.
const ICON_BTN =
  'ds-focusable ev-hit inline-flex shrink-0 items-center justify-center rounded-md transition-colors motion-reduce:transition-none ' +
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
  const [partialOpen, setPartialOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const found = currentId === null ? -1 : queue.findIndex(e => e.id === currentId);
  const current: ObservatoryEvent | null = found >= 0 ? queue[found]! : queue[0] ?? null;
  const index = current ? (found >= 0 ? found : 0) : -1;

  // The displayed event is the tracked one (it falls back to the head of the queue when the current one drops out).
  useEffect(() => {
    if (current && current.id !== currentId) setCurrentId(current.id);
  }, [current, currentId]);

  const heldByReader = hovered || focused; // a mouse over the bar / keyboard focus in it (not the pause button)
  const holding = userPaused || heldByReader;
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

  // Announced politely: each CRITICAL event once as it comes up, and any event you step to by hand (you asked for it, even
  // one already heard). Ordinary rotation stays silent: a new sentence every 6 s would talk over a screen reader.
  const announced = useRef(new Set<string>());
  const manualStep = useRef(false);
  useEffect(() => {
    if (!current) return;
    const manual = manualStep.current;
    manualStep.current = false;
    if (!manual && (current.severity !== 'critical' || announced.current.has(current.id))) return;
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
    // Just the dot (decoration, hidden from assistive tech): the shell's top bar owns the LIVE badge (a test pins that the
    // Observatory renders no second one).
    <span className="flex shrink-0 items-center" title="Live feed" aria-hidden="true">
      <span className="ev-live-dot" />
    </span>
  );

  const rotating = queue.length > 1 && !reducedMotion;
  const showHeld = rotating && heldByReader && !userPaused;
  const failedNames = failed.map(k => KIND_CHIP_LABEL[k].toLowerCase()).join(', ');
  const btnSize = phone ? 'h-10 w-10' : 'h-7 w-7';

  const controls = showControls && current && (
    <div className="flex shrink-0 items-center gap-0.5 [@media(pointer:coarse)]:gap-2">
      {/* To the LEFT of the buttons, so showing it never moves a control out from under the pointer. */}
      {showHeld && (
        <span
          data-testid="headline-held"
          aria-hidden="true"
          className="mr-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: 'var(--text-secondary)' }}
          title="Rotation is held while you hover or use the keyboard here"
        >
          Held
        </span>
      )}
      {queue.length > 1 && (
        <>
          <button type="button" className={`${ICON_BTN} ${btnSize}`} style={{ color: 'var(--text-secondary)' }} onClick={() => step(-1)} aria-label="Previous event">
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <span className="min-w-[44px] text-center font-mono text-[11px] tabular-nums [@media(pointer:coarse)]:min-w-[40px]" style={{ color: 'var(--text-secondary)' }}>
            <span className="sr-only">Event {index + 1} of {queue.length}</span>
            <span aria-hidden="true">{index + 1} / {queue.length}</span>
          </span>
          <button type="button" className={`${ICON_BTN} ${btnSize}`} style={{ color: 'var(--text-secondary)' }} onClick={() => step(1)} aria-label="Next event">
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          {!reducedMotion && (
            <button
              type="button"
              className={`${ICON_BTN} ${btnSize}`}
              style={{ color: userPaused ? 'var(--amber-text)' : 'var(--text-secondary)' }}
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
        // Focusable: the kinds are in its tooltip, in its accessible name, and (on click / keyboard activation) on screen.
        <button
          type="button"
          data-testid="events-partial"
          onClick={() => setPartialOpen(o => !o)}
          aria-expanded={partialOpen}
          className="ds-focusable ev-hit ml-1 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide"
          style={{ color: 'var(--text-secondary)', border: '1px dashed var(--border-base)', background: 'none', cursor: 'pointer' }}
          title={`Some event kinds could not be loaded: ${failedNames}`}
        >
          PARTIAL
          <span className="sr-only"> — {failedNames} could not be loaded</span>
          {partialOpen && <span aria-hidden="true"> · {failedNames}</span>}
        </button>
      )}
      {onOpenAll && (
        <button
          type="button"
          onClick={onOpenAll}
          className={`ds-focusable ev-hit ml-1 shrink-0 rounded-full px-2.5 font-mono text-[11px] ${phone ? 'py-1.5' : 'py-0.5'}`}
          style={{ color: 'var(--amber-text)', border: '1px solid var(--amber-border)', background: 'var(--amber-glow)', cursor: 'pointer' }}
          aria-label={`Open all ${total} events`}
          title={`${total} records across ${queue.length} ${queue.length === 1 ? 'item' : 'items'}`}
        >
          {phone ? `All ${total} ›` : `All ${total} events ›`}
        </button>
      )}
    </div>
  );

  const headline = current ? (
    <div className={`flex min-w-0 flex-1 gap-2.5 ${phone ? 'items-start' : 'items-center'}`}>
      {/* Re-keyed per event so the slide-in plays once; reduced motion has no animation class at all. (No clipping wrapper:
          it would also clip the button's extended touch hit area.) */}
      <div className="min-w-0 flex-1">
        <button
          key={current.id}
          type="button"
          onClick={() => onOpenEvent(current)}
          className={`ds-focusable ev-hit-y flex w-full min-w-0 gap-2.5 rounded text-left ${phone ? 'items-start' : 'items-center'} ${reducedMotion ? '' : 'ev-hl-enter'}`}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)' }}
          title={current.title}
        >
          <EventChip kind={current.kind} className={phone ? 'self-start' : ''} />
          {/* A phone has two lines of room: the sentence is never cut mid-thought there. */}
          <span className={`min-w-0 flex-1 ${phone ? 'line-clamp-2 text-[12px] leading-[15px]' : 'truncate text-[13px]'}`} data-testid="headline-title">
            <EventTitle title={current.title} name={current.entity.name} />
          </span>
        </button>
      </div>
      <span className={`shrink-0 font-mono text-[11px] tabular-nums ${phone ? 'pt-0.5' : ''}`} style={{ color: 'var(--text-secondary)' }} title={eventAgeSpoken(current.occurred_at, now)}>
        {eventAge(current.occurred_at, now)}
      </span>
    </div>
  ) : (error && !result) || (result && failed.length > 0) ? (
    // No event to show AND something failed: never read as a quiet feed. (Some kinds failed with nothing from the rest, or
    // every kind failed; the PARTIAL tag lives with the controls, which only exist when there is an event.)
    <div className="flex min-w-0 flex-1 items-center gap-2 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }} data-testid="events-failed">
      <span role="status" className="truncate">
        {result ? `Event feed partly unavailable (${failedNames} could not be loaded)` : 'Event feed unavailable'}
      </span>
      <button type="button" onClick={onRetry} className="ds-focusable ev-hit inline-flex items-center gap-1 rounded px-1.5 py-0.5" style={{ background: 'none', border: '1px solid var(--border-base)', color: 'var(--text-secondary)', cursor: 'pointer' }}>
        <RefreshCw size={10} aria-hidden="true" /> Retry
      </button>
    </div>
  ) : (
    <div className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }} role="status" data-testid={loading || !result ? 'events-loading' : 'events-empty'}>
      {loading || !result ? 'Loading events…' : EMPTY_COPY}
    </div>
  );

  return (
    <section
      aria-label="Live threat events"
      className="relative h-full"
      style={{ background: 'var(--bg-card-deep)', borderTop: '1px solid var(--border-base)' }}
      // Pointer events, mouse only: a tap synthesises enter without a leave, which used to freeze the bar for good.
      onPointerEnter={e => { if (e.pointerType === 'mouse') setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      // Keyboard focus only (:focus-visible): a click leaves focus on the button, and that is not a request to hold.
      onFocus={e => setFocused(focusVisible(e.target))}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}
    >
      {phone ? (
        <div className="flex h-full flex-col px-3">
          <div className="flex min-h-[30px] flex-1 items-center">{headline}</div>
          <div className="flex h-10 shrink-0 items-center justify-between gap-2">
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
      {/* Held by a reader: the progress track stays, dimmed and still, instead of vanishing. */}
      {showHeld && <div className="ev-progress-held" aria-hidden="true" data-testid="headline-held-track" />}

      {/* The one announcement per event. Separate from the visible text so the ticking age never re-announces. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="headline-announce">{announcement}</div>
    </section>
  );
}

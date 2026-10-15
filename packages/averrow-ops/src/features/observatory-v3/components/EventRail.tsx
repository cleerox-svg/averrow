/**
 * Event rail — the full intel feed as a list you can filter and scroll. Lives as a
 * tab beside the intelligence panel (docked / floating, inside `PanelDock`) and in
 * the phone peek sheet.
 *
 *   groups   Last 15 min · 15–45 min · Older (newest first inside each)
 *   filter   kind chips, kept in the URL as `ev`; a kind the server withheld for
 *            this role (`meta.omitted_kinds`, e.g. takedown) has no chip and is
 *            dropped from a link that names it. A chip's number is RECORDS (the
 *            list holds grouped items), so its title / name spells both
 *   period   1h · 24h · 7d radio group (arrow keys move and select; 7d polls every 5 minutes at most)
 *   rows     severity dot + word, bold entity, kind chip, "via source", age; a NEW row flashes once
 *   close    the ✕ returns to the Intel tab
 *   click    hands the event to the page (fly there, apply its target, ping the spot)
 *
 * With a filter on, rows come from a `kinds=` request so a quiet kind is not
 * crowded out of the 40-row page by a loud one; the chip counts always come from the
 * unfiltered request (which the headline bar shares at 1h, so that costs nothing).
 *
 * Touch (coarse pointer): chips, radios, close and retry are 44px, spaced 8px; rows are 56px.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { useObservatoryEvents } from '@/hooks/useObservatoryEvents';
import { useNow } from '../lib/use-now';
import {
  EVENT_KINDS, EVENT_PERIODS, KIND_CHIP_LABEL, SEVERITY_DOT, SEVERITY_LABEL, chipCountText, eventAge, eventAgeSpoken, emptyFeedCopy,
  groupByAge, railLimit, viaLine, visibleKinds,
  type EventKind, type EventPeriod, type ObservatoryEvent,
} from '../lib/events';
import { EventChip } from './EventChip';
import { EventTitle } from './EventTitle';

/** The new-row flash length (matches `ev-row-arrive` in index.css). */
export const FLASH_MS = 1200;

export interface EventRailProps {
  period: EventPeriod;
  onPeriod: (p: EventPeriod) => void;
  /** Kinds filtered to (the `ev` URL key). Empty = every kind. */
  kinds: EventKind[];
  onKinds: (k: EventKind[]) => void;
  onOpenEvent: (e: ObservatoryEvent) => void;
  /** The ✕: back to the Intel tab. */
  onClose: () => void;
  /** Phone sheet vs the dock / floating panel (both in-flow content here; the dock supplies the aside). */
  placement: 'embedded' | 'sheet';
}

const EMPTY_KINDS: EventKind[] = [];

export function EventRail({ period, onPeriod, kinds, onKinds, onOpenEvent, onClose, placement }: EventRailProps) {
  const now = useNow(30_000);
  const limit = railLimit(period);
  const allQ = useObservatoryEvents({ period, limit });
  const omitted = allQ.data?.meta.omitted_kinds ?? EMPTY_KINDS;
  const failed = allQ.data?.meta.failed_kinds ?? EMPTY_KINDS;
  const chipKinds = useMemo(() => visibleKinds(omitted), [omitted]);
  const selected = useMemo(() => kinds.filter(k => !omitted.includes(k)), [kinds, omitted]);

  // A link that names a kind this role cannot see is corrected, like an unauthorised measure.
  useEffect(() => {
    if (allQ.data && selected.length !== kinds.length) onKinds(selected);
  }, [allQ.data, selected, kinds, onKinds]);

  const filtering = selected.length > 0;
  const filteredQ = useObservatoryEvents({ period, kinds: selected, limit, enabled: filtering && !!allQ.data });
  const q = filtering ? filteredQ : allQ;
  const events = useMemo(() => (q.data?.events ?? []).filter(e => !filtering || selected.includes(e.kind)), [q.data, filtering, selected]);
  const groups = useMemo(() => groupByAge(events, now), [events, now]);

  // New rows flash once. The first batch (and a period or filter change) only seeds the set. The flash is keyed by event id
  // and carries its start time, so a row that changes time group (and so remounts under another heading) resumes the
  // flash where it was instead of replaying it, and a row older than the flash never gets the class back.
  const seen = useRef<{ scope: string; ids: Set<string> } | null>(null);
  const flashAt = useRef(new Map<string, number>());
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, bump] = useState(0);
  const scope = `${period}|${selected.join(',')}`;
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  useEffect(() => {
    if (!q.data || q.isUpdating) return;
    const ids = events.map(e => e.id);
    if (seen.current === null || seen.current.scope !== scope) {
      seen.current = { scope, ids: new Set(ids) };
      flashAt.current.clear();
      bump(n => n + 1);
      return;
    }
    const added = ids.filter(id => !seen.current!.ids.has(id));
    for (const id of added) seen.current.ids.add(id);
    if (added.length === 0) return;
    const t = Date.now();
    for (const id of added) flashAt.current.set(id, t);
    bump(n => n + 1);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      flashAt.current.clear();
      bump(n => n + 1);
    }, FLASH_MS + 50);
  }, [q.data, q.isUpdating, events, scope]);
  const flashStyle = (id: string) => {
    const t = flashAt.current.get(id);
    if (t === undefined) return undefined;
    const elapsed = Date.now() - t;
    return elapsed < FLASH_MS ? { animationDelay: `-${Math.max(0, elapsed)}ms` } : undefined;
  };

  const toggle = (k: EventKind) => {
    const on = selected.includes(k);
    onKinds(on ? selected.filter(x => x !== k) : EVENT_KINDS.filter(x => x === k || selected.includes(x)));
  };

  // Period radios: arrow keys / Home / End move AND select (radio semantics), with a roving tab stop.
  const radioRefs = useRef(new Map<EventPeriod, HTMLButtonElement>());
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = EVENT_PERIODS.length;
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + n) % n
        : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const p = EVENT_PERIODS[next]!;
    onPeriod(p);
    radioRefs.current.get(p)?.focus();
  };

  const counts = allQ.data?.counts ?? {};
  const itemsOf = (k: EventKind) => (allQ.data?.events ?? []).filter(e => e.kind === k).length;
  const failedNames = failed.map(k => KIND_CHIP_LABEL[k].toLowerCase()).join(', ');
  const loading = q.isLoading && !q.data;
  const hasError = !!q.error && !q.data;
  const phoneSheet = placement === 'sheet';

  return (
    <div role={phoneSheet ? 'group' : undefined} aria-label={phoneSheet ? 'Event rail' : undefined} className="flex w-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <h2 className="m-0 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: 'var(--text-tertiary)' }}>
          <span className="ev-live-dot" aria-hidden="true" />
          Events · {period.toUpperCase()}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close events, back to Intel"
          title="Back to Intel"
          className={`ds-focusable inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11`}
          style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="px-3 pt-1 pb-2">
        <div role="radiogroup" aria-label="Event period" className={`flex items-center gap-0.5 rounded-md p-0.5 [@media(pointer:coarse)]:gap-2`} style={{ border: '1px solid var(--border-base)' }}>
          {EVENT_PERIODS.map((p, i) => (
            <button
              key={p}
              ref={el => { if (el) radioRefs.current.set(p, el); else radioRefs.current.delete(p); }}
              type="button"
              role="radio"
              aria-checked={p === period}
              tabIndex={p === period ? 0 : -1}
              onClick={() => onPeriod(p)}
              onKeyDown={e => onRadioKey(e, i)}
              className={`ds-focusable min-h-[28px] flex-1 rounded px-2 font-mono text-[11px] font-semibold uppercase tracking-wider [@media(pointer:coarse)]:min-h-[44px]`}
              style={{
                background: p === period ? 'var(--amber-glow)' : 'transparent',
                color: p === period ? 'var(--amber-text)' : 'var(--text-secondary)',
                border: 'none', cursor: 'pointer',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div role="group" aria-label="Filter events by kind" className="flex flex-wrap gap-2 px-3 pb-2.5" style={{ borderBottom: '1px solid var(--border-base)' }}>
        <button type="button" aria-pressed={!filtering} onClick={() => onKinds([])} className={chipClass(!filtering)} style={chipStyle(!filtering)}>
          All
        </button>
        {chipKinds.map(k => {
          const on = selected.includes(k);
          const n = counts[k];
          const spelled = typeof n === 'number' ? chipCountText(k, n, itemsOf(k)) : undefined;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(k)}
              className={chipClass(on)}
              style={chipStyle(on)}
              title={spelled}
              aria-label={spelled ? `${KIND_CHIP_LABEL[k]}: ${spelled}` : undefined}
            >
              {KIND_CHIP_LABEL[k]}
              {typeof n === 'number' ? <span className="ml-1 tabular-nums" aria-hidden="true" style={{ color: 'var(--text-secondary)' }}>{n}</span> : null}
            </button>
          );
        })}
      </div>

      {failed.length > 0 && (
        <div role="status" className="px-3 pt-2 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          Partial feed. {failedNames.charAt(0).toUpperCase() + failedNames.slice(1)} could not be loaded.
        </div>
      )}

      <div className="pb-3" aria-busy={q.isUpdating} style={{ opacity: q.isUpdating ? 0.6 : 1 }} data-testid="event-rail-list">
        {hasError ? (
          <div role="alert" className="mx-3 mt-3 flex items-center justify-between gap-2 rounded px-2 py-1.5" style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)' }}>
            <span className="font-mono text-[11px]" style={{ color: 'var(--sev-critical-text)' }}>Failed to load events</span>
            <button type="button" onClick={() => void q.refetch()} className={`ds-focusable inline-flex items-center gap-1 font-mono text-[11px] font-bold uppercase [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:px-2`} style={{ background: 'none', border: 'none', color: 'var(--sev-critical-text)', cursor: 'pointer' }}>
              <RefreshCw size={10} aria-hidden="true" /> Retry
            </button>
          </div>
        ) : loading ? (
          <div role="status" className="px-3 py-3 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>Loading events…</div>
        ) : groups.length === 0 ? (
          <div role="status" className="px-3 py-3 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }} data-testid="event-rail-empty">
            {emptyFeedCopy(period, selected)}
          </div>
        ) : (
          groups.map(g => (
            <section key={g.key} aria-label={g.label}>
              <h3 className="m-0 px-3 pt-3 pb-1 font-mono text-[11px] font-semibold tracking-[0.06em]" style={{ color: 'var(--text-secondary)' }}>{g.label}</h3>
              <ul className="m-0 list-none p-0">
                {g.events.map(e => {
                  const flash = flashStyle(e.id);
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => onOpenEvent(e)}
                        data-event-id={e.id}
                        className={`ds-focusable grid w-full grid-cols-[8px_1fr_auto] items-start gap-2.5 px-3 py-2 text-left hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] [@media(pointer:coarse)]:min-h-[56px] ${flash ? 'ev-row-new' : ''}`}
                        style={{ background: 'none', border: 'none', borderLeft: '2px solid transparent', cursor: 'pointer', minHeight: phoneSheet ? 56 : undefined, ...flash }}
                      >
                        <span className="mt-1.5 h-1.5 w-1.5 rounded-full" style={{ background: SEVERITY_DOT[e.severity] }} aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block text-[13px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                            <EventTitle title={e.title} name={e.entity.name} />
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                            <EventChip kind={e.kind} />
                            <span>{SEVERITY_LABEL[e.severity]} · {viaLine(e)}</span>
                          </span>
                        </span>
                        <span className="whitespace-nowrap font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-secondary)' }} title={eventAgeSpoken(e.occurred_at, now)}>
                          {eventAge(e.occurred_at, now)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

const chipClass = (on: boolean) =>
  `ds-focusable rounded-full px-2.5 font-mono text-[11px] min-h-[28px] [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:px-3.5 ${on ? 'font-semibold' : ''}`;
const chipStyle = (on: boolean) => ({
  color: on ? 'var(--amber-text)' : 'var(--text-secondary)',
  background: on ? 'var(--amber-glow)' : 'transparent',
  border: `1px solid ${on ? 'var(--amber-border)' : 'var(--border-base)'}`,
  cursor: 'pointer',
});

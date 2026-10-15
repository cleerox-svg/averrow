/**
 * Event rail — the full intel feed as a list you can filter and scroll. Lives as a
 * tab beside the intelligence panel (docked / floating) and in the phone peek sheet.
 *
 *   groups   last 15 min · 15–45 min · older (newest first inside each)
 *   filter   kind chips, kept in the URL as `ev`; a kind the server withheld for
 *            this role (`meta.omitted_kinds`, e.g. takedown) has no chip and is
 *            dropped from a link that names it
 *   period   1h · 24h · 7d (7d polls every 5 minutes at most)
 *   rows     severity dot, title, "kind · via source", age; a NEW row flashes once
 *   click    hands the event to the page (fly there, apply its target, ping the spot)
 *
 * With a filter on, rows come from a `kinds=` request so a quiet kind is not
 * crowded out of the 40-row page by a loud one; the chip counts always come from the
 * unfiltered request (which the headline bar shares at 1h, so that costs nothing).
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { useObservatoryEvents } from '@/hooks/useObservatoryEvents';
import { useNow } from '../lib/use-now';
import {
  EVENT_KINDS, EVENT_PERIODS, KIND_CHIP_LABEL, SEVERITY_DOT, eventAge, eventAgeSpoken, groupByAge, railLimit, viaLine, visibleKinds,
  type EventKind, type EventPeriod, type ObservatoryEvent,
} from '../lib/events';
import { EMPTY_COPY } from './HeadlineBar';

const PERIOD_NAME: Record<EventPeriod, string> = { '1h': 'hour', '24h': '24 hours', '7d': '7 days' };

export interface EventRailProps {
  period: EventPeriod;
  onPeriod: (p: EventPeriod) => void;
  /** Kinds filtered to (the `ev` URL key). Empty = every kind. */
  kinds: EventKind[];
  onKinds: (k: EventKind[]) => void;
  onOpenEvent: (e: ObservatoryEvent) => void;
  placement: 'dock' | 'overlay' | 'sheet';
  /** The panel's tab strip, rendered at the very top. */
  tabs?: ReactNode;
}

const EMPTY_KINDS: EventKind[] = [];

export function EventRail({ period, onPeriod, kinds, onKinds, onOpenEvent, placement, tabs }: EventRailProps) {
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

  // New rows flash once. The first batch (and a period or filter change) only seeds the set.
  const seen = useRef<{ scope: string; ids: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const scope = `${period}|${selected.join(',')}`;
  useEffect(() => {
    if (!q.data || q.isUpdating) return;
    const ids = events.map(e => e.id);
    if (seen.current === null || seen.current.scope !== scope) {
      seen.current = { scope, ids: new Set(ids) };
      setFresh(new Set());
      return;
    }
    const added = ids.filter(id => !seen.current!.ids.has(id));
    for (const id of added) seen.current.ids.add(id);
    if (added.length > 0) setFresh(new Set(added));
  }, [q.data, q.isUpdating, events, scope]);

  const toggle = (k: EventKind) => {
    const on = selected.includes(k);
    onKinds(on ? selected.filter(x => x !== k) : EVENT_KINDS.filter(x => x === k || selected.includes(x)));
  };

  const counts = allQ.data?.counts ?? {};
  const failedNames = failed.map(k => KIND_CHIP_LABEL[k].toLowerCase()).join(', ');
  const loading = q.isLoading && !q.data;
  const hasError = !!q.error && !q.data;

  const body = (
    <>
      {tabs}
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 className="m-0 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: 'var(--text-tertiary)' }}>
          <span className="ev-live-dot" aria-hidden="true" />
          Events · {period.toUpperCase()}
        </h2>
        <div role="radiogroup" aria-label="Event period" className="flex items-center gap-0.5 rounded-md p-0.5" style={{ border: '1px solid var(--border-base)' }}>
          {EVENT_PERIODS.map(p => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={p === period}
              onClick={() => onPeriod(p)}
              className="ds-focusable rounded px-2 font-mono text-[10px] font-semibold uppercase tracking-wider min-h-[24px]"
              style={{
                background: p === period ? 'var(--amber-glow)' : 'transparent',
                color: p === period ? 'var(--amber-text)' : 'var(--text-tertiary)',
                border: 'none', cursor: 'pointer',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      <div role="group" aria-label="Filter events by kind" className="flex flex-wrap gap-1.5 px-3 pb-2.5" style={{ borderBottom: '1px solid var(--border-base)' }}>
        <button type="button" aria-pressed={!filtering} onClick={() => onKinds([])} className={chipClass(!filtering)} style={chipStyle(!filtering)}>
          All
        </button>
        {chipKinds.map(k => {
          const on = selected.includes(k);
          const n = counts[k];
          return (
            <button key={k} type="button" aria-pressed={on} onClick={() => toggle(k)} className={chipClass(on)} style={chipStyle(on)}>
              {KIND_CHIP_LABEL[k]}{typeof n === 'number' ? <span className="ml-1 tabular-nums opacity-70">{n}</span> : null}
            </button>
          );
        })}
      </div>

      {failed.length > 0 && (
        <div role="status" className="px-3 pt-2 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Partial feed. {failedNames.charAt(0).toUpperCase() + failedNames.slice(1)} could not be loaded.
        </div>
      )}

      <div className="px-0 pb-3" aria-busy={q.isUpdating} style={{ opacity: q.isUpdating ? 0.6 : 1 }} data-testid="event-rail-list">
        {hasError ? (
          <div role="alert" className="mx-3 mt-3 flex items-center justify-between gap-2 rounded px-2 py-1.5" style={{ background: 'var(--sev-critical-bg)', border: '1px solid var(--sev-critical-border)' }}>
            <span className="font-mono text-[11px]" style={{ color: 'var(--sev-critical-text)' }}>Failed to load events</span>
            <button type="button" onClick={() => void q.refetch()} className="ds-focusable inline-flex items-center gap-1 font-mono text-[11px] font-bold uppercase" style={{ background: 'none', border: 'none', color: 'var(--sev-critical-text)', cursor: 'pointer' }}>
              <RefreshCw size={10} aria-hidden="true" /> Retry
            </button>
          </div>
        ) : loading ? (
          <div role="status" className="px-3 py-3 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>Loading events…</div>
        ) : groups.length === 0 ? (
          <div role="status" className="px-3 py-3 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }} data-testid="event-rail-empty">
            {filtering
              ? `No ${selected.map(k => KIND_CHIP_LABEL[k].toLowerCase()).join(' or ')} events in the last ${PERIOD_NAME[period]}`
              : period === '1h' ? EMPTY_COPY : `No new threat events in the last ${PERIOD_NAME[period]}`}
          </div>
        ) : (
          groups.map(g => (
            <section key={g.key} aria-label={g.label.toLowerCase()}>
              <h3 className="m-0 px-3 pt-3 pb-1 font-mono text-[10px] font-semibold tracking-[0.14em]" style={{ color: 'var(--text-tertiary)' }}>{g.label}</h3>
              <ul className="m-0 list-none p-0">
                {g.events.map(e => (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => onOpenEvent(e)}
                      data-event-id={e.id}
                      className={`ds-focusable grid w-full grid-cols-[8px_1fr_auto] items-start gap-2.5 px-3 py-2 text-left hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] ${fresh.has(e.id) ? 'ev-row-new' : ''}`}
                      style={{ background: 'none', border: 'none', borderLeft: '2px solid transparent', cursor: 'pointer', minHeight: placement === 'sheet' ? 52 : undefined }}
                    >
                      <span className="mt-1.5 h-1.5 w-1.5 rounded-full" style={{ background: SEVERITY_DOT[e.severity] }} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-[13px] leading-snug" style={{ color: 'var(--text-primary)' }}>
                          <span className="sr-only">{e.severity} severity. </span>{e.title}
                        </span>
                        <span className="mt-0.5 block font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{viaLine(e)}</span>
                      </span>
                      <span className="whitespace-nowrap font-mono text-[11px] tabular-nums" style={{ color: 'var(--text-tertiary)' }} title={eventAgeSpoken(e.occurred_at, now)}>
                        {eventAge(e.occurred_at, now)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  );

  if (placement === 'sheet') return <div role="group" aria-label="Event rail" className="w-full">{body}</div>;

  const overlay = placement === 'overlay';
  return (
    <aside
      aria-label="Event rail"
      // Same geometry as the intelligence panel it is a tab of (the stats bar + feed band sit below the 76px).
      className={overlay
        ? 'absolute top-[60px] right-3 bottom-[88px] z-20 w-80 max-w-[calc(100%-24px)] flex flex-col overflow-y-auto rounded-xl animate-drawer-in motion-reduce:animate-none'
        : 'absolute top-[60px] right-0 bottom-[76px] z-20 w-80 flex flex-col overflow-y-auto animate-drawer-in motion-reduce:animate-none'}
      style={{
        background: 'var(--bg-card-deep)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: overlay ? '1px solid var(--border-base)' : undefined,
        borderLeft: '1px solid var(--border-base)',
        boxShadow: overlay ? 'var(--card-shadow-elevated)' : 'var(--card-shadow-elevated), inset 1px 0 0 var(--border-base)',
      }}
    >
      {body}
    </aside>
  );
}

const chipClass = (on: boolean) =>
  `ds-focusable rounded-full px-2.5 font-mono text-[10.5px] min-h-[26px] ${on ? 'font-semibold' : ''}`;
const chipStyle = (on: boolean) => ({
  color: on ? 'var(--amber-text)' : 'var(--text-tertiary)',
  background: on ? 'var(--amber-glow)' : 'transparent',
  border: `1px solid ${on ? 'var(--amber-border)' : 'var(--border-base)'}`,
  cursor: 'pointer',
});

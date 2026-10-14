/**
 * Drill-in drawer: everything the analyst can select on the map (node, arc,
 * country, operation, provider, actor, campaign, movement) opens here.
 *
 *  - dock:    desktop, in the right-hand slot (320px, replaces the intelligence panel),
 *  - overlay: tablet, floats over the map under the toolbar,
 *  - sheet:   phone, content only inside a PeekSheet.
 *
 * Every body opens with the same hero: a pair of stat tiles, a status badge and
 * (when there is somewhere to go) one primary action. Below it, facts and related
 * objects as buttons that re-target the drawer (`onSelect`), so the analyst can walk
 * country -> operation -> provider without touching the map. One type scale:
 * 14px title, 12px facts, 11px chips and notes, 10px section labels.
 *
 * Focus moves in on open and goes back on close: to whatever opened it, or, when
 * that is gone (a search box that unmounted, a side-panel row that was replaced by
 * the drawer), to `fallbackFocus`. Escape closes it only when it is aimed at the map
 * area or the drawer itself (see shouldHandleEscape).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { Badge, StatTile, KitButton } from '@/design-system/components';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/time';
import { sevText, typeLabel } from '../lib/map-colors';
import { countryName } from '../lib/country-name';
import {
  countryFacts, drillEyebrow, drillKey, drillTitle, isPending, type DrillData, type DrillTarget,
} from '../lib/drill';
import { formatRatio } from '../lib/lens/baseline';
import { formatHours, hasRate, pct, resolvedOf, TAKEDOWN_MIN_RESOLVED } from '../lib/lens/takedowns';
import type { TakedownGeoRow } from '@/hooks/useObservatoryLenses';
import { kindLabel, normalizeConfidence } from '../lib/lens/operations';
import { trendClass } from '../lib/lens/hosting';
import { confidenceBand, confidenceValue, type ConfidenceBand } from '../lib/lens/actors';
import { useActorDetail } from '@/hooks/useObservatoryLenses';
import { iso2 } from '../lib/lens/placement';

export interface DrillDrawerProps {
  target: DrillTarget;
  data: DrillData;
  onClose: () => void;
  /** Re-target the drawer (and the map) to a related object. */
  onSelect: (target: DrillTarget) => void;
  /** `dock`: desktop column. `overlay`: tablet float. `sheet`: content only, the page wraps it in a PeekSheet. */
  variant: 'dock' | 'overlay' | 'sheet';
  /** Holds `manage_takedowns`: otherwise takedown outcomes are not shown (neutral note, no error). */
  canSeeTakedowns?: boolean;
  /** Where focus goes on close when whatever opened the drawer is no longer in the document. */
  fallbackFocus?: () => HTMLElement | null;
}

// ─── Escape scoping (kept from the old detail card) ─────────

/** True when an Escape keydown is ours to handle: aimed at the map area / this drawer / nothing in particular. */
export function shouldHandleEscape(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'target'>, drawer: HTMLElement | null): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const target = e.target;
  // Document / body target = nothing focused, so the drawer is the only thing to dismiss.
  if (!(target instanceof Element) || target === document.body) return true;
  if (drawer && drawer.contains(target)) return true;
  // Another dialog / menu / listbox owns this Escape (command palette, bottom sheet, dropdown, search).
  if (target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="combobox"],[aria-modal="true"]')) return false;
  // Otherwise only the map area (the drawer's positioned parent) counts.
  const scope = drawer?.parentElement;
  return !!scope && scope.contains(target);
}

// ─── Small building blocks ──────────────────────────────────

const LABEL = 'font-mono text-[10px] uppercase tracking-[0.18em]';
const FACT = 'font-mono text-xs';
const CHIP = 'font-mono text-[11px]';

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      {title && <h3 className={LABEL} style={{ color: 'var(--text-tertiary)', margin: 0 }}>{title}</h3>}
      {children}
    </section>
  );
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3', FACT)}>
      <span style={{ color: 'var(--text-muted)' }}>{k}</span>
      <span className="text-right min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{children}</span>
    </div>
  );
}

function Pill({ children, onClick, title }: { children: ReactNode; onClick?: () => void; title?: string }) {
  const cls = cn('ds-focusable inline-flex items-center rounded-full px-2.5 py-1 max-[899px]:min-h-[36px]', CHIP);
  const style = { border: '1px solid var(--border-base)', background: 'var(--bg-card)', color: 'var(--text-secondary)' } as const;
  if (!onClick) return <span className={cls} style={style}>{children}</span>;
  return (
    <button type="button" onClick={onClick} title={title} className={cls} style={{ ...style, cursor: 'pointer' }}>
      {children}
    </button>
  );
}

/** Chips: the first `max`, then "+N more" (a button) that reveals the rest. */
function Pills({ children, max = 6 }: { children: ReactNode; max?: number }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean) as ReactNode[];
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, max);
  const hidden = items.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown}
      {hidden > 0 && (
        <Pill onClick={() => setOpen(true)} title={`Show ${hidden} more`}>+{hidden} more</Pill>
      )}
    </div>
  );
}

function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <p
      className={cn('m-0 rounded-md px-2 py-1.5', CHIP)}
      style={{
        color: tone === 'warn' ? 'var(--amber-text)' : 'var(--text-tertiary)',
        background: tone === 'warn' ? 'var(--amber-glow)' : 'transparent',
        border: tone === 'warn' ? '1px solid var(--amber-border)' : '1px solid var(--border-base)',
      }}
    >
      {children}
    </p>
  );
}

function Bar({ value, color = 'var(--amber)', label }: { value: number; color?: string; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div role="img" aria-label={`${label}: ${pct}%`} className="h-1.5 rounded-full overflow-hidden" style={{ background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

const BAND_COLOR: Record<ConfidenceBand, string> = {
  high: 'var(--sev-info-text)', medium: 'var(--sev-medium-text)', low: 'var(--sev-high-text)', unknown: 'var(--text-muted)',
};

function ConfidenceTag({ value }: { value: number | null }) {
  const band = confidenceBand(value);
  return (
    <span className={cn('uppercase shrink-0', CHIP)} style={{ color: BAND_COLOR[band] }}>
      {value === null ? 'unrated' : `${band} ${Math.round(value * 100)}%`}
    </span>
  );
}

const fmtDate = (v: string | null): string => (v ? relativeTime(v) : '—');
const num = (n: number): string => n.toLocaleString();

interface HeroTile { label: string; value: number | string | null; sub?: string; tone?: 'amber' | 'red' | 'blue' | 'green' | 'neutral' }
interface HeroCta { label: string; to?: string; onClick?: () => void }

/** The same opening for every kind of target: two tiles, the status, one primary action. */
function Hero({ tiles, badges, cta }: { tiles: [HeroTile, HeroTile]; badges?: ReactNode; cta?: HeroCta | null }) {
  return (
    <div className="flex flex-col gap-2.5" data-hero>
      <div className="grid grid-cols-2 gap-2">
        {tiles.map(t => <StatTile key={t.label} label={t.label} value={t.value} sub={t.sub} tone={t.tone ?? 'neutral'} />)}
      </div>
      {badges && <div className="flex flex-wrap items-center gap-1.5">{badges}</div>}
      {cta && (cta.to
        ? <KitButton asChild size="md" className="w-full"><Link to={cta.to}>{cta.label}</Link></KitButton>
        : <KitButton size="md" className="w-full" onClick={cta.onClick}>{cta.label}</KitButton>)}
    </div>
  );
}

const OP_STATUS = { active: 'active', inactive: 'inactive', dormant: 'inactive', resolved: 'inactive', monitoring: 'pending' } as const;

// ─── Bodies ─────────────────────────────────────────────────

function NodeBody({ t, onSelect }: { t: Extract<DrillTarget, { kind: 'node' }>; onSelect: DrillDrawerProps['onSelect'] }) {
  const n = t.node;
  const cc = iso2(n.country_code);
  return (
    <>
      <Hero
        tiles={[
          { label: 'Threats', value: n.threat_count, tone: 'amber' },
          { label: 'Top severity', value: (n.top_severity ?? 'unknown').toUpperCase(), tone: n.top_severity === 'critical' ? 'red' : 'neutral' },
        ]}
        badges={<Badge severity={n.top_severity ?? 'info'} size="md" label={typeLabel(n.top_threat_type) || 'Mixed'} />}
        cta={cc ? { label: `Open ${countryName(cc)}`, onClick: () => onSelect({ kind: 'country', code: cc }) } : null}
      />
      <Section>
        {cc && <KV k="Country">{countryName(cc)}</KV>}
        <KV k="Type">{typeLabel(n.top_threat_type) || 'Mixed'}</KV>
      </Section>
      <Section title="Severity mix">
        <div className={cn('flex gap-3', FACT)}>
          <span style={{ color: sevText('critical') }}>C {n.critical}</span>
          <span style={{ color: sevText('high') }}>H {n.high}</span>
          <span style={{ color: sevText('medium') }}>M {n.medium}</span>
          <span style={{ color: sevText('low') }}>L {n.low}</span>
        </div>
      </Section>
    </>
  );
}

function ArcBody({ t, onSelect }: { t: Extract<DrillTarget, { kind: 'arc' }>; onSelect: DrillDrawerProps['onSelect'] }) {
  const a = t.arc;
  const cc = iso2(a.source_region);
  return (
    <>
      <Hero
        tiles={[
          { label: 'Threats', value: a.volume, tone: 'amber' },
          { label: 'Severity', value: a.severity.toUpperCase(), tone: a.severity === 'critical' ? 'red' : 'neutral' },
        ]}
        badges={<Badge severity={a.severity} size="md" label={typeLabel(a.threat_type) || 'Corridor'} />}
        cta={cc ? { label: `Open ${countryName(cc)}`, onClick: () => onSelect({ kind: 'country', code: cc }) } : null}
      />
      <Section>
        {a.brand_name && <KV k="Target"><span style={{ color: 'var(--amber-text)' }}>{a.brand_name}</span></KV>}
        <KV k="From">{a.source_region || 'unknown'}</KV>
        <KV k="Severity"><span className="uppercase" style={{ color: sevText(a.severity) }}>{a.severity}</span></KV>
      </Section>
      {a.target_precision === 'country' && <Note>Target position is approximate (country level).</Note>}
    </>
  );
}

/** Success rate (once enough resolved), the bar and the facts for one takedowns-geo row. */
function TakedownRowSection({ row, window }: { row: TakedownGeoRow; window?: string }) {
  const resolved = resolvedOf(row);
  const median = formatHours(row.median_hours);
  return (
    <Section title={`Takedowns${window ? ` · ${window}` : ''}`}>
      {hasRate(row) ? (
        <>
          <Bar value={row.share as number} color="var(--green)" label="Taken down" />
          <KV k={`${pct(row.share as number)} of resolved`}>{num(resolved)} resolved</KV>
        </>
      ) : (
        <Note>{`Too few resolved takedowns for a rate (${resolved} of ${TAKEDOWN_MIN_RESOLVED} needed).`}</Note>
      )}
      <KV k="Submitted">{num(row.submitted)}</KV>
      {row.pending > 0 && <KV k="Pending">{num(row.pending)}</KV>}
      {median && <KV k="Median time to take down">{median}</KV>}
    </Section>
  );
}

/**
 * Takedown outcomes for a country (takedowns-geo). Roles without `manage_takedowns` get a neutral note and the
 * request is never made; holders see the success rate once enough takedowns resolved, else why not.
 */
function TakedownSection({ what, canSee, rows, row, error, window }: {
  what: 'country'; canSee: boolean; rows: ReadonlyMap<string, TakedownGeoRow> | undefined; row: TakedownGeoRow | null; error: boolean; window?: string;
}) {
  const title = `Takedowns${window ? ` · ${window}` : ''}`;
  if (!canSee) {
    return <Section title="Takedowns"><Note>Takedown outcomes are shown to roles that manage takedowns.</Note></Section>;
  }
  if (!rows) {
    return <Section title={title}><Note>{error ? 'Takedown outcomes failed to load.' : 'Loading takedown outcomes…'}</Note></Section>;
  }
  if (!row) {
    return <Section title={title}><Note>{`No takedowns were submitted for this ${what} in this window.`}</Note></Section>;
  }
  return <TakedownRowSection row={row} window={window} />;
}

function CountryBody({ t, data, onSelect, canSeeTakedowns }: { t: Extract<DrillTarget, { kind: 'country' }>; data: DrillData; onSelect: DrillDrawerProps['onSelect']; canSeeTakedowns: boolean }) {
  const f = countryFacts(t.code, data);
  const sev = f.severity;
  const total = sev ? sev.critical + sev.high + sev.medium + sev.low : 0;
  return (
    <>
      <Hero
        tiles={[
          { label: 'Active threats', value: f.threats, tone: 'amber', sub: f.threats === null ? 'loads with Nodes' : undefined },
          { label: 'vs Radar', value: f.overindex && f.overindex.ratio !== null ? formatRatio(f.overindex.ratio).replace(' Radar', '') : 'n/a', sub: f.overindex ? undefined : 'no baseline' },
        ]}
        badges={f.operations.length > 0 ? <Badge context="nexus" size="md" label={`${f.operations.length} operation${f.operations.length === 1 ? '' : 's'}`} /> : undefined}
      />
      {sev && total > 0 && (
        <Section title="Severity mix">
          <div className="flex h-1.5 rounded-full overflow-hidden" role="img" aria-label={`Severity mix: ${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low`}>
            {(['critical', 'high', 'medium', 'low'] as const).map(k => (
              <div key={k} style={{ width: `${(sev[k] / total) * 100}%`, background: sevText(k) }} />
            ))}
          </div>
          {f.topTypes.map(x => <KV key={x.type} k={typeLabel(x.type)}>{num(x.count)}</KV>)}
        </Section>
      )}

      <TakedownSection
        what="country"
        canSee={canSeeTakedowns}
        rows={data.takedownCountries}
        row={data.takedownCountries?.get(f.code) ?? null}
        error={!!data.takedownCountriesError}
        window={data.takedownWindow}
      />

      {f.brands.length > 0 && (
        <Section title="Brands attacked from here">
          {f.brands.map(b => <KV key={b.name} k={b.name}>{num(b.volume)}</KV>)}
        </Section>
      )}

      {f.operations.length > 0 && (
        <Section title="Operations present">
          <Pills>
            {f.operations.map(o => (
              <Pill key={o.id} onClick={() => onSelect({ kind: 'operation', id: o.id, op: o })}>
                {o.name ?? o.id} · {o.countries.length}
              </Pill>
            ))}
          </Pills>
        </Section>
      )}

      {f.providers.length > 0 && (
        <Section title="Top hosts">
          {f.providers.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => onSelect({ kind: 'provider', id: p.id, provider: p })}
              className={cn('ds-focusable flex items-baseline justify-between gap-3 text-left max-[899px]:min-h-[36px]', FACT)}
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              <span className="truncate">{p.asn ? `${p.asn} ` : ''}{p.name}</span>
              <span className="tabular-nums shrink-0" style={{ color: 'var(--text-primary)' }}>{num(p.active_threat_count)}</span>
            </button>
          ))}
        </Section>
      )}
    </>
  );
}

function OperationBody({ t, data, onSelect }: { t: Extract<DrillTarget, { kind: 'operation' }>; data: DrillData; onSelect: DrillDrawerProps['onSelect'] }) {
  const op = t.op;
  if (!op) return <Note>Loading operation…</Note>;
  const conf = normalizeConfidence(op.confidence_score);
  const siblings = op.component_id
    ? (data.operations ?? []).filter(o => o.component_id === op.component_id && o.id !== op.id)
    : [];
  const status = (op.status ?? '').toLowerCase();
  return (
    <>
      <Hero
        tiles={[
          { label: 'Threats', value: op.threat_count, tone: 'amber' },
          { label: 'Confidence', value: conf === null ? 'n/a' : `${Math.round(conf * 100)}%`, tone: conf !== null && conf >= 0.75 ? 'green' : 'neutral' },
        ]}
        badges={(
          <>
            {op.status && <Badge status={OP_STATUS[status as keyof typeof OP_STATUS] ?? 'pending'} size="md" label={op.status} />}
            <Badge context="nexus" size="md" label={kindLabel(op.kind)} />
          </>
        )}
        cta={{ label: 'Open operation →', to: `/campaigns/${encodeURIComponent(op.id)}` }}
      />
      <Section>
        <KV k="Last seen">{fmtDate(op.last_seen)}</KV>
        {op.last_movement_pivot_at && <KV k="Last moved">{fmtDate(op.last_movement_pivot_at)}</KV>}
        <KV k="Actor">
          {op.actor
            ? <button type="button" className="ds-focusable" onClick={() => onSelect({ kind: 'actor', id: op.actor!.id, name: op.actor!.name })} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--amber-text)', cursor: 'pointer', font: 'inherit' }}>{op.actor.name}</button>
            : 'unattributed'}
        </KV>
      </Section>
      <Section title={`Countries · ${op.countries.length}`}>
        <Pills>
          {op.countries.map(cc => {
            const code = iso2(cc);
            return code
              ? <Pill key={cc} onClick={() => onSelect({ kind: 'country', code })}>{countryName(code)}</Pill>
              : <Pill key={cc}>{cc}</Pill>;
          })}
        </Pills>
      </Section>
      {op.asns.length > 0 && (
        <Section title={`ASNs · ${op.asns.length}`}>
          <Pills>{op.asns.map(a => <Pill key={a}>{a}</Pill>)}</Pills>
        </Section>
      )}
      {siblings.length > 0 && (
        <Section title="Linked operations">
          <Pills>
            {siblings.map(o => <Pill key={o.id} onClick={() => onSelect({ kind: 'operation', id: o.id, op: o })}>{o.name ?? o.id}</Pill>)}
          </Pills>
        </Section>
      )}
    </>
  );
}

function ProviderBody({ t, data, onSelect, canSeeTakedowns }: { t: Extract<DrillTarget, { kind: 'provider' }>; data: DrillData; onSelect: DrillDrawerProps['onSelect']; canSeeTakedowns: boolean }) {
  const p = t.provider;
  if (!p) return <Note>Loading provider…</Note>;
  const cc = iso2(p.country);
  const trend = trendClass(p.trend_7d, p.trend_30d);
  return (
    <>
      <Hero
        tiles={[
          { label: 'Active threats', value: p.active_threat_count, tone: 'amber' },
          { label: 'This week', value: p.trend_7d, tone: trend === 'rising' ? 'red' : trend === 'falling' ? 'green' : 'neutral', sub: trend },
        ]}
        badges={(
          <>
            {trend === 'rising' && <Badge context="worsening" size="md" />}
            {trend === 'falling' && <Badge context="improving" size="md" />}
            {p.is_bulletproof && <Badge severity="high" size="md" label="Bulletproof" />}
          </>
        )}
        cta={{ label: 'Open provider →', to: `/explore?tab=providers&focus=${encodeURIComponent(p.id)}` }}
      />
      <Section>
        {p.asn && <KV k="ASN">{p.asn}</KV>}
        {cc && (
          <KV k="Country">
            <button type="button" className="ds-focusable" onClick={() => onSelect({ kind: 'country', code: cc })} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--amber-text)', cursor: 'pointer', font: 'inherit' }}>{countryName(cc)}</button>
          </KV>
        )}
        <KV k="All-time">{num(p.total_threat_count)}</KV>
        <KV k="Last 30 days">{num(p.trend_30d)}</KV>
        {p.reputation_score !== null && <KV k="Reputation">{p.reputation_score}</KV>}
      </Section>
      {p.is_bulletproof && <Note tone="warn">Flagged bulletproof: abuse reports are routinely ignored.</Note>}
      {/* The Hosting > Takedowns measure loads per-host outcomes for the chosen window: show that row (same numbers as the map). */}
      {canSeeTakedowns && data.takedownProviders?.some(r => r.key === p.id) ? (
        <TakedownRowSection row={data.takedownProviders.find(r => r.key === p.id)!} window={data.takedownWindow} />
      ) : (
      <Section title="Takedowns">
        {!canSeeTakedowns ? (
          <Note>Takedown outcomes are shown to roles that manage takedowns.</Note>
        ) : p.takedown && p.takedown.share !== null ? (
          <>
            <Bar value={p.takedown.share} color="var(--green)" label="Taken down" />
            <KV k={`${Math.round(p.takedown.share * 100)}% of resolved`}>{num(p.takedown.n)} submitted</KV>
            {p.takedown.median_hours !== null && <KV k="Median time to resolve">{Math.round(p.takedown.median_hours)}h</KV>}
          </>
        ) : (
          <Note>No resolved takedowns recorded for this provider yet.</Note>
        )}
      </Section>
      )}
    </>
  );
}

function ActorBody({ t, onSelect }: { t: Extract<DrillTarget, { kind: 'actor' }>; onSelect: DrillDrawerProps['onSelect'] }) {
  const q = useActorDetail(t.id);
  if (q.isLoading) return <Note>Loading actor…</Note>;
  if (q.error) {
    const missing = /not found/i.test(q.error.message);
    return (
      <div role="alert">
        <Note tone="warn">{missing ? 'This actor no longer exists.' : 'The actor could not be loaded.'}</Note>
        {!missing && (
          <button type="button" onClick={() => void q.refetch()} className={cn('ds-focusable mt-2', CHIP)} style={{ background: 'none', border: 'none', color: 'var(--amber-text)', cursor: 'pointer', padding: 0 }}>Retry</button>
        )}
      </div>
    );
  }
  const d = q.data?.data;
  if (!d) return null;
  const { actor, infrastructure, clusters, attributions } = d;
  const countries = new Map<string, number | null>();
  for (const i of infrastructure) {
    const cc = iso2(i.country_code);
    if (!cc) continue;
    const c = confidenceValue(i.confidence);
    const cur = countries.get(cc);
    if (cur === undefined || (c !== null && (cur === null || c > cur))) countries.set(cc, c);
  }
  const attributed = Object.values(attributions.by_confidence).reduce((a, b) => a + b, 0);
  return (
    <>
      <Hero
        tiles={[
          { label: 'Clusters', value: clusters.length, tone: 'amber' },
          { label: 'ASNs', value: infrastructure.length, tone: 'neutral' },
        ]}
        badges={actor.attribution_confidence ? <Badge severity={null} size="md" label={`${actor.attribution_confidence} attribution`} /> : undefined}
      />
      <Section>
        {actor.aliases.length > 0 && <KV k="Also known as">{actor.aliases.slice(0, 3).join(', ')}</KV>}
        {actor.affiliation && <KV k="Affiliation">{actor.affiliation}</KV>}
        {actor.country_code && <KV k="Origin">{countryName(actor.country_code)}</KV>}
        {actor.capability && <KV k="Capability">{actor.capability}</KV>}
        <KV k="Last seen">{fmtDate(actor.last_seen)}</KV>
      </Section>
      {actor.description && <p className={cn('m-0', CHIP)} style={{ color: 'var(--text-tertiary)' }}>{actor.description.slice(0, 280)}</p>}

      <Section title="Known infrastructure">
        {infrastructure.length === 0 && clusters.length === 0 ? (
          <Note>
            No infrastructure is attributed to this actor yet. That reflects attribution coverage, not the
            absence of activity.
          </Note>
        ) : (
          <>
            {[...countries.entries()].map(([cc, conf]) => (
              <button
                key={cc}
                type="button"
                onClick={() => onSelect({ kind: 'country', code: cc })}
                className={cn('ds-focusable flex items-baseline justify-between gap-3 text-left max-[899px]:min-h-[36px]', FACT)}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                <span>{countryName(cc)}</span>
                <ConfidenceTag value={conf} />
              </button>
            ))}
            {infrastructure.slice(0, 8).map((i, idx) => (
              <div key={`${i.asn}-${idx}`} className={cn('flex items-baseline justify-between gap-3', CHIP)} style={{ color: 'var(--text-muted)' }}>
                <span className="truncate">{i.asn ?? 'unknown ASN'}{i.hosting_provider ? ` · ${i.hosting_provider}` : ''}</span>
                <ConfidenceTag value={confidenceValue(i.confidence)} />
              </div>
            ))}
          </>
        )}
      </Section>

      {clusters.length > 0 && (
        <Section title={`Clusters · ${clusters.length}`}>
          {clusters.slice(0, 6).map(c => (
            <div key={c.id} className={cn('flex items-baseline justify-between gap-3', CHIP)} style={{ color: 'var(--text-muted)' }}>
              <span className="truncate">{c.countries.join(' ') || '—'} {c.asns.slice(0, 2).join(' ')}</span>
              <ConfidenceTag value={normalizeConfidence(c.confidence_score)} />
            </div>
          ))}
        </Section>
      )}
      {attributed > 0 && (
        <Section title="Attributions">
          {Object.entries(attributions.by_confidence).map(([k, v]) => <KV key={k} k={k}>{num(v)}</KV>)}
        </Section>
      )}
    </>
  );
}

function CampaignBody({ t, onSelect }: { t: Extract<DrillTarget, { kind: 'campaign' }>; onSelect: DrillDrawerProps['onSelect'] }) {
  const c = t.campaign;
  if (!c) return <Note>Loading campaign…</Note>;
  const row = (list: string[]) => (
    <Pills>
      {list.map(cc => {
        const code = iso2(cc);
        return code ? <Pill key={cc} onClick={() => onSelect({ kind: 'country', code })}>{countryName(code)}</Pill> : <Pill key={cc}>{cc}</Pill>;
      })}
    </Pills>
  );
  const status = (c.status ?? '').toLowerCase();
  return (
    <>
      <Hero
        tiles={[
          { label: 'Adversaries', value: c.adversary_countries.length, tone: 'red' },
          { label: 'Targets', value: c.target_countries.length, tone: 'amber' },
        ]}
        badges={c.status ? <Badge status={status === 'active' ? 'active' : 'inactive'} size="md" label={c.status} /> : undefined}
        cta={{ label: 'Open campaign →', to: `/campaigns/geo/${encodeURIComponent(c.slug)}` }}
      />
      <Note>Curated by analysts: adversary and target are an assessment, not observed traffic.</Note>
      <Section>
        {c.conflict && <KV k="Conflict">{c.conflict}</KV>}
        {c.start_date && <KV k="Since">{c.start_date.slice(0, 10)}</KV>}
      </Section>
      {c.adversary_countries.length > 0 && <Section title="Adversary">{row(c.adversary_countries)}</Section>}
      {c.target_countries.length > 0 && <Section title="Targets">{row(c.target_countries)}</Section>}
      {c.threat_actors.length > 0 && <Section title="Actors"><Pills>{c.threat_actors.map(a => <Pill key={a}>{a}</Pill>)}</Pills></Section>}
    </>
  );
}

function MovementBody({ t, onSelect }: { t: Extract<DrillTarget, { kind: 'movement' }>; onSelect: DrillDrawerProps['onSelect'] }) {
  const m = t.movement;
  if (!m) return <Note>Loading movement…</Note>;
  const side = (title: string, e: { asns: string[]; countries: string[] }) => (
    <Section title={title}>
      {e.countries.length === 0 && e.asns.length === 0 ? <Note>Not recorded for this event.</Note> : (
        <>
          <Pills>
            {e.countries.map(cc => {
              const code = iso2(cc);
              return code ? <Pill key={cc} onClick={() => onSelect({ kind: 'country', code })}>{countryName(code)}</Pill> : <Pill key={cc}>{cc}</Pill>;
            })}
          </Pills>
          {e.asns.length > 0 && <Pills>{e.asns.map(a => <Pill key={a}>{a}</Pill>)}</Pills>}
        </>
      )}
    </Section>
  );
  const dormant = m.kind === 'dormancy';
  return (
    <>
      <Hero
        tiles={[
          { label: 'New ASNs', value: m.counts.new_asns, tone: 'amber' },
          { label: 'New IPs', value: m.counts.new_ips, tone: 'neutral', sub: m.counts.new_serials > 0 ? `+ ${m.counts.new_serials} cert` : undefined },
        ]}
        badges={dormant ? <Badge status="inactive" size="md" label="Went dark" /> : <Badge context="pivot" size="md" label="Moved" />}
        cta={m.cluster_id ? { label: 'Open operation →', to: `/campaigns/${encodeURIComponent(m.cluster_id)}` } : null}
      />
      <Section>
        <KV k="When">{fmtDate(m.at)}</KV>
        <KV k="Kind">{dormant ? 'activity dropped' : 'infrastructure moved'}</KV>
      </Section>
      {side(dormant ? 'Was hosted on' : 'Moved from', m.from)}
      {!dormant && side('Moved to', m.to)}
      {m.payload_v < 2 && <Note>Older event: only the destination was recorded.</Note>}
    </>
  );
}

// ─── Drawer ─────────────────────────────────────────────────

export function DrillDrawer({ target, data, onClose, onSelect, variant, canSeeTakedowns = true, fallbackFocus }: DrillDrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const fallbackRef = useRef(fallbackFocus);
  fallbackRef.current = fallbackFocus;

  // Move focus in on open, give it back when the drawer goes away: to the opener, or — when that
  // is gone — to the page's stable fallback (the search box / the panel toggle), never to <body>.
  const prevFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    // Keep the FIRST opener: StrictMode re-runs this after the drawer already took focus.
    if (!ref.current?.contains(active)) prevFocusRef.current = active;
    return () => {
      const prev = prevFocusRef.current;
      const current = document.activeElement;
      const lost = !current || current === document.body;
      if (!lost) return;
      if (prev instanceof HTMLElement && prev !== document.body && prev.isConnected) { prev.focus({ preventScroll: true }); return; }
      const fb = fallbackRef.current?.();
      if (fb && fb.isConnected) fb.focus({ preventScroll: true });
    };
  }, []);
  const title = drillTitle(target);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [title, target.kind]);

  useEffect(() => {
    if (variant === 'sheet') return; // the PeekSheet owns Escape
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleEscape(e, ref.current)) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [variant]);

  const body = (
    <div key={drillKey(target)} className="flex flex-col gap-3.5">
      {target.kind === 'node' && <NodeBody t={target} onSelect={onSelect} />}
      {target.kind === 'arc' && <ArcBody t={target} onSelect={onSelect} />}
      {target.kind === 'country' && <CountryBody t={target} data={data} onSelect={onSelect} canSeeTakedowns={canSeeTakedowns} />}
      {target.kind === 'operation' && <OperationBody t={target} data={data} onSelect={onSelect} />}
      {target.kind === 'provider' && <ProviderBody t={target} data={data} onSelect={onSelect} canSeeTakedowns={canSeeTakedowns} />}
      {target.kind === 'actor' && <ActorBody t={target} onSelect={onSelect} />}
      {target.kind === 'campaign' && <CampaignBody t={target} onSelect={onSelect} />}
      {target.kind === 'movement' && <MovementBody t={target} onSelect={onSelect} />}
    </div>
  );

  const header = (
    <div className={cn('flex items-start justify-between gap-2', variant !== 'sheet' && 'mb-3')}>
      <div className="min-w-0">
        <div className={LABEL} style={{ color: 'var(--text-tertiary)' }}>{drillEyebrow(target)}</div>
        <h2 className="font-mono text-sm font-bold m-0 mt-0.5 capitalize break-words" style={{ color: 'var(--text-primary)' }} aria-busy={isPending(target)}>
          {title}
        </h2>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close details"
        title="Close (Esc)"
        className="ds-focusable shrink-0 inline-flex items-center justify-center min-w-[28px] min-h-[28px] -m-1 max-[899px]:min-w-[44px] max-[899px]:min-h-[44px]"
        style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 2, borderRadius: 6, color: 'var(--text-tertiary)', lineHeight: 0 }}
      >
        <X size={14} />
      </button>
    </div>
  );

  if (variant === 'sheet') {
    return (
      <div ref={ref} role="group" aria-label={`${drillEyebrow(target)} details`} tabIndex={-1} className="outline-none">
        {/* Sticky: the close button stays reachable however far the body is scrolled. */}
        <div className="sticky top-0 z-[1] px-4 pt-2 pb-3" style={{ background: 'var(--bg-elevated-solid, var(--bg-elevated))' }}>{header}</div>
        <div className="px-4 pb-4">{body}</div>
      </div>
    );
  }

  const overlay = variant === 'overlay';
  return (
    <aside
      ref={ref}
      role="dialog"
      aria-label={`${drillEyebrow(target)} details`}
      tabIndex={-1}
      className={cn(
        'absolute z-20 w-80 max-w-[calc(100%-24px)] flex flex-col overflow-hidden outline-none animate-drawer-in motion-reduce:animate-none',
        overlay ? 'top-[60px] right-3 bottom-[88px] rounded-xl' : 'top-[60px] right-0 bottom-[76px]',
      )}
      style={{
        background: 'var(--bg-card-deep)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderStyle: 'solid',
        borderColor: 'var(--border-base)',
        borderWidth: overlay ? 1 : '0 0 0 1px',
        boxShadow: overlay ? 'var(--card-shadow-elevated)' : 'var(--card-shadow-elevated), inset 1px 0 0 var(--border-base)',
      }}
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {header}
        {body}
      </div>
    </aside>
  );
}

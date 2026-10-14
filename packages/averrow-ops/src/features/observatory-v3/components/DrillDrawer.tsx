/**
 * Drill-in drawer: everything the analyst can select on the map (node, arc,
 * country, operation, provider, actor, campaign, movement) opens here.
 *
 *  - desktop: docked in the right-hand slot (same 320px as the intelligence panel,
 *    which it temporarily replaces),
 *  - mobile: rendered inside a BottomSheet by the page (`variant="sheet"`).
 *
 * Related objects are buttons that re-target the drawer (`onSelect`), so the
 * analyst can walk country -> operation -> provider without touching the map.
 * Focus moves in on open and is restored on close; Escape closes it only when it
 * is aimed at the map area or the drawer itself (see shouldHandleEscape).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { X, MapPin } from 'lucide-react';
import { relativeTime } from '@/lib/time';
import { sevText, typeLabel } from '../lib/map-colors';
import { countryName } from '../lib/country-name';
import {
  countryFacts, drillEyebrow, drillTitle, isPending, type DrillData, type DrillTarget,
} from '../lib/drill';
import { formatRatio } from '../lib/lens/baseline';
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
  /** `dock`: desktop aside. `sheet`: content only, the page wraps it in a BottomSheet. */
  variant: 'dock' | 'sheet';
  /** Holds `manage_takedowns`: otherwise takedown outcomes are not shown (neutral note, no error). */
  canSeeTakedowns?: boolean;
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className={LABEL} style={{ color: 'var(--text-tertiary)', margin: 0 }}>{title}</h3>
      {children}
    </section>
  );
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-mono text-[11px]">
      <span style={{ color: 'var(--text-muted)' }}>{k}</span>
      <span className="text-right min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{children}</span>
    </div>
  );
}

function Pill({ children, onClick, title }: { children: ReactNode; onClick?: () => void; title?: string }) {
  const cls = 'ds-focusable inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[10px] max-[899px]:min-h-[36px]';
  const style = { border: '1px solid var(--border-base)', background: 'var(--bg-card)', color: 'var(--text-secondary)' } as const;
  if (!onClick) return <span className={cls} style={style}>{children}</span>;
  return (
    <button type="button" onClick={onClick} title={title} className={cls} style={{ ...style, cursor: 'pointer' }}>
      {children}
    </button>
  );
}

function Pills({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>;
}

function Note({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return (
    <p
      className="font-mono text-[10px] m-0 rounded-md px-2 py-1.5"
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
    <span className="font-mono text-[10px] uppercase shrink-0" style={{ color: BAND_COLOR[band] }}>
      {value === null ? 'unrated' : `${band} ${Math.round(value * 100)}%`}
    </span>
  );
}

function LinkOut({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="ds-focusable font-mono text-[11px] no-underline" style={{ color: 'var(--amber-text)' }}>
      {children}
    </Link>
  );
}

const fmtDate = (v: string | null): string => (v ? relativeTime(v) : '—');

// ─── Bodies ─────────────────────────────────────────────────

function NodeBody({ t, onSelect }: { t: Extract<DrillTarget, { kind: 'node' }>; onSelect: DrillDrawerProps['onSelect'] }) {
  const n = t.node;
  const cc = iso2(n.country_code);
  return (
    <>
      <Section title="Origin">
        <KV k="Type">{typeLabel(n.top_threat_type) || 'Mixed'}</KV>
        <KV k="Top severity">
          <span className="uppercase" style={{ color: sevText(n.top_severity ?? 'low') }}>{n.top_severity ?? 'unknown'}</span>
        </KV>
        {cc && <KV k="Country">{countryName(cc)}</KV>}
      </Section>
      <Section title="Severity">
        <div className="flex gap-3 font-mono text-[11px]">
          <span style={{ color: sevText('critical') }}>C {n.critical}</span>
          <span style={{ color: sevText('high') }}>H {n.high}</span>
          <span style={{ color: sevText('medium') }}>M {n.medium}</span>
          <span style={{ color: sevText('low') }}>L {n.low}</span>
        </div>
      </Section>
      {cc && (
        <Pills>
          <Pill onClick={() => onSelect({ kind: 'country', code: cc })}>Open {countryName(cc)}</Pill>
        </Pills>
      )}
    </>
  );
}

function ArcBody({ t, onSelect }: { t: Extract<DrillTarget, { kind: 'arc' }>; onSelect: DrillDrawerProps['onSelect'] }) {
  const a = t.arc;
  const cc = iso2(a.source_region);
  return (
    <>
      <Section title="Corridor">
        <KV k="Threats">{a.volume.toLocaleString()}</KV>
        {a.brand_name && <KV k="Target"><span style={{ color: 'var(--amber-text)' }}>{a.brand_name}</span></KV>}
        <KV k="From">{a.source_region || 'unknown'}</KV>
        <KV k="Severity"><span className="uppercase" style={{ color: sevText(a.severity) }}>{a.severity}</span></KV>
      </Section>
      {a.target_precision === 'country' && <Note>Target position is approximate (country level).</Note>}
      {cc && <Pills><Pill onClick={() => onSelect({ kind: 'country', code: cc })}>Open {countryName(cc)}</Pill></Pills>}
    </>
  );
}

function CountryBody({ t, data, onSelect }: { t: Extract<DrillTarget, { kind: 'country' }>; data: DrillData; onSelect: DrillDrawerProps['onSelect'] }) {
  const f = countryFacts(t.code, data);
  const sev = f.severity;
  const total = sev ? sev.critical + sev.high + sev.medium + sev.low : 0;
  return (
    <>
      <Section title="Threat activity">
        {f.threats === null ? (
          <Note>Threat counts load with the Nodes layer.</Note>
        ) : (
          <>
            <KV k="Active threats">{f.threats.toLocaleString()}</KV>
            {sev && total > 0 && (
              <div className="flex h-1.5 rounded-full overflow-hidden" role="img" aria-label={`Severity mix: ${sev.critical} critical, ${sev.high} high, ${sev.medium} medium, ${sev.low} low`}>
                {(['critical', 'high', 'medium', 'low'] as const).map(k => (
                  <div key={k} style={{ width: `${(sev[k] / total) * 100}%`, background: sevText(k) }} />
                ))}
              </div>
            )}
            {f.topTypes.map(x => <KV key={x.type} k={typeLabel(x.type)}>{x.count.toLocaleString()}</KV>)}
          </>
        )}
        {f.overindex && (
          <KV k="vs Cloudflare Radar">{formatRatio(f.overindex.ratio)}</KV>
        )}
      </Section>

      {f.brands.length > 0 && (
        <Section title="Brands attacked from here">
          {f.brands.map(b => <KV key={b.name} k={b.name}>{b.volume.toLocaleString()}</KV>)}
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
              className="ds-focusable flex items-baseline justify-between gap-3 font-mono text-[11px] text-left max-[899px]:min-h-[36px]"
              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              <span className="truncate">{p.asn ? `${p.asn} ` : ''}{p.name}</span>
              <span className="tabular-nums shrink-0" style={{ color: 'var(--text-primary)' }}>{p.active_threat_count.toLocaleString()}</span>
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
  return (
    <>
      <Section title="Operation">
        <KV k="Evidence">{kindLabel(op.kind)}</KV>
        <KV k="Threats">{op.threat_count.toLocaleString()}</KV>
        <KV k="Confidence">{conf === null ? 'n/a' : `${Math.round(conf * 100)}%`}</KV>
        <KV k="Status">{op.status ?? '—'}</KV>
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
      <LinkOut to={`/campaigns/${encodeURIComponent(op.id)}`}>Open operation →</LinkOut>
    </>
  );
}

function ProviderBody({ t, onSelect, canSeeTakedowns }: { t: Extract<DrillTarget, { kind: 'provider' }>; onSelect: DrillDrawerProps['onSelect']; canSeeTakedowns: boolean }) {
  const p = t.provider;
  if (!p) return <Note>Loading provider…</Note>;
  const cc = iso2(p.country);
  const trend = trendClass(p.trend_7d, p.trend_30d);
  return (
    <>
      <Section title="Provider">
        {p.asn && <KV k="ASN">{p.asn}</KV>}
        {cc && (
          <KV k="Country">
            <button type="button" className="ds-focusable" onClick={() => onSelect({ kind: 'country', code: cc })} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--amber-text)', cursor: 'pointer', font: 'inherit' }}>{countryName(cc)}</button>
          </KV>
        )}
        <KV k="Active threats">{p.active_threat_count.toLocaleString()}</KV>
        <KV k="All-time">{p.total_threat_count.toLocaleString()}</KV>
        <KV k="This week">{p.trend_7d.toLocaleString()} ({trend})</KV>
        <KV k="Last 30 days">{p.trend_30d.toLocaleString()}</KV>
        {p.reputation_score !== null && <KV k="Reputation">{p.reputation_score}</KV>}
      </Section>
      {p.is_bulletproof && <Note tone="warn">Flagged bulletproof: abuse reports are routinely ignored.</Note>}
      <Section title="Takedowns">
        {!canSeeTakedowns ? (
          <Note>Takedown outcomes are shown to roles that manage takedowns.</Note>
        ) : p.takedown && p.takedown.share !== null ? (
          <>
            <Bar value={p.takedown.share} color="var(--green)" label="Taken down" />
            <KV k={`${Math.round(p.takedown.share * 100)}% of resolved`}>{p.takedown.n.toLocaleString()} submitted</KV>
            {p.takedown.median_hours !== null && <KV k="Median time to resolve">{Math.round(p.takedown.median_hours)}h</KV>}
          </>
        ) : (
          <Note>No resolved takedowns recorded for this provider yet.</Note>
        )}
      </Section>
      <LinkOut to={`/explore?tab=providers&focus=${encodeURIComponent(p.id)}`}>Open provider →</LinkOut>
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
          <button type="button" onClick={() => void q.refetch()} className="ds-focusable font-mono text-[11px] mt-2" style={{ background: 'none', border: 'none', color: 'var(--amber-text)', cursor: 'pointer', padding: 0 }}>Retry</button>
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
      <Section title="Actor">
        {actor.aliases.length > 0 && <KV k="Also known as">{actor.aliases.slice(0, 3).join(', ')}</KV>}
        {actor.affiliation && <KV k="Affiliation">{actor.affiliation}</KV>}
        {actor.country_code && <KV k="Origin">{countryName(actor.country_code)}</KV>}
        {actor.capability && <KV k="Capability">{actor.capability}</KV>}
        {actor.attribution_confidence && <KV k="Attribution">{actor.attribution_confidence}</KV>}
        <KV k="Last seen">{fmtDate(actor.last_seen)}</KV>
      </Section>
      {actor.description && <p className="font-mono text-[11px] m-0" style={{ color: 'var(--text-tertiary)' }}>{actor.description.slice(0, 280)}</p>}

      <Section title={`Known infrastructure · ${infrastructure.length} ASN${infrastructure.length === 1 ? '' : 's'}`}>
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
                className="ds-focusable flex items-baseline justify-between gap-3 font-mono text-[11px] text-left max-[899px]:min-h-[36px]"
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-secondary)' }}
              >
                <span>{countryName(cc)}</span>
                <ConfidenceTag value={conf} />
              </button>
            ))}
            {infrastructure.slice(0, 8).map((i, idx) => (
              <div key={`${i.asn}-${idx}`} className="flex items-baseline justify-between gap-3 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
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
            <div key={c.id} className="flex items-baseline justify-between gap-3 font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
              <span className="truncate">{c.countries.join(' ') || '—'} {c.asns.slice(0, 2).join(' ')}</span>
              <ConfidenceTag value={normalizeConfidence(c.confidence_score)} />
            </div>
          ))}
        </Section>
      )}
      {attributed > 0 && (
        <Section title="Attributions">
          {Object.entries(attributions.by_confidence).map(([k, v]) => <KV key={k} k={k}>{v.toLocaleString()}</KV>)}
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
  return (
    <>
      <Note>Curated by analysts: adversary and target are an assessment, not observed traffic.</Note>
      <Section title="Campaign">
        <KV k="Status">{c.status ?? '—'}</KV>
        {c.conflict && <KV k="Conflict">{c.conflict}</KV>}
        {c.start_date && <KV k="Since">{c.start_date.slice(0, 10)}</KV>}
      </Section>
      {c.adversary_countries.length > 0 && <Section title="Adversary">{row(c.adversary_countries)}</Section>}
      {c.target_countries.length > 0 && <Section title="Targets">{row(c.target_countries)}</Section>}
      {c.threat_actors.length > 0 && <Section title="Actors"><Pills>{c.threat_actors.map(a => <Pill key={a}>{a}</Pill>)}</Pills></Section>}
      <LinkOut to={`/campaigns/geo/${encodeURIComponent(c.slug)}`}>Open campaign →</LinkOut>
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
          {e.asns.length > 0 && <Pills>{e.asns.slice(0, 8).map(a => <Pill key={a}>{a}</Pill>)}</Pills>}
        </>
      )}
    </Section>
  );
  return (
    <>
      <Section title="Event">
        <KV k="When">{fmtDate(m.at)}</KV>
        <KV k="Kind">{m.kind === 'dormancy' ? 'went dark (activity dropped)' : 'infrastructure moved'}</KV>
        {m.counts.new_asns + m.counts.new_ips + m.counts.new_serials > 0 && (
          <KV k="New">{m.counts.new_asns} ASN · {m.counts.new_ips} IP · {m.counts.new_serials} cert</KV>
        )}
      </Section>
      {side(m.kind === 'dormancy' ? 'Was hosted on' : 'Moved from', m.from)}
      {m.kind !== 'dormancy' && side('Moved to', m.to)}
      {m.payload_v < 2 && <Note>Older event: only the destination was recorded.</Note>}
      {m.cluster_id && <LinkOut to={`/campaigns/${encodeURIComponent(m.cluster_id)}`}>Open operation →</LinkOut>}
    </>
  );
}

// ─── Drawer ─────────────────────────────────────────────────

export function DrillDrawer({ target, data, onClose, onSelect, variant, canSeeTakedowns = true }: DrillDrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Move focus in on open, give it back to whatever had it when the drawer goes away.
  const prevFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    // Keep the FIRST opener: StrictMode re-runs this after the drawer already took focus.
    if (!ref.current?.contains(active)) prevFocusRef.current = active;
    return () => {
      const prev = prevFocusRef.current;
      const current = document.activeElement;
      const lost = !current || current === document.body;
      if (lost && prev instanceof HTMLElement && prev !== document.body && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);
  const title = drillTitle(target);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [title, target.kind]);

  useEffect(() => {
    if (variant === 'sheet') return; // the BottomSheet owns Escape
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleEscape(e, ref.current)) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [variant]);

  const body = (
    <div className="flex flex-col gap-3.5">
      {target.kind === 'node' && <NodeBody t={target} onSelect={onSelect} />}
      {target.kind === 'arc' && <ArcBody t={target} onSelect={onSelect} />}
      {target.kind === 'country' && <CountryBody t={target} data={data} onSelect={onSelect} />}
      {target.kind === 'operation' && <OperationBody t={target} data={data} onSelect={onSelect} />}
      {target.kind === 'provider' && <ProviderBody t={target} onSelect={onSelect} canSeeTakedowns={canSeeTakedowns} />}
      {target.kind === 'actor' && <ActorBody t={target} onSelect={onSelect} />}
      {target.kind === 'campaign' && <CampaignBody t={target} onSelect={onSelect} />}
      {target.kind === 'movement' && <MovementBody t={target} onSelect={onSelect} />}
    </div>
  );

  const header = (
    <div className="flex items-start justify-between gap-2 mb-3">
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
        className="ds-focusable shrink-0 inline-flex items-center justify-center min-w-[28px] min-h-[28px] -m-1 max-[899px]:min-w-[44px] max-[899px]:min-h-[44px]"
        style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 2, borderRadius: 6, color: 'var(--text-tertiary)', lineHeight: 0 }}
      >
        <X size={14} />
      </button>
    </div>
  );

  if (variant === 'sheet') {
    return (
      <div ref={ref} role="group" aria-label={`${drillEyebrow(target)} details`} tabIndex={-1} className="outline-none p-4">
        {header}
        {body}
      </div>
    );
  }

  return (
    <aside
      ref={ref}
      role="dialog"
      aria-label={`${drillEyebrow(target)} details`}
      tabIndex={-1}
      className="absolute top-0 right-0 bottom-[76px] z-20 w-80 flex flex-col overflow-hidden outline-none"
      style={{
        background: 'var(--bg-card-deep)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        borderLeft: '1px solid var(--border-base)',
        boxShadow: 'var(--card-shadow-elevated), inset 1px 0 0 var(--border-base)',
      }}
    >
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {header}
        {body}
      </div>
      <div className="px-4 py-2 font-mono text-[10px] flex items-center gap-1.5" style={{ borderTop: '1px solid var(--border-base)', color: 'var(--text-muted)' }}>
        <MapPin size={10} aria-hidden /> Esc to close
      </div>
    </aside>
  );
}

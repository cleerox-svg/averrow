/**
 * Legend sections for the lens layers. One section per layer: what the marks
 * mean (generated from the same colour tables the WebGL layers use), how many
 * objects are drawn, anything that could not be placed, and an honest empty /
 * loading / error state — an empty lens never reads as "nothing is happening".
 *
 * The sections are plain blocks: LegendChip composes the right ones for the active
 * lens inside its single collapsible card.
 */

import { Select } from '@averrow/shared/ui';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Measure } from '../lib/url-state';
import type { OperationsModel } from '../lib/lens/operations';
import type { MovementModel } from '../lib/lens/movement';
import type { HostingModel } from '../lib/lens/hosting';
import { TREND_COLORS } from '../lib/lens/hosting';
import type { BaselineModel } from '../lib/lens/baseline';
import { OVERINDEX_STOPS, NO_BASELINE_OUTLINE } from '../lib/lens/baseline';
import type { BotShareModel } from '../lib/lens/bot-share';
import { formatPct } from '../lib/bot-density';
import { Link } from 'react-router-dom';
import { tabUrl } from '@/lib/workspaceRoutes';
import type { CampaignsModel } from '../lib/lens/campaigns';
import type { TakedownCountryModel, TakedownProviderModel } from '../lib/lens/takedowns';
import { TAKEDOWN_MIN_RESOLVED, TAKEDOWN_SMALL_OUTLINE, TAKEDOWN_STOPS } from '../lib/lens/takedowns';
import type { VelocityModel } from '../lib/lens/velocity';
import { VELOCITY_FILLING, VELOCITY_RGB } from '../lib/lens/velocity';
import type { ActorModel } from '../lib/lens/actors';
import type { ActorListItem } from '@/hooks/useObservatoryLenses';
import { rgbCss, type Rgba } from '../lib/map-colors';

export interface QueryState {
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export interface LegendSectionProps {
  operations: { model: OperationsModel | null; q: QueryState };
  movement: { model: MovementModel | null; q: QueryState; count: number };
  hosting: { model: HostingModel | null; q: QueryState };
  baseline: {
    model: BaselineModel | null; q: QueryState; measure: Measure; snapshotDate: string | null;
    geometryError: Error | null; period: string | null;
    bot: { model: BotShareModel | null; q: QueryState };
  };
  campaigns: { model: CampaignsModel | null; q: QueryState };
  velocity: { model: VelocityModel | null; q: QueryState };
  /** Takedown outcomes (Baseline / Hosting, Takedowns measure). `window` is the server's window: '30d' or '90d'. */
  takedowns: {
    window: string;
    countries: { model: TakedownCountryModel | null; q: QueryState };
    providers: { model: TakedownProviderModel | null; q: QueryState };
  };
  actors: { model: ActorModel | null; list: ActorListItem[]; listQ: QueryState; detailQ: QueryState | null; selectedId: string | null };
  onPickActor: (id: string | null) => void;
}

const LABEL = 'font-mono text-[10px] uppercase tracking-wider';
const TEXT = 'font-mono text-[10px]';

function Swatch({ color, ring, dashed, square, halo }: { color: string; ring?: boolean; dashed?: boolean; square?: boolean; halo?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{
        width: 10, height: 10, borderRadius: square ? 2 : '50%', flexShrink: 0,
        background: ring ? 'transparent' : color,
        border: ring || dashed ? `1.5px ${dashed ? 'dashed' : 'solid'} ${color}` : 'none',
        // `halo`: a filled dot with a separate ring around it (the very-fast nodes' static ring on the map).
        boxShadow: halo ? `0 0 0 2px var(--bg-card-deep), 0 0 0 3.5px ${color}` : '0 0 0 1px rgba(0,0,0,0.3)',
        ...(halo ? { margin: 3 } : null),
      }}
    />
  );
}

function Row({ children, swatch }: { children: ReactNode; swatch: ReactNode }) {
  return <li className={`${TEXT} flex items-center gap-2`} style={{ color: 'var(--text-secondary)' }}>{swatch}<span className="min-w-0">{children}</span></li>;
}

export function Status({ q, empty, emptyText, what }: { q: QueryState; empty: boolean; emptyText: string; what: string }) {
  if (q.isLoading) return <div role="status" className={TEXT} style={{ color: 'var(--text-tertiary)' }}>Loading {what}…</div>;
  if (q.error) {
    return (
      <div role="alert" className={`${TEXT} flex items-center justify-between gap-2`} style={{ color: 'var(--sev-critical-text)' }}>
        <span>{what} failed to load</span>
        <button type="button" onClick={() => void q.refetch()} className="ds-focusable inline-flex items-center gap-1 uppercase font-bold" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>
          <RefreshCw size={10} /> Retry
        </button>
      </div>
    );
  }
  if (empty) return <div role="status" className={TEXT} style={{ color: 'var(--text-tertiary)' }}>{emptyText}</div>;
  return null;
}

function Section({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <h3 id={id} className={LABEL} style={{ color: 'var(--text-tertiary)', margin: 0 }}>{title}</h3>
      {children}
    </section>
  );
}

const css = (c: Rgba): string => rgbCss(c);

export function OperationsSection({ s }: { s: LegendSectionProps['operations'] }) {
  const m = s.model;
  return (
    <Section title="Operations" id="lg-ops">
      <Status q={s.q} what="operations" empty={!!m && m.nodes.length === 0} emptyText="No active operations with a known country." />
      {m && m.nodes.length > 0 && (
        <>
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            <Row swatch={<Swatch color="rgb(122, 234, 255)" />}>Operation in a country. Nodes of one operator pulse in unison.</Row>
            <Row swatch={<Swatch color="rgb(122, 234, 255)" dashed />}>Linked by shared evidence. The label says what: ◆ cert, ● IP, ▲ ASN ×count. Hover a link for the full detail.</Row>
          </ul>
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            {m.placedOps.size} operations · {m.nodes.length} country nodes · {m.edges.length} links
            {m.unplaced > 0 && ` · ${m.unplaced} country entries not placeable`}
          </div>
        </>
      )}
    </Section>
  );
}

export function MovementSection({ s }: { s: LegendSectionProps['movement'] }) {
  const m = s.model;
  const drawn = m ? m.hops.length + m.pulses.length : 0;
  return (
    <Section title="Infrastructure movement" id="lg-move">
      <Status q={s.q} what="movements" empty={!!m && drawn === 0} emptyText={s.count === 0 ? 'No infrastructure moves detected in this period.' : 'Detected moves have no placeable country.'} />
      {m && drawn > 0 && (
        <>
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            <Row swatch={<Swatch color="rgb(167, 139, 250)" />}>Trail: infrastructure hopping to a new host, in sequence.</Row>
            <Row swatch={<Swatch color="rgb(167, 139, 250)" ring />}>Ghost: where it used to be.</Row>
            <Row swatch={<Swatch color="rgb(148, 163, 184)" ring />}>Went dark, or arrived with the origin not recorded.</Row>
          </ul>
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            {s.count} events · {m.hops.filter(h => !h.id.endsWith(':w')).length} hops
            {m.unplaced > 0 && ` · ${m.unplaced} not placeable`}
          </div>
        </>
      )}
    </Section>
  );
}

export function HostingSection({ s }: { s: LegendSectionProps['hosting'] }) {
  const m = s.model;
  return (
    <Section title="Hosting providers" id="lg-host">
      <Status q={s.q} what="providers" empty={!!m && m.rings.length === 0} emptyText="No providers with active threats and a known country." />
      {m && m.rings.length > 0 && (
        <>
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            <Row swatch={<Swatch color={css(TREND_COLORS.rising)} />}>Rising this week</Row>
            <Row swatch={<Swatch color={css(TREND_COLORS.falling)} />}>Falling this week</Row>
            <Row swatch={<Swatch color={css(TREND_COLORS.flat)} />}>Steady</Row>
            <Row swatch={<Swatch color="var(--sev-critical)" dashed />}>Bulletproof host (rotating dashes)</Row>
            {m.rings.some(r => r.takedownShare !== null) && <Row swatch={<Swatch color="var(--green)" ring />}>Green arc: share of resolved takedowns that succeeded</Row>}
          </ul>
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            Ring size = active threats · {m.rings.length} providers
            {m.unplaced > 0 && ` · ${m.unplaced} without a country not shown`}
          </div>
        </>
      )}
    </Section>
  );
}

const TAKEDOWN_GRADIENT = `linear-gradient(90deg, ${TAKEDOWN_STOPS.map(st => `${css(st.color)} ${Math.round(st.t * 100)}%`).join(', ')})`;

/** The key both takedown views share: the sequential green scale and the grey "too few" outline. */
function TakedownScale({ what }: { what: string }) {
  return (
    <>
      <div role="img" aria-label="Colour scale: dark green, few taken down, to bright green, most taken down" style={{ height: 8, borderRadius: 4, background: TAKEDOWN_GRADIENT }} />
      <div className={`${TEXT} flex justify-between`} style={{ color: 'var(--text-secondary)' }}>
        <span>0% taken down</span><span>100%</span>
      </div>
      <ul className="list-none p-0 m-0">
        <Row swatch={<Swatch color={css(TAKEDOWN_SMALL_OUTLINE)} />}>
          Grey: fewer than {TAKEDOWN_MIN_RESOLVED} resolved takedowns, too few for a rate ({what} left out of the ranking)
        </Row>
      </ul>
    </>
  );
}

export function TakedownCountrySection({ s, window }: { s: LegendSectionProps['takedowns']['countries']; window: string }) {
  const m = s.model;
  return (
    <Section title="Takedown success by country" id="lg-td-country">
      <Status q={s.q} what="takedown outcomes" empty={!!m && m.rows.size === 0} emptyText={`No takedowns were submitted in the last ${window}.`} />
      {m && m.rows.size > 0 && (
        <>
          <TakedownScale what="countries" />
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            Taken down ÷ (taken down + refused + expired), for takedowns submitted in the last {window} (whole UTC days).
            {` ${m.withRate} ${m.withRate === 1 ? 'country' : 'countries'} with a rate, ${m.tooSmall} too small.`}
            {m.unknownSubmitted > 0 && ` ${m.unknownSubmitted.toLocaleString()} takedowns have no known country and are not mapped.`}
          </div>
        </>
      )}
    </Section>
  );
}

export function TakedownProviderSection({ s, window }: { s: LegendSectionProps['takedowns']['providers']; window: string }) {
  const m = s.model;
  return (
    <Section title="Takedown success by host" id="lg-td-host">
      <Status q={s.q} what="takedown outcomes" empty={!!m && m.rows.size === 0} emptyText={`No takedowns were submitted in the last ${window}.`} />
      {m && m.rows.size > 0 && (
        <>
          <TakedownScale what="hosts" />
          <ul className="list-none p-0 m-0">
            <Row swatch={<Swatch color="var(--green)" ring />}>Green arc: the same share, as a fraction of the ring</Row>
          </ul>
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            Ring size = active threats. Share = taken down ÷ (taken down + refused + expired), for takedowns submitted in the last {window}.
            {` ${m.withRate} ${m.withRate === 1 ? 'host' : 'hosts'} with a rate, ${m.tooSmall} too small.`}
            {m.undrawn > 0 && ` ${m.undrawn} more ${m.undrawn === 1 ? 'host has' : 'hosts have'} a takedown history but no active threats, and ${m.undrawn === 1 ? 'is' : 'are'} listed in the panel only.`}
          </div>
        </>
      )}
    </Section>
  );
}

export function BaselineSection({ s }: { s: LegendSectionProps['baseline'] }) {
  const m = s.model;
  const gradient = `linear-gradient(90deg, ${OVERINDEX_STOPS.map(st => `${css(st.color)} ${Math.round(st.t * 100)}%`).join(', ')})`;
  if (s.measure === 'bot') return <BotShareSection bot={s.bot} />;
  return (
    <Section title={s.measure === 'index' ? 'Over-index vs Radar' : 'Raw volume'} id="lg-base">
      <Status q={s.q} what="baseline" empty={!!m && m.rows.size === 0} emptyText="No country data for this period." />
      {s.geometryError && <div role="alert" className={TEXT} style={{ color: 'var(--sev-critical-text)' }}>Country shapes failed to load.</div>}
      {m && m.rows.size > 0 && (
        s.measure === 'index' ? (
          <>
            <div className="relative">
              <div role="img" aria-label="Colour scale: blue under-index, slate at 1×, red over-index" style={{ height: 8, borderRadius: 4, background: gradient }} />
              {/* 1× tick: where "normal" sits on the scale */}
              <span aria-hidden className="absolute" style={{ left: '50%', top: -3, width: 2, height: 14, marginLeft: -1, background: 'var(--text-primary)', borderRadius: 1 }} />
            </div>
            <div className={`${TEXT} flex justify-between`} style={{ color: 'var(--text-secondary)' }}>
              <span>¼× under</span><span>1×</span><span>4× over</span>
            </div>
            <ul className="list-none p-0 m-0">
              <Row swatch={<Swatch color={css(NO_BASELINE_OUTLINE)} ring square />}>Outlined: outside Radar&apos;s top list, no baseline</Row>
            </ul>
            <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
              Our share of threats ÷ Radar&apos;s attack-origin share ({s.period ?? '7d'}).
              {s.snapshotDate ? ` Radar snapshot ${s.snapshotDate}.` : ' No Radar snapshot yet.'}
              {` ${m.withBaseline} countries with a baseline, ${m.withoutBaseline} without.`}
            </div>
          </>
        ) : (
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            Raw count of active, geolocated threats per country ({s.period ?? '7d'}), √ scale. Switch to Over-index to
            normalise by general attack traffic.
          </div>
        )
      )}
    </Section>
  );
}

function BotShareSection({ bot }: { bot: LegendSectionProps['baseline']['bot'] }) {
  const m = bot.model;
  return (
    <Section title="Bot share of traffic" id="lg-bot">
      <Status q={bot.q} what="bot share" empty={!!m && m.rows.size === 0} emptyText="No bot-share data yet." />
      {m && m.rows.size > 0 && (
        <>
          <div role="img" aria-label={`Colour scale from ${formatPct(m.domain.minBot)} to ${formatPct(m.domain.maxBot)} bot share`}
            style={{ height: 8, borderRadius: 4, background: botGradient(m) }} />
          <div className={`${TEXT} flex justify-between`} style={{ color: 'var(--text-secondary)' }}>
            <span>{formatPct(m.domain.minBot)}</span><span>{formatPct(m.domain.maxBot)}</span>
          </div>
          <ul className="list-none p-0 m-0">
            <Row swatch={<span aria-hidden style={{ width: 10, height: 10, borderRadius: 2, background: '#0b1220', border: '1.5px solid rgb(255,255,255)', flexShrink: 0 }} />}>
              Outlined: above the global average{m.globalAvg != null ? ` (${formatPct(m.globalAvg)})` : ''}
            </Row>
          </ul>
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            Source: Cloudflare Radar{m.asOf ? ` · as of ${m.asOf}` : ''} · {m.rows.size} countries. ≥ / ≤ marks an estimate bound.
          </div>
          <Link to={tabUrl('bot-traffic')} className={`${TEXT} underline`} style={{ color: 'var(--amber-text)' }}>View as table (Bot Traffic tab)</Link>
        </>
      )}
    </Section>
  );
}

/** Low -> mid -> high along the same stops the map uses (read back from the model's own colours). */
function botGradient(m: BotShareModel): string {
  const sorted = [...m.rows.values()].sort((a, b) => a.bot_pct - b.bot_pct);
  const pick = (i: number) => m.colors.get(sorted[Math.max(0, Math.min(sorted.length - 1, i))]!.code)!;
  const lo = pick(0);
  const mid = pick(Math.floor(sorted.length / 2));
  const hi = pick(sorted.length - 1);
  return `linear-gradient(90deg, ${css(lo)}, ${css(mid)}, ${css(hi)})`;
}

export function VelocitySection({ s }: { s: LegendSectionProps['velocity'] }) {
  const m = s.model;
  return (
    <Section title="Fast weaponization" id="lg-fast">
      <Status q={s.q} what="fast weaponization" empty={!!m && m.points.length === 0} emptyText={VELOCITY_FILLING} />
      {m && m.points.length > 0 && (
        <>
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            <Row swatch={<Swatch color={VELOCITY_RGB} halo />}>Very fast: live within 24h of registration. Solid, with a ring (and a pulse when motion is on).</Row>
            <Row swatch={<span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: VELOCITY_RGB, opacity: 0.45, boxShadow: '0 0 0 1px rgba(0,0,0,0.3)' }} />}>Fast: live within 72h. Lighter, no ring.</Row>
          </ul>
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            Node size = very fast + fast threats · {m.points.length} countries · {m.total.toLocaleString()} threats.
            Evidence about how an operator works, not a severity. Always all sources.
            {m.dropped > 0 && ` ${m.dropped.toLocaleString()} without a placeable country not shown.`}
            {' '}Coverage fills as the cube healer runs, so recent threats may be missing.
          </div>
        </>
      )}
    </Section>
  );
}

export function CampaignsSection({ s }: { s: LegendSectionProps['campaigns'] }) {
  const m = s.model;
  return (
    <Section title="Campaigns · curated" id="lg-camp">
      <Status q={s.q} what="campaigns" empty={!!m && m.arcs.length === 0} emptyText="No curated campaign has placeable adversary and target countries." />
      {m && m.arcs.length > 0 && (
        <>
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            <Row swatch={<Swatch color="rgb(244, 114, 182)" dashed />}>Adversary → target (long dashes). Curated, not observed traffic.</Row>
            <Row swatch={<Swatch color="rgb(244, 114, 182)" />}>Adversary country</Row>
            <Row swatch={<Swatch color="rgb(244, 114, 182)" ring />}>Target country</Row>
          </ul>
          <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
            {m.drawn.size} campaigns · {m.arcs.length} links
            {m.truncated > 0 && ` · ${m.truncated} not drawn (caps)`}
            {m.unplaced > 0 && ` · ${m.unplaced} countries not placeable`}
          </div>
        </>
      )}
    </Section>
  );
}

export function ActorsSection({ s, onPickActor }: { s: LegendSectionProps['actors']; onPickActor: (id: string | null) => void }) {
  const m = s.model;
  return (
    <Section title="Actor" id="lg-actor">
      <Select
        aria-label="Actor"
        value={s.selectedId ?? ''}
        onChange={e => onPickActor(e.target.value || null)}
        disabled={s.listQ.isLoading}
      >
        <option value="">{s.listQ.isLoading ? 'Loading actors…' : 'Choose an actor…'}</option>
        {s.list.map(a => <option key={a.id} value={a.id}>{a.name} · {a.cluster_count} cluster{a.cluster_count === 1 ? '' : 's'}</option>)}
      </Select>
      <Status q={s.listQ} what="actors" empty={s.list.length === 0} emptyText="No actors are on file." />
      {s.selectedId && s.detailQ && <Status q={s.detailQ} what="actor" empty={false} emptyText="" />}
      {s.selectedId && m && (
        m.empty ? (
          <div role="status" className={TEXT} style={{ color: 'var(--text-tertiary)' }}>
            No infrastructure is attributed to this actor yet. That reflects attribution coverage, not the absence of
            activity.
          </div>
        ) : (
          <>
            <ul className="list-none p-0 m-0 flex flex-col gap-1">
              <Row swatch={<Swatch color="rgb(240, 171, 252)" />}>Country with attributed infrastructure; brighter = higher confidence</Row>
              <Row swatch={<Swatch color="rgb(240, 171, 252)" dashed />}>Cluster spanning countries</Row>
            </ul>
            <div className={TEXT} style={{ color: 'var(--text-muted)' }}>
              {m.countries.length} countries · {m.asns.length} ASNs · {m.clusters.length} clusters
              {m.unplaced > 0 && ` · ${m.unplaced} items without a placeable country`}
            </div>
          </>
        )
      )}
      {!s.selectedId && <div className={TEXT} style={{ color: 'var(--text-muted)' }}>Pick an actor to light up its known infrastructure.</div>}
    </Section>
  );
}

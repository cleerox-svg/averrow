/**
 * Legend + status for the lens layers that are switched on. One section per
 * layer: what the marks mean (generated from the same colour tables the WebGL
 * layers use), how many objects are drawn, anything that could not be placed,
 * and an honest empty / loading / error state — an empty lens never reads as
 * "nothing is happening".
 */

import { Card } from '@/design-system/components';
import { Select } from '@averrow/shared/ui';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LayerId, LayerToggles } from '../lib/lenses';
import type { Measure } from '../lib/url-state';
import type { OperationsModel } from '../lib/lens/operations';
import type { MovementModel } from '../lib/lens/movement';
import type { HostingModel } from '../lib/lens/hosting';
import { TREND_COLORS } from '../lib/lens/hosting';
import type { BaselineModel } from '../lib/lens/baseline';
import { OVERINDEX_STOPS, NO_BASELINE_COLOR } from '../lib/lens/baseline';
import type { CampaignsModel } from '../lib/lens/campaigns';
import type { ActorModel } from '../lib/lens/actors';
import type { ActorListItem } from '@/hooks/useObservatoryLenses';
import { rgbCss, type Rgba } from '../lib/map-colors';

export interface QueryState {
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export interface LensLegendProps {
  layers: LayerToggles;
  operations: { model: OperationsModel | null; q: QueryState };
  movement: { model: MovementModel | null; q: QueryState; count: number };
  hosting: { model: HostingModel | null; q: QueryState };
  baseline: { model: BaselineModel | null; q: QueryState; measure: Measure; snapshotDate: string | null; geometryError: Error | null; period: string | null };
  campaigns: { model: CampaignsModel | null; q: QueryState };
  actors: { model: ActorModel | null; list: ActorListItem[]; listQ: QueryState; detailQ: QueryState | null; selectedId: string | null };
  onMeasure: (m: Measure) => void;
  onPickActor: (id: string | null) => void;
  /** Collapsed by default on short viewports. */
  className?: string;
  style?: React.CSSProperties;
}

const LABEL = 'font-mono text-[10px] uppercase tracking-wider';
const TEXT = 'font-mono text-[10px]';

function Swatch({ color, ring, dashed }: { color: string; ring?: boolean; dashed?: boolean }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0"
      style={{
        width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
        background: ring ? 'transparent' : color,
        border: ring || dashed ? `1.5px ${dashed ? 'dashed' : 'solid'} ${color}` : 'none',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.3)',
      }}
    />
  );
}

function Row({ children, swatch }: { children: ReactNode; swatch: ReactNode }) {
  return <li className={`${TEXT} flex items-center gap-2`} style={{ color: 'var(--text-secondary)' }}>{swatch}<span className="min-w-0">{children}</span></li>;
}

function Status({ q, empty, emptyText, what }: { q: QueryState; empty: boolean; emptyText: string; what: string }) {
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

function OperationsSection({ s }: { s: LensLegendProps['operations'] }) {
  const m = s.model;
  return (
    <Section title="Operations" id="lg-ops">
      <Status q={s.q} what="operations" empty={!!m && m.nodes.length === 0} emptyText="No active operations with a known country." />
      {m && m.nodes.length > 0 && (
        <>
          <ul className="list-none p-0 m-0 flex flex-col gap-1">
            <Row swatch={<Swatch color="rgb(122, 234, 255)" />}>Operation in a country. Nodes of one operator pulse in unison.</Row>
            <Row swatch={<Swatch color="rgb(122, 234, 255)" dashed />}>Linked by shared evidence (cert, IP, ASN).</Row>
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

function MovementSection({ s }: { s: LensLegendProps['movement'] }) {
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

function HostingSection({ s }: { s: LensLegendProps['hosting'] }) {
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
            <Row swatch={<Swatch color="rgb(248, 113, 113)" dashed />}>Bulletproof host (rotating dashes)</Row>
            {m.rings.some(r => r.takedownShare !== null) && <Row swatch={<Swatch color="rgb(60, 184, 120)" ring />}>Green arc: share of resolved takedowns that succeeded</Row>}
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

function BaselineSection({ s, onMeasure }: { s: LensLegendProps['baseline']; onMeasure: (m: Measure) => void }) {
  const m = s.model;
  const gradient = `linear-gradient(90deg, ${OVERINDEX_STOPS.map(st => `${css(st.color)} ${Math.round(st.t * 100)}%`).join(', ')})`;
  return (
    <Section title="Radar baseline" id="lg-base">
      <div role="group" aria-label="Choropleth measure" className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-base)' }}>
        {([['index', 'Over-index'], ['raw', 'Raw volume']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={s.measure === id}
            onClick={() => onMeasure(id)}
            className="ds-focusable flex-1 font-mono text-[10px] min-h-[30px] max-[899px]:min-h-[44px]"
            style={{
              background: s.measure === id ? 'color-mix(in srgb, var(--amber) 15%, transparent)' : 'transparent',
              color: s.measure === id ? 'var(--amber-text)' : 'var(--text-tertiary)',
              border: 'none', cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Status q={s.q} what="baseline" empty={!!m && m.rows.size === 0} emptyText="No country data for this period." />
      {s.geometryError && <div role="alert" className={TEXT} style={{ color: 'var(--sev-critical-text)' }}>Country shapes failed to load.</div>}
      {m && m.rows.size > 0 && (
        s.measure === 'index' ? (
          <>
            <div role="img" aria-label="Colour scale: blue under-index, dark neutral at 1×, red over-index" style={{ height: 8, borderRadius: 4, background: gradient }} />
            <div className={`${TEXT} flex justify-between`} style={{ color: 'var(--text-secondary)' }}>
              <span>¼× under</span><span>1×</span><span>4× over</span>
            </div>
            <ul className="list-none p-0 m-0">
              <Row swatch={<Swatch color={css(NO_BASELINE_COLOR)} />}>Grey: outside Radar&apos;s top list, no baseline</Row>
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

function CampaignsSection({ s }: { s: LensLegendProps['campaigns'] }) {
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

function ActorsSection({ s, onPickActor }: { s: LensLegendProps['actors']; onPickActor: (id: string | null) => void }) {
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

const ORDER: LayerId[] = ['operations', 'movement', 'hosting', 'baseline', 'campaigns', 'actors'];

export function LensLegend(props: LensLegendProps) {
  const { layers, className, style } = props;
  const active = ORDER.filter(id => layers[id]);
  if (active.length === 0) return null;
  return (
    <Card variant="base" padding="10px 12px" role="group" aria-label="Lens legend" className={className} style={style}>
      <div className="flex flex-col gap-3">
        {active.map(id => {
          switch (id) {
            case 'operations': return <OperationsSection key={id} s={props.operations} />;
            case 'movement': return <MovementSection key={id} s={props.movement} />;
            case 'hosting': return <HostingSection key={id} s={props.hosting} />;
            case 'baseline': return <BaselineSection key={id} s={props.baseline} onMeasure={props.onMeasure} />;
            case 'campaigns': return <CampaignsSection key={id} s={props.campaigns} />;
            case 'actors': return <ActorsSection key={id} s={props.actors} onPickActor={props.onPickActor} />;
            default: return null;
          }
        })}
      </div>
    </Card>
  );
}

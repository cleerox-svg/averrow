/**
 * deck.gl layer builders for the Phase B lenses.
 *
 * Two entry points, mirroring how ThreatMapV3 composes the scene:
 *   - buildLensBaseLayers   — the choropleth, drawn UNDER everything else. Static:
 *                             built in a memo, never per frame.
 *   - buildLensLayers       — everything else, rebuilt each frame with the new
 *                             `seconds` / playhead. EVERY layer's `data` array is
 *                             either a model field or comes out of a memo keyed on
 *                             (model[, selection]) (see ./memo.ts, ./lens-labels.ts),
 *                             so its identity is the same on every frame and a frame
 *                             changes uniforms only (animTime, currentTime).
 *                             layers/lens-layers.test.ts pins this.
 *
 * Selection never rebuilds geometry: it changes a colour/width accessor through
 * `updateTriggers`, which deck re-evaluates once per selection change (and eases
 * over COLOR_TRANSITION_MS via `transitions`).
 *
 * Reduced motion: pulses get amplitude 0, dashes become solid, trails are
 * replaced by static numbered paths, colour transitions are instant. Nothing
 * animates and nothing is hidden.
 */

import { GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { TripsLayer } from '@/lib/trips-layer';
import type { LngLat } from '@/lib/country-centroids';
import type { LayerToggles } from '../lib/lenses';
import type { Measure } from '../lib/url-state';
import type { Rgba } from '../lib/map-colors';
import type { OperationsModel, OpNode, OpEdge } from '../lib/lens/operations';
import { highlightGroup, isDimmed } from '../lib/lens/operations';
import type { HostingModel, ProviderRing } from '../lib/lens/hosting';
import { TREND_COLORS } from '../lib/lens/hosting';
import type { BaselineModel } from '../lib/lens/baseline';
import { NO_DATA_COLOR, NO_BASELINE_OUTLINE, formatRatio } from '../lib/lens/baseline';
import type { BotShareModel } from '../lib/lens/bot-share';
import { botHover } from '../lib/lens/bot-share';
import type { CampaignsModel, CampaignArc } from '../lib/lens/campaigns';
import type { ActorModel, ActorCountry, ActorEdge } from '../lib/lens/actors';
import { actorNodePx, confidenceBand } from '../lib/lens/actors';
import type { VelocityModel, VelocityPoint } from '../lib/lens/velocity';
import { VELOCITY_COLOR } from '../lib/lens/velocity';
import type { MovementModel, MovementHop, MovementPulse } from '../lib/lens/movement';
import { HOP_UNITS, hopLabel } from '../lib/lens/movement';
import { countryCenter } from '../lib/lens/placement';
import { countryName } from '../lib/country-name';
import { COLOR_TRANSITION_MS } from '../lib/motion';
import {
  PulseExtension, RingMaskExtension, DashFlowExtension,
  type PulseExtensionProps, type RingMaskExtensionProps, type DashFlowExtensionProps,
} from '../anim';
import { memoByModel, memoByModelAndKey } from './memo';
import type { PlacedLabels, PlacedEdgeLabel, PlacedHostLabel, PlacedActorLabel } from './lens-labels';

// ─── Types shared with ThreatMapV3 ──────────────────────────

/** Country polygons: GeoJSON, `id` = ISO-2, `properties.n` = English name. */
export interface CountryFeature {
  type: 'Feature';
  id: string;
  properties: { n: string };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
}
export interface CountryCollection {
  type: 'FeatureCollection';
  features: CountryFeature[];
}

export type LensPickKind = 'operation' | 'provider' | 'country' | 'campaign' | 'movement' | 'actor';
export interface LensPick { kind: LensPickKind; id: string }
export interface LensHover { x: number; y: number; title: string; lines: string[] }

/** Stable handler bag (built once per map instance). */
export interface LensPickHandlers {
  hover: (hover: LensHover | null) => void;
  /** `at` is the pointer position, for handlers that pin a tooltip (touch). */
  click: (pick: LensPick, at?: { x: number; y: number }) => boolean;
}

export interface LensSelection {
  opId: string | null;
  providerId: string | null;
  country: string | null;
  campaignId: string | null;
  movementId: string | null;
  actorId: string | null;
}

export const NO_SELECTION: LensSelection = {
  opId: null, providerId: null, country: null, campaignId: null, movementId: null, actorId: null,
};

export interface LensLayerInput {
  layers: LayerToggles;
  operations: OperationsModel | null;
  hosting: HostingModel | null;
  baseline: BaselineModel | null;
  measure: Measure;
  /** Radar bot share per country (Baseline lens, Bot share measure). */
  bot: BotShareModel | null;
  countries: CountryCollection | null;
  campaigns: CampaignsModel | null;
  actors: ActorModel | null;
  movement: MovementModel | null;
  /** Fast-weaponization nodes: non-null only while the Threats lens' Fast view is on. */
  velocity: VelocityModel | null;
  sel: LensSelection;
  /** Labels that fit at the current camera (placed by the map when it settles). */
  labels: PlacedLabels;
  reducedMotion: boolean;
  isMobile: boolean;
  pick: LensPickHandlers;
}

export interface LensFrame {
  /** Monotonic animation seconds (pulses, dashes, spins). */
  seconds: number;
  /** Replay playhead in clock units (movement trails). */
  t: number;
}

// ─── Constants + small helpers ──────────────────────────────

const CYAN: Rgba = [122, 234, 255, 255];
const AMBER: Rgba = [229, 168, 50, 255];
const VIOLET: Rgba = [167, 139, 250, 255];
const SLATE: Rgba = [148, 163, 184, 255];
const FUCHSIA: Rgba = [240, 171, 252, 255];
const PINK: Rgba = [244, 114, 182, 255];
const TEXT_OUTLINE: Rgba = [8, 12, 22, 235];
const TEXT_COLOR: Rgba = [226, 232, 240, 235];
const COUNTRY_LINE: Rgba = [148, 163, 184, 46];
const BOT_ABOVE_LINE: Rgba = [255, 255, 255, 210];
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
/** Label size (px). Nothing on the map is set smaller than 10. */
const LABEL_PX = 11;

const withAlpha = (c: Rgba, a: number): Rgba => [c[0], c[1], c[2], a];
const SOLID_DASH = 1e6;

const PULSE_EXT = [new PulseExtension()];
const MASK_EXT = [new RingMaskExtension()];
const DASH_EXT = [new DashFlowExtension()];

// Constant prop objects: the same reference every frame, so deck's shallow prop diff is a no-op.
const T = COLOR_TRANSITION_MS;
const FILL_CROSSFADE = { getFillColor: 600 } as const;
const TR_PATH = { getColor: T, getWidth: T } as const;
const TR_DOT = { getFillColor: T, getLineColor: T, getLineWidth: T } as const;
const TR_FILL = { getFillColor: T } as const;
const TR_RING = { getRadius: 500, getFillColor: 500, getLineColor: T, getLineWidth: T } as const;

type PickInfo<D> = PickingInfo<D>;
/** The GeoJSON shape GeoJsonLayer accepts (its own `geojson` types aren't a dependency of this package). */
type GeoData = NonNullable<ConstructorParameters<typeof GeoJsonLayer>[0]>['data'];

function posNode(d: { position: [number, number] }): [number, number] { return d.position; }

// ─── Memoised derived data (never computed in the frame path) ──

const subsetFor = memoByModelAndKey((countries: CountryCollection, code: string) => ({
  type: 'FeatureCollection' as const,
  features: countries.features.filter(f => String(f.id) === code),
}));

/** Countries Radar has no baseline for, as one collection (outlined instead of filled). */
const noBaselineShapes = memoByModelAndKey((baseline: BaselineModel, countries: CountryCollection) => ({
  type: 'FeatureCollection' as const,
  features: countries.features.filter(f => {
    const row = baseline.rows.get(String(f.id));
    return !!row && row.ratio === null;
  }),
}));

const hostingParts = memoByModel((m: HostingModel) => ({
  bullet: m.rings.filter(r => r.bulletproof),
  withTakedown: m.rings.filter(r => r.takedownShare !== null),
}));

const opsMax = memoByModel((m: OperationsModel) => m.nodes.reduce((x, n) => Math.max(x, n.threats), 0));

const campaignMarkers = memoByModel((m: CampaignsModel) => {
  // One marker per country, at the country's OWN centroid. (The arc's last vertex can sit on an
  // unwrapped branch past 180 degrees, so it is not the place to read an endpoint from.)
  const adversaries = new Map<string, LngLat>();
  const targets = new Map<string, LngLat>();
  for (const a of m.arcs) {
    const from = countryCenter(a.from);
    const to = countryCenter(a.to);
    if (from) adversaries.set(a.from, from);
    if (to) targets.set(a.to, to);
  }
  const toList = (map: Map<string, LngLat>) => [...map.entries()].map(([cc, position]) => ({ cc, position }));
  return { adversaries: toList(adversaries), targets: toList(targets) };
});

const movementStaticHops = memoByModel((m: MovementModel) => m.hops.filter(h => !h.id.endsWith(':w')));

// ─── Baseline (under everything) ────────────────────────────

const countryTip = (code: string, model: BaselineModel | null, measure: Measure): LensHover => {
  const row = model?.rows.get(code);
  const lines: string[] = [];
  if (row) {
    lines.push(measure === 'index' ? formatRatio(row.ratio) : `${row.our_count.toLocaleString()} threats`);
    if (measure === 'index') lines.push(`${row.our_count.toLocaleString()} threats · ${(row.our_share * 100).toFixed(1)}% of ours`);
    if (row.radar_share !== null) lines.push(`${(row.radar_share * 100).toFixed(1)}% of Radar attack origin`);
  } else {
    lines.push('no data');
  }
  return { x: 0, y: 0, title: countryName(code) || code, lines };
};

const botTip = (code: string, bot: BotShareModel | null): LensHover => {
  const row = bot?.rows.get(code);
  if (!row) return { x: 0, y: 0, title: countryName(code) || code, lines: ['no Radar bot-share data'] };
  const h = botHover(row, bot?.globalAvg ?? null);
  return { x: 0, y: 0, title: h.title, lines: h.lines };
};

export function buildLensBaseLayers(input: LensLayerInput): Layer[] {
  const { layers, baseline, bot, countries, measure, sel, reducedMotion, pick } = input;
  if (!layers.baseline || !countries || countries.features.length === 0) return [];
  const isBot = measure === 'bot';
  const colors = isBot ? bot?.colors ?? null : baseline ? (measure === 'index' ? baseline.indexColors : baseline.rawColors) : null;
  const out: Layer[] = [
    new GeoJsonLayer<{ n: string }>({
      id: 'baseline-countries',
      data: countries as GeoData,
      stroked: true,
      filled: true,
      getFillColor: f => colors?.get(String(f.id)) ?? NO_DATA_COLOR,
      getLineColor: f => (isBot && bot?.above.has(String(f.id)) ? BOT_ABOVE_LINE : COUNTRY_LINE),
      getLineWidth: f => (isBot && bot?.above.has(String(f.id)) ? 1.4 : 0.5),
      lineWidthUnits: 'pixels',
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 38],
      // The over-index <-> raw <-> bot switch crossfades the fill (deck interpolates the colour attribute).
      transitions: reducedMotion ? undefined : FILL_CROSSFADE,
      updateTriggers: {
        getFillColor: [measure, isBot ? bot : baseline],
        getLineColor: [measure, bot],
        getLineWidth: [measure, bot],
      },
      onHover: info => {
        const f = info.object;
        if (!f) { pick.hover(null); return; }
        const code = String(f.id);
        const tip = isBot ? botTip(code, bot) : countryTip(code, baseline, measure);
        pick.hover({ ...tip, x: info.x, y: info.y });
      },
      onClick: info => {
        const f = info.object;
        if (!f) return false;
        return pick.click({ kind: 'country', id: String(f.id) }, { x: info.x, y: info.y });
      },
    }),
  ];
  if (!isBot && baseline) {
    const shapes = noBaselineShapes(baseline, countries);
    if (shapes.features.length > 0) {
      out.push(new GeoJsonLayer<{ n: string }>({
        id: 'baseline-no-baseline',
        data: shapes as GeoData,
        stroked: true, filled: false,
        getLineColor: NO_BASELINE_OUTLINE, getLineWidth: 1.1, lineWidthUnits: 'pixels',
        pickable: false,
      }));
    }
  }
  if (sel.country) {
    const f = subsetFor(countries, sel.country);
    if (f.features.length > 0) {
      out.push(new GeoJsonLayer<{ n: string }>({
        id: 'baseline-selected',
        data: f as GeoData,
        stroked: true, filled: false,
        getLineColor: AMBER, getLineWidth: 2, lineWidthUnits: 'pixels',
        pickable: false,
      }));
    }
  }
  return out;
}

// ─── Operations ─────────────────────────────────────────────

const OP_ALPHA_BASE = 130;

function opNodeRadius(n: OpNode, maxThreats: number): number {
  const f = maxThreats > 0 ? Math.sqrt(n.threats / maxThreats) : 0;
  return 6 + 10 * Math.min(1, f);
}

/** Pixel radius an operation node's bloom is drawn at (edge labels keep clear of it). */
export function opNodePx(n: OpNode, maxThreats: number): number {
  return opNodeRadius(n, maxThreats) * 2.1;
}

/** Largest operation size, the denominator for node radii (memoised). */
export function opsMaxThreats(m: OperationsModel): number {
  return opsMax(m);
}

function labelStyle() {
  return {
    sizeUnits: 'pixels' as const,
    getColor: TEXT_COLOR,
    outlineWidth: 3,
    outlineColor: TEXT_OUTLINE,
    fontFamily: MONO,
    fontSettings: { sdf: true },
    characterSet: 'auto' as const,
    pickable: false,
  };
}

function opLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const m = input.operations;
  if (!m || m.nodes.length === 0) return [];
  const { sel, reducedMotion, pick, labels } = input;
  const group = highlightGroup(m, sel.opId);
  const maxThreats = opsMax(m);
  const animTime = reducedMotion ? 0 : frame.seconds;
  const out: Layer[] = [];

  if (m.edges.length > 0) {
    out.push(new PathLayer<OpEdge, DashFlowExtensionProps<OpEdge>>({
      id: 'ops-edges',
      data: m.edges,
      getPath: (e: OpEdge) => e.path,
      getDashDistances: (e: OpEdge) => e.distances,
      getColor: (e: OpEdge) => withAlpha(CYAN, isDimmed(e.group, group) ? 36 : e.group === group ? 255 : 200),
      getWidth: (e: OpEdge) => (e.group === group ? 2.6 : 1.6),
      widthUnits: 'pixels',
      capRounded: true,
      pickable: true,
      extensions: DASH_EXT,
      dash: reducedMotion ? SOLID_DASH : 1.1,
      gap: reducedMotion ? 0 : 1.5,
      speed: reducedMotion ? 0 : 2.4,
      animTime,
      transitions: reducedMotion ? undefined : TR_PATH,
      updateTriggers: { getColor: group, getWidth: group },
      // Full evidence lives here (and in the drawer); the map label is the short form.
      onHover: (info: PickInfo<OpEdge>) => pick.hover(info.object
        ? { x: info.x, y: info.y, title: info.object.label, lines: info.object.opIds.map(id => m.byId.get(id)?.name ?? id) }
        : null),
      onClick: (info: PickInfo<OpEdge>) => (info.object ? pick.click({ kind: 'operation', id: info.object.opIds[0]! }) : false),
    }));
  }

  const shared = {
    data: m.nodes,
    getPosition: posNode,
    radiusUnits: 'pixels' as const,
    getPulsePhase: (n: OpNode) => n.phase,
    getPulseRate: () => 2.4,
    getPulseAmp: () => (reducedMotion ? 0 : 0.2),
    updateTriggers: { getPulseAmp: reducedMotion },
    extensions: PULSE_EXT,
    animTime,
  };
  out.push(
    new ScatterplotLayer<OpNode, PulseExtensionProps<OpNode>>({
      ...shared,
      id: 'ops-bloom',
      getRadius: (n: OpNode) => opNodePx(n, maxThreats),
      getFillColor: (n: OpNode) => withAlpha(CYAN, isDimmed(n.group, group) ? 6 : 34),
      transitions: reducedMotion ? undefined : TR_FILL,
      updateTriggers: { ...shared.updateTriggers, getFillColor: group },
    }),
    new ScatterplotLayer<OpNode, PulseExtensionProps<OpNode>>({
      ...shared,
      id: 'ops-core',
      getRadius: (n: OpNode) => opNodeRadius(n, maxThreats),
      getFillColor: (n: OpNode) => withAlpha(CYAN, isDimmed(n.group, group) ? 40 : Math.round(OP_ALPHA_BASE + 110 * (n.confidence ?? 0.5))),
      stroked: true,
      getLineColor: (n: OpNode) => (n.opId === sel.opId ? AMBER : withAlpha(CYAN, isDimmed(n.group, group) ? 40 : 255)),
      getLineWidth: (n: OpNode) => (n.opId === sel.opId ? 2.5 : 1.2),
      lineWidthUnits: 'pixels',
      pickable: true,
      transitions: reducedMotion ? undefined : TR_DOT,
      updateTriggers: { ...shared.updateTriggers, getFillColor: group, getLineColor: [group, sel.opId], getLineWidth: sel.opId },
      onHover: (info: PickInfo<OpNode>) => pick.hover(info.object
        ? {
          x: info.x, y: info.y, title: info.object.name,
          lines: [countryName(info.object.country), `${info.object.threats.toLocaleString()} threats`,
            info.object.confidence !== null ? `${Math.round(info.object.confidence * 100)}% confidence` : 'confidence n/a'],
        }
        : null),
      onClick: (info: PickInfo<OpNode>) => (info.object ? pick.click({ kind: 'operation', id: info.object.opId }) : false),
    }),
  );

  // Edge evidence: short ("◆ cert"), one per operation, laid along the edge, de-duplicated in screen space.
  if (labels.edges.length > 0) {
    out.push(new TextLayer<PlacedEdgeLabel>({
      id: 'ops-edge-labels',
      ...labelStyle(),
      data: labels.edges,
      getPosition: e => e.position,
      getText: e => e.text,
      getAngle: e => -e.angle,
      getSize: LABEL_PX,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
    }));
  }
  return out;
}

// ─── Hosting ────────────────────────────────────────────────

const BULLETPROOF_COLOR: Rgba = [248, 113, 113, 235];
const TAKEDOWN_COLOR: Rgba = [60, 184, 120, 255];
const TRACK_COLOR: Rgba = [148, 163, 184, 46];

function hostingLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const m = input.hosting;
  if (!m || m.rings.length === 0) return [];
  const { sel, reducedMotion, pick, labels } = input;
  const animTime = reducedMotion ? 0 : frame.seconds;
  const { bullet, withTakedown } = hostingParts(m);
  const dimmed = (r: ProviderRing): boolean => sel.providerId !== null && r.id !== sel.providerId;
  const out: Layer[] = [];

  out.push(new ScatterplotLayer<ProviderRing>({
    id: 'hosting-rings',
    data: m.rings,
    getPosition: posNode,
    radiusUnits: 'pixels',
    getRadius: (r: ProviderRing) => r.radiusPx,
    getFillColor: (r: ProviderRing) => withAlpha(TREND_COLORS[r.trend], dimmed(r) ? 14 : 82),
    stroked: true,
    getLineColor: (r: ProviderRing) => (r.id === sel.providerId ? AMBER : withAlpha(TREND_COLORS[r.trend], dimmed(r) ? 50 : 235)),
    getLineWidth: (r: ProviderRing) => (r.id === sel.providerId ? 3 : 1.5),
    lineWidthUnits: 'pixels',
    pickable: true,
    // Size / colour glide when the numbers move (a 15-minute refetch) and when a ring is picked, instead of snapping.
    transitions: reducedMotion ? undefined : TR_RING,
    updateTriggers: { getFillColor: sel.providerId, getLineColor: sel.providerId, getLineWidth: sel.providerId },
    onHover: (info: PickInfo<ProviderRing>) => pick.hover(info.object
      ? {
        x: info.x, y: info.y, title: info.object.name,
        lines: [
          [info.object.asn, countryName(info.object.country)].filter(Boolean).join(' · '),
          `${info.object.active.toLocaleString()} active · ${info.object.trend7} this week (${info.object.trend})`,
          ...(info.object.bulletproof ? ['bulletproof host'] : []),
          ...(info.object.takedownShare !== null ? [`${Math.round(info.object.takedownShare * 100)}% of resolved takedowns succeeded`] : []),
        ],
      }
      : null),
    onClick: (info: PickInfo<ProviderRing>) => (info.object ? pick.click({ kind: 'provider', id: info.object.id }) : false),
  }));

  if (bullet.length > 0) {
    out.push(new ScatterplotLayer<ProviderRing, RingMaskExtensionProps<ProviderRing>>({
      id: 'hosting-bulletproof-halo',
      data: bullet,
      getPosition: posNode,
      radiusUnits: 'pixels',
      getRadius: (r: ProviderRing) => r.radiusPx + 7,
      filled: false,
      stroked: true,
      getLineColor: BULLETPROOF_COLOR,
      getLineWidth: 1.6,
      lineWidthUnits: 'pixels',
      pickable: false,
      extensions: MASK_EXT,
      getMaskDashes: 14,
      getMaskSpin: reducedMotion ? 0 : 0.11,
      animTime,
      updateTriggers: { getMaskSpin: reducedMotion },
    }));
  }

  if (withTakedown.length > 0) {
    // The share of resolved takedowns that succeeded, as an arc: a faint full ring for scale + the arc itself.
    out.push(
      new ScatterplotLayer<ProviderRing>({
        id: 'hosting-takedown-track',
        data: withTakedown,
        getPosition: posNode,
        radiusUnits: 'pixels',
        getRadius: (r: ProviderRing) => r.radiusPx + 3.5,
        filled: false, stroked: true,
        getLineColor: TRACK_COLOR, getLineWidth: 2.5, lineWidthUnits: 'pixels',
        pickable: false,
      }),
      new ScatterplotLayer<ProviderRing, RingMaskExtensionProps<ProviderRing>>({
        id: 'hosting-takedown-arc',
        data: withTakedown,
        getPosition: posNode,
        radiusUnits: 'pixels',
        getRadius: (r: ProviderRing) => r.radiusPx + 3.5,
        filled: false, stroked: true,
        getLineColor: TAKEDOWN_COLOR, getLineWidth: 2.5, lineWidthUnits: 'pixels',
        pickable: false,
        extensions: MASK_EXT,
        getMaskFraction: (r: ProviderRing) => r.takedownShare ?? 0,
        animTime,
      }),
    );
  }

  // Name the biggest providers (and the selected one) that fit without colliding, so the map reads without hovering.
  if (labels.hosts.length > 0) {
    out.push(new TextLayer<PlacedHostLabel>({
      id: 'hosting-labels',
      ...labelStyle(),
      data: labels.hosts,
      getPosition: r => r.position,
      getText: r => r.text,
      getSize: LABEL_PX,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      getPixelOffset: r => [0, r.radiusPx + 10],
    }));
  }
  return out;
}

// ─── Campaigns (curated) ────────────────────────────────────

function campaignLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const m = input.campaigns;
  if (!m || m.arcs.length === 0) return [];
  const { sel, reducedMotion, pick } = input;
  const animTime = reducedMotion ? 0 : frame.seconds;
  const dimmed = (a: CampaignArc): boolean => sel.campaignId !== null && a.campaignId !== sel.campaignId;
  const { adversaries, targets } = campaignMarkers(m);

  return [
    new PathLayer<CampaignArc, DashFlowExtensionProps<CampaignArc>>({
      id: 'campaign-arcs',
      data: m.arcs,
      getPath: (a: CampaignArc) => a.path,
      getDashDistances: (a: CampaignArc) => a.distances,
      getColor: (a: CampaignArc) => withAlpha(a.color, dimmed(a) ? 28 : a.campaignId === sel.campaignId ? 255 : a.color[3]),
      getWidth: (a: CampaignArc) => (a.campaignId === sel.campaignId ? 2.8 : 1.4),
      widthUnits: 'pixels',
      pickable: true,
      extensions: DASH_EXT,
      // Distinct from observed flows: long dashes, slow drift.
      dash: reducedMotion ? SOLID_DASH : 2.2,
      gap: reducedMotion ? 0 : 1.6,
      speed: reducedMotion ? 0 : 1.1,
      animTime,
      transitions: reducedMotion ? undefined : TR_PATH,
      updateTriggers: { getColor: sel.campaignId, getWidth: sel.campaignId },
      onHover: (info: PickInfo<CampaignArc>) => pick.hover(info.object
        ? { x: info.x, y: info.y, title: info.object.name, lines: [`${countryName(info.object.from)} → ${countryName(info.object.to)}`, 'curated, not observed traffic'] }
        : null),
      onClick: (info: PickInfo<CampaignArc>) => (info.object ? pick.click({ kind: 'campaign', id: info.object.campaignId }) : false),
    }),
    new ScatterplotLayer<{ cc: string; position: LngLat }>({
      id: 'campaign-adversaries',
      data: adversaries,
      getPosition: posNode,
      radiusUnits: 'pixels', getRadius: 5,
      getFillColor: withAlpha(PINK, 230),
      pickable: false,
    }),
    new ScatterplotLayer<{ cc: string; position: LngLat }>({
      id: 'campaign-targets',
      data: targets,
      getPosition: posNode,
      radiusUnits: 'pixels', getRadius: 6,
      filled: false, stroked: true,
      getLineColor: withAlpha(PINK, 230), getLineWidth: 1.5, lineWidthUnits: 'pixels',
      pickable: false,
    }),
  ];
}

// ─── Actors ─────────────────────────────────────────────────

const BAND_ALPHA = { high: 235, medium: 170, low: 105, unknown: 80 } as const;

function actorLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const m = input.actors;
  if (!m || m.empty) return [];
  const { reducedMotion, pick, labels } = input;
  const animTime = reducedMotion ? 0 : frame.seconds;
  const bandAlpha = (c: ActorCountry): number => BAND_ALPHA[confidenceBand(c.confidence)];
  const radius = (c: ActorCountry): number => actorNodePx(c.items);
  const shared = {
    data: m.countries,
    getPosition: posNode,
    radiusUnits: 'pixels' as const,
    getPulsePhase: (c: ActorCountry) => c.phase,
    getPulseRate: () => 2.4,
    getPulseAmp: () => (reducedMotion ? 0 : 0.18),
    updateTriggers: { getPulseAmp: reducedMotion },
    extensions: PULSE_EXT,
    animTime,
  };
  const out: Layer[] = [];
  if (m.edges.length > 0) {
    out.push(new PathLayer<ActorEdge, DashFlowExtensionProps<ActorEdge>>({
      id: 'actor-edges',
      data: m.edges,
      getPath: (e: ActorEdge) => e.path,
      getDashDistances: (e: ActorEdge) => e.distances,
      getColor: (e: ActorEdge) => withAlpha(FUCHSIA, e.confidence === null ? 90 : 90 + Math.round(120 * e.confidence)),
      getWidth: 1.5,
      widthUnits: 'pixels',
      extensions: DASH_EXT,
      dash: reducedMotion ? SOLID_DASH : 1,
      gap: reducedMotion ? 0 : 1.4,
      speed: reducedMotion ? 0 : 2,
      animTime,
    }));
  }
  out.push(
    new ScatterplotLayer<ActorCountry, PulseExtensionProps<ActorCountry>>({
      ...shared,
      id: 'actor-bloom',
      getRadius: (c: ActorCountry) => radius(c) * 2,
      getFillColor: (c: ActorCountry) => withAlpha(FUCHSIA, Math.round(bandAlpha(c) * 0.16)),
    }),
    new ScatterplotLayer<ActorCountry, PulseExtensionProps<ActorCountry>>({
      ...shared,
      id: 'actor-core',
      getRadius: radius,
      getFillColor: (c: ActorCountry) => withAlpha(FUCHSIA, Math.round(bandAlpha(c) * 0.55)),
      stroked: true,
      getLineColor: (c: ActorCountry) => withAlpha(FUCHSIA, bandAlpha(c)),
      getLineWidth: 1.6,
      lineWidthUnits: 'pixels',
      pickable: true,
      onHover: (info: PickInfo<ActorCountry>) => pick.hover(info.object
        ? {
          x: info.x, y: info.y, title: countryName(info.object.country),
          lines: [`${info.object.items} attributed item${info.object.items === 1 ? '' : 's'}`,
            `confidence: ${confidenceBand(info.object.confidence)}`, ...(info.object.asns.length ? [info.object.asns.slice(0, 3).join(' ')] : [])],
        }
        : null),
      // Clicking the actor's own footprint keeps the actor selected (an unhandled click would fall
      // through to the map and clear the selection).
      onClick: (info: PickInfo<ActorCountry>) => (info.object ? pick.click({ kind: 'actor', id: m.actorId }) : false),
    }),
  );
  // Country names that fit without clipping at the edge or colliding (placed when the camera settles).
  if (labels.actors.length > 0) {
    out.push(new TextLayer<PlacedActorLabel>({
      id: 'actor-labels',
      ...labelStyle(),
      data: labels.actors,
      getPosition: a => a.position,
      getText: a => a.text,
      getSize: LABEL_PX,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      getPixelOffset: a => [0, a.radiusPx + 10],
    }));
  }
  return out;
}

// ─── Movement ───────────────────────────────────────────────

function movementLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const m = input.movement;
  if (!m || (m.hops.length === 0 && m.pulses.length === 0)) return [];
  const { sel, reducedMotion, pick } = input;
  const animTime = reducedMotion ? 0 : frame.seconds;
  const out: Layer[] = [];
  const dimmedEvent = (id: string): boolean => sel.movementId !== null && id !== sel.movementId;

  if (m.hops.length > 0) {
    // De-duplicate wrapped twins for the static drawing.
    const staticHops = movementStaticHops(m);
    out.push(
      // The trail's history: a faint path that stays after the particle has gone by (reads as "was here, moved").
      new PathLayer<MovementHop>({
        id: 'movement-paths',
        data: staticHops,
        getPath: (h: MovementHop) => h.path,
        getColor: (h: MovementHop) => withAlpha(VIOLET, dimmedEvent(h.eventId) ? 20 : reducedMotion ? 200 : h.eventId === sel.movementId ? 200 : 70),
        getWidth: (h: MovementHop) => (h.eventId === sel.movementId ? 2.8 : reducedMotion ? 2 : 1.2),
        widthUnits: 'pixels',
        capRounded: true,
        pickable: true,
        transitions: reducedMotion ? undefined : TR_PATH,
        updateTriggers: { getColor: [sel.movementId, reducedMotion], getWidth: [sel.movementId, reducedMotion] },
        onHover: (info: PickInfo<MovementHop>) => pick.hover(info.object
          ? {
            x: info.x, y: info.y, title: info.object.clusterName ?? 'Infrastructure movement',
            lines: [`hop ${info.object.index + 1}: ${countryName(info.object.fromCc)} → ${countryName(info.object.toCc)}`],
          }
          : null),
        onClick: (info: PickInfo<MovementHop>) => (info.object ? pick.click({ kind: 'movement', id: info.object.eventId }) : false),
      }),
      // Ghosts: a fading marker where the infrastructure used to be; solid marker where it landed.
      new ScatterplotLayer<MovementHop>({
        id: 'movement-ghosts',
        data: staticHops,
        getPosition: (h: MovementHop) => h.from,
        radiusUnits: 'pixels', getRadius: 5,
        getFillColor: withAlpha(VIOLET, 60),
        stroked: true, getLineColor: withAlpha(VIOLET, 140), getLineWidth: 1, lineWidthUnits: 'pixels',
      }),
      new ScatterplotLayer<MovementHop>({
        id: 'movement-landings',
        data: staticHops,
        getPosition: (h: MovementHop) => h.to,
        radiusUnits: 'pixels', getRadius: 5.5,
        getFillColor: withAlpha(VIOLET, 230),
      }),
    );
    if (reducedMotion) {
      // Numbered static hops stand in for the animation.
      out.push(new TextLayer<MovementHop>({
        id: 'movement-hop-numbers',
        ...labelStyle(),
        data: staticHops,
        getPosition: (h: MovementHop) => h.path[Math.floor(h.path.length / 2)]!,
        getText: hopLabel,
        getSize: 12,
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
      }));
    } else {
      out.push(new TripsLayer({
        id: 'movement-trails',
        data: m.hops,
        getPath: (h: MovementHop) => h.path,
        getTimestamps: (h: MovementHop) => h.timestamps,
        getColor: VIOLET,
        currentTime: frame.t,
        trailLength: HOP_UNITS,
        fadeTrail: true,
        widthMinPixels: 3.5,
        capRounded: true,
      }));
    }
  }

  if (m.pulses.length > 0) {
    out.push(new ScatterplotLayer<MovementPulse, PulseExtensionProps<MovementPulse>>({
      id: 'movement-pulses',
      data: m.pulses,
      getPosition: posNode,
      radiusUnits: 'pixels',
      getRadius: (p: MovementPulse) => (p.kind === 'dormant' ? 9 : 8),
      getFillColor: (p: MovementPulse) => withAlpha(p.kind === 'dormant' ? SLATE : VIOLET, dimmedEvent(p.eventId) ? 30 : 150),
      stroked: true,
      getLineColor: (p: MovementPulse) => withAlpha(p.kind === 'dormant' ? SLATE : VIOLET, dimmedEvent(p.eventId) ? 60 : 240),
      getLineWidth: 1.4,
      lineWidthUnits: 'pixels',
      pickable: true,
      extensions: PULSE_EXT,
      getPulsePhase: 0,
      getPulseRate: 2,
      getPulseAmp: reducedMotion ? 0 : 0.22,
      animTime,
      transitions: reducedMotion ? undefined : TR_DOT,
      updateTriggers: { getFillColor: sel.movementId, getLineColor: sel.movementId, getPulseAmp: reducedMotion },
      onHover: (info: PickInfo<MovementPulse>) => pick.hover(info.object
        ? {
          x: info.x, y: info.y, title: countryName(info.object.cc),
          lines: [info.object.kind === 'dormant' ? 'infrastructure went dark here' : 'infrastructure arrived here (origin not recorded)'],
        }
        : null),
      onClick: (info: PickInfo<MovementPulse>) => (info.object ? pick.click({ kind: 'movement', id: info.object.eventId }) : false),
    }));
  }
  return out;
}

// ─── Fast weaponization (Threats lens, Fast view) ───────────

const VELOCITY_HOT_AMP = 0.26;

function velocityLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const m = input.velocity;
  if (!m || m.points.length === 0) return [];
  const { sel, reducedMotion, pick } = input;
  const animTime = reducedMotion ? 0 : frame.seconds;
  const selected = (p: VelocityPoint): boolean => p.cc === sel.country;
  const shared = {
    data: m.points,
    getPosition: (p: VelocityPoint): [number, number] => p.position,
    radiusUnits: 'pixels' as const,
    // Registered -> live inside a day: those breathe, fast-only nodes are still.
    getPulsePhase: (p: VelocityPoint) => p.phase,
    getPulseRate: () => 3,
    getPulseAmp: (p: VelocityPoint) => (reducedMotion || !p.hot ? 0 : VELOCITY_HOT_AMP),
    updateTriggers: { getPulseAmp: reducedMotion },
    extensions: PULSE_EXT,
    animTime,
  };
  return [
    new ScatterplotLayer<VelocityPoint, PulseExtensionProps<VelocityPoint>>({
      ...shared,
      id: 'velocity-bloom',
      getRadius: (p: VelocityPoint) => p.radiusPx * 2.1,
      getFillColor: (p: VelocityPoint) => withAlpha(VELOCITY_COLOR, p.hot ? 40 : 22),
    }),
    new ScatterplotLayer<VelocityPoint, PulseExtensionProps<VelocityPoint>>({
      ...shared,
      id: 'velocity-core',
      getRadius: (p: VelocityPoint) => p.radiusPx,
      // Very-fast nodes are solid, fast-only ones lighter, so the two classes read without a legend lookup.
      getFillColor: (p: VelocityPoint) => withAlpha(VELOCITY_COLOR, p.hot ? 200 : 105),
      stroked: true,
      getLineColor: (p: VelocityPoint) => (selected(p) ? AMBER : withAlpha(VELOCITY_COLOR, 255)),
      getLineWidth: (p: VelocityPoint) => (selected(p) ? 2.5 : 1.2),
      lineWidthUnits: 'pixels',
      pickable: true,
      transitions: reducedMotion ? undefined : TR_DOT,
      updateTriggers: { ...shared.updateTriggers, getLineColor: sel.country, getLineWidth: sel.country },
      onHover: (info: PickInfo<VelocityPoint>) => pick.hover(info.object
        ? {
          x: info.x, y: info.y, title: countryName(info.object.cc),
          lines: [
            `${info.object.count.toLocaleString()} fast-weaponized`,
            `${info.object.veryFast.toLocaleString()} very fast (≤ 24h) · ${info.object.fast.toLocaleString()} fast (≤ 72h)`,
          ],
        }
        : null),
      onClick: (info: PickInfo<VelocityPoint>) => (info.object ? pick.click({ kind: 'country', id: info.object.cc }) : false),
    }),
  ];
}

// ─── Public ─────────────────────────────────────────────────

/** Animated lens layers, drawn above the threat layers. */
export function buildLensLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const { layers } = input;
  const out: Layer[] = [];
  if (layers.campaigns) out.push(...campaignLayers(input, frame));
  if (layers.hosting) out.push(...hostingLayers(input, frame));
  if (layers.operations) out.push(...opLayers(input, frame));
  if (layers.actors) out.push(...actorLayers(input, frame));
  if (layers.movement) out.push(...movementLayers(input, frame));
  if (input.velocity) out.push(...velocityLayers(input, frame));
  return out;
}

/**
 * True when any lens layer needs the per-frame loop (pulses, dashes, spins, or
 * trails while the replay plays). Static scenes (a choropleth, rings without a
 * halo, the trails of a paused replay) need no frames at all.
 */
export function lensNeedsFrame(
  input: Pick<LensLayerInput, 'layers' | 'operations' | 'hosting' | 'campaigns' | 'actors' | 'movement' | 'velocity'>,
  opts: { clockPlaying?: boolean } = {},
): boolean {
  const { layers } = input;
  const playing = opts.clockPlaying ?? true;
  return !!(
    (layers.operations && input.operations && input.operations.nodes.length > 0) ||
    (layers.hosting && input.hosting && input.hosting.rings.some(r => r.bulletproof)) ||
    (layers.campaigns && input.campaigns && input.campaigns.arcs.length > 0) ||
    (layers.actors && input.actors && !input.actors.empty) ||
    (layers.movement && input.movement && (input.movement.pulses.length > 0 || (playing && input.movement.hops.length > 0))) ||
    // Only very-fast nodes pulse: a fast-only scene is a still picture.
    (input.velocity && input.velocity.points.some(p => p.hot))
  );
}

/** Layer ids that can be picked (kept for tests / docs). */
export const LENS_PICKABLE_IDS = [
  'baseline-countries', 'ops-edges', 'ops-core', 'hosting-rings', 'campaign-arcs', 'actor-core', 'movement-paths', 'movement-pulses', 'velocity-core',
] as const;

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
import { GLOBE_SCREEN_SPACE_PARAMETERS, type Projection } from '../lib/projection';
import type { Rgba } from '../lib/map-colors';
import type { OperationsModel, OpNode, OpEdge } from '../lib/lens/operations';
import { visibleEdges, nodeInFootprint } from '../lib/lens/operations';
import { PrimaryPathLayer, PrimaryTextLayer } from './primary-copy';
import { globeEdgePath } from '../lib/lens/operations-globe';
import {
  opCountRange, opNodeRadius, opNodePx, opNodesDrawOrder, opEdgeStyle, maxPairOps, OP_EDGE_UNDERLAY,
} from '../lib/lens/operations-draw';
import type { HostingModel, ProviderRing } from '../lib/lens/hosting';
import { TREND_COLORS } from '../lib/lens/hosting';
import type { BaselineModel } from '../lib/lens/baseline';
import { NO_DATA_COLOR, NO_BASELINE_OUTLINE, formatRatio } from '../lib/lens/baseline';
import type { BotShareModel } from '../lib/lens/bot-share';
import { botHover } from '../lib/lens/bot-share';
import type { CampaignsModel, CampaignArc } from '../lib/lens/campaigns';
import type { ActorModel, ActorCountry, ActorEdge } from '../lib/lens/actors';
import { actorNodePx, confidenceBand } from '../lib/lens/actors';
import type { TakedownCountryModel, TakedownProviderModel } from '../lib/lens/takedowns';
import { TAKEDOWN_SMALL_COLOR, TAKEDOWN_SMALL_OUTLINE, takedownFacts, takedownOutline } from '../lib/lens/takedowns';
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
import { NODE_LABEL_GAP, MOVE_LABEL_LIFT, type PlacedLabels, type PlacedEdgeLabel, type PlacedHostLabel, type PlacedActorLabel, type PlacedNodeLabel } from './lens-labels';

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
  /** A panel row under the pointer: its links are previewed, nothing is selected. */
  previewOpId?: string | null;
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
  /** Takedown success by country (Baseline lens, Takedowns measure). Needs `manage_takedowns`; null otherwise. */
  takedownCountries: TakedownCountryModel | null;
  /** The hosting rings with takedown outcomes (Hosting lens, Takedowns measure). Needs `manage_takedowns`; null otherwise. */
  takedownProviders: TakedownProviderModel | null;
  sel: LensSelection;
  /** Labels that fit at the current camera (placed by the map when it settles). */
  labels: PlacedLabels;
  reducedMotion: boolean;
  isMobile: boolean;
  pick: LensPickHandlers;
  /** The projection the layers are drawn in (default flat): the globe draws text without the depth test. */
  projection?: Projection;
  /** Multiplier for halo radii (blooms, provider rings, their rings), 0.4..1: smaller toward the world view (lib/halo.ts). Default 1. */
  haloScale?: number;
}

/** Smallest radius (px) a scaled halo is drawn at: it must still read as a halo round its core. */
const MIN_HALO_PX = 3;
/**
 * A halo radius (px) at the input's zoom scale. The floor only stops a halo shrinking away to nothing: it never
 * enlarges one, so a radius already under the floor is left as it is.
 */
export const haloPx = (px: number, scale: number | undefined): number => {
  if (scale === undefined || scale >= 1 || px < MIN_HALO_PX) return px;
  return Math.max(MIN_HALO_PX, px * scale);
};

/** Smallest radial gap (px) between the takedown track and the bulletproof halo outside it, at any zoom scale. */
export const MIN_HALO_GAP_PX = 2.5;
/** Offset (px) of the takedown track / arc from a provider ring. */
export const takedownTrackPx = (scale: number | undefined): number => haloPx(3.5, scale);
/** Offset (px) of the bulletproof halo from a provider ring: always at least `MIN_HALO_GAP_PX` outside the takedown track. */
export const bulletproofHaloPx = (scale: number | undefined): number => takedownTrackPx(scale) + Math.max(MIN_HALO_GAP_PX, haloPx(3.5, scale));

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

/** Countries whose takedown sample is too small for a rate: outlined grey instead of filled. */
const takedownSmallShapes = memoByModelAndKey((m: TakedownCountryModel, countries: CountryCollection) => ({
  type: 'FeatureCollection' as const,
  features: countries.features.filter(f => m.small.has(String(f.id))),
}));

/** Countries with a rate (the complement of `small`): outlined in their own hue. */
const takedownRatedShapes = memoByModelAndKey((m: TakedownCountryModel, countries: CountryCollection) => ({
  type: 'FeatureCollection' as const,
  features: countries.features.filter(f => m.colors.has(String(f.id)) && !m.small.has(String(f.id))),
}));

const hostingParts = memoByModel((m: HostingModel) => ({
  bullet: m.rings.filter(r => r.bulletproof),
  withTakedown: m.rings.filter(r => r.takedownShare !== null),
}));

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

const takedownTip = (code: string, model: TakedownCountryModel | null): LensHover => {
  const row = model?.rows.get(code);
  return { x: 0, y: 0, title: countryName(code) || code, lines: row ? takedownFacts(row) : ['no takedowns submitted in this window'] };
};

const botTip = (code: string, bot: BotShareModel | null): LensHover => {
  const row = bot?.rows.get(code);
  if (!row) return { x: 0, y: 0, title: countryName(code) || code, lines: ['no Radar bot-share data'] };
  const h = botHover(row, bot?.globalAvg ?? null);
  return { x: 0, y: 0, title: h.title, lines: h.lines };
};

export function buildLensBaseLayers(input: LensLayerInput): Layer[] {
  const { layers, baseline, bot, countries, measure, sel, reducedMotion, pick, takedownCountries } = input;
  if (!layers.baseline || !countries || countries.features.length === 0) return [];
  const isBot = measure === 'bot';
  const isTakedown = measure === 'takedowns';
  const colors = isBot ? bot?.colors ?? null
    : isTakedown ? takedownCountries?.colors ?? null
      : baseline ? (measure === 'index' ? baseline.indexColors : baseline.rawColors) : null;
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
        getFillColor: [measure, isBot ? bot : isTakedown ? takedownCountries : baseline],
        getLineColor: [measure, bot],
        getLineWidth: [measure, bot],
      },
      onHover: info => {
        const f = info.object;
        if (!f) { pick.hover(null); return; }
        const code = String(f.id);
        const tip = isBot ? botTip(code, bot) : isTakedown ? takedownTip(code, takedownCountries) : countryTip(code, baseline, measure);
        pick.hover({ ...tip, x: info.x, y: info.y });
      },
      onClick: info => {
        const f = info.object;
        if (!f) return false;
        return pick.click({ kind: 'country', id: String(f.id) }, { x: info.x, y: info.y });
      },
    }),
  ];
  if (isTakedown && takedownCountries) {
    // A same-hue 60% outline on every RATED country: where two similar greens touch, the border still reads.
    const rated = takedownRatedShapes(takedownCountries, countries);
    if (rated.features.length > 0) {
      out.push(new GeoJsonLayer<{ n: string }>({
        id: 'takedown-rated-outline',
        data: rated as GeoData,
        stroked: true, filled: false,
        getLineColor: f => takedownOutline(takedownCountries.colors.get(String(f.id)) ?? TAKEDOWN_SMALL_COLOR),
        getLineWidth: 1.1, lineWidthUnits: 'pixels',
        updateTriggers: { getLineColor: [takedownCountries] },
        pickable: false,
      }));
    }
    const shapes = takedownSmallShapes(takedownCountries, countries);
    if (shapes.features.length > 0) {
      out.push(new GeoJsonLayer<{ n: string }>({
        id: 'takedown-small-sample',
        data: shapes as GeoData,
        stroked: true, filled: false,
        getLineColor: TAKEDOWN_SMALL_OUTLINE, getLineWidth: 1.1, lineWidthUnits: 'pixels',
        pickable: false,
      }));
    }
  } else if (!isBot && baseline) {
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

/** A label colour at the label's `fade` (limb fade on the globe); the shared constant when fully opaque. */
const fadedText = (base: Rgba) => (d: object): Rgba => {
  const fade = (d as { fade?: number }).fade;
  return fade === undefined || fade >= 1 ? base : [base[0], base[1], base[2], Math.round(base[3] * Math.max(0, fade))];
};
const TEXT_COLOR_AT = fadedText(TEXT_COLOR);
/** Movement hop labels: `--text-secondary` (white at 72%) over the dark halo; the basemap is dark in both themes. */
const MOVE_TEXT_COLOR_AT = fadedText([255, 255, 255, 184]);
const HALO_COLOR_AT = fadedText(TEXT_OUTLINE);

/**
 * The dark halo behind a map label. deck.gl's SDF `outlineWidth` is a fraction of the glyph's ~0.7px spread at 11px:
 * it never drew a visible edge, so an arc crossing "US 47" swallowed the text. Instead the label is drawn first in
 * the outline colour at four 1.25px offsets, then in its own colour on top: a real ~1.25px outline at any zoom.
 */
const HALO_PX = 1.25;
const HALO_SHIFTS: ReadonlyArray<readonly [number, number]> = [[-HALO_PX, 0], [HALO_PX, 0], [0, -HALO_PX], [0, HALO_PX]];
export interface LabelVariant { suffix: string; getColor: typeof TEXT_COLOR_AT; shift: readonly [number, number] }
const TEXT_VARIANT: LabelVariant = { suffix: '', getColor: TEXT_COLOR_AT, shift: [0, 0] };
/** Pushes the four halo layers, then the label itself (`make` builds one layer per variant). */
function pushHaloed(out: Layer[], make: (v: LabelVariant) => Layer): void {
  HALO_SHIFTS.forEach((shift, i) => out.push(make({ suffix: `-halo${i}`, getColor: HALO_COLOR_AT, shift })));
  out.push(make(TEXT_VARIANT));
}
const shifted = (base: readonly [number, number], v: LabelVariant): [number, number] => [base[0] + v.shift[0], base[1] + v.shift[1]];

function labelStyle(projection: Projection = 'flat') {
  return {
    ...(projection === 'globe' ? { parameters: GLOBE_SCREEN_SPACE_PARAMETERS } : null),
    sizeUnits: 'pixels' as const,
    getColor: TEXT_COLOR_AT,
    fontFamily: MONO,
    fontSettings: { sdf: true },
    characterSet: 'auto' as const,
    pickable: false,
  };
}

const OP_ALPHA_BASE = 130;

/** Dimmed (outside the selected footprint) node core: low, but still a visible, pickable dot. */
const OP_DIM_CORE_ALPHA = 70;

/** Animated (selected / top operations) vs static preview edges, split once per (visible set, selection). */
const splitOpEdges = memoByModelAndKey((edges: OpEdge[], key: string) => {
  const [sel, top] = key.split('#');
  const focus = new Set(sel ? [sel] : (top ?? '').split(',').filter(Boolean));
  const main: OpEdge[] = [];
  const preview: OpEdge[] = [];
  for (const e of edges) (e.opIds.some(id => focus.has(id)) ? main : preview).push(e);
  return { main, preview };
});

/** Pair arcs carrying the hovered operation (memoised per visible set + id). */
const hoverEdges = memoByModelAndKey((edges: OpEdge[], id: string) => edges.filter(e => e.opIds.includes(id)));

/** While a row is hovered the other arcs fade to this share of their alpha; the hovered ones gain this much width. */
const OP_HOVER_EDGE_FADE = 0.3;
const OP_HOVER_EDGE_BOOST = 1.6;

function opLayers(input: LensLayerInput, frame: LensFrame): Layer[] {
  const m = input.operations;
  if (!m || m.nodes.length === 0) return [];
  const { sel, reducedMotion, pick, labels } = input;
  const selOp = sel.opId;
  const range = opCountRange(m);
  const nodes = opNodesDrawOrder(m);
  const globe = input.projection === 'globe';
  const animTime = reducedMotion ? 0 : frame.seconds;
  const out: Layer[] = [];

  const visible = visibleEdges(m, selOp, sel.previewOpId ?? null);
  const widest = maxPairOps(visible);
  const edgeStyle = (e: OpEdge) => opEdgeStyle(e.opCount, widest);
  const { main, preview } = splitOpEdges(visible, `${selOp ?? ''}#${m.topOpIds.join(',')}`);
  // A hovered panel row: transient focus on that operation's footprint (same idea as selection, no data rebuild:
  // `hiEdges` is memoised per (visible set, id) and everything else only changes accessors via updateTriggers).
  const hi = sel.previewOpId && m.countriesOf.has(sel.previewOpId) ? sel.previewOpId : null;
  const hiEdges = hi ? hoverEdges(visible, hi) : [];
  const hiHub = hi ? m.countriesOf.get(hi)![0]! : null;
  const edgeFade = (e: OpEdge): number => (hi && !e.opIds.includes(hi) ? OP_HOVER_EDGE_FADE : 1);
  const pathOf = (e: OpEdge) => (globe ? globeEdgePath(e).path : e.path);
  const distOf = (e: OpEdge) => (globe ? globeEdgePath(e).distances : e.distances);
  const edgeHover = (info: PickInfo<OpEdge>) => pick.hover(info.object
    ? { x: info.x, y: info.y, title: info.object.label, lines: info.object.opIds.slice(0, 5).map(id => m.byId.get(id)?.name ?? id) }
    : null);
  const edgeClick = (info: PickInfo<OpEdge>) => (info.object ? pick.click({ kind: 'operation', id: info.object.opIds[0]! }) : false);

  // Links: ONE animated idea, on the selected / top operations only; a previewed row's links are static and thin.
  if (preview.length > 0) {
    out.push(new PrimaryPathLayer<OpEdge>({
      id: 'ops-edges-preview',
      data: preview,
      getPath: pathOf,
      getColor: () => withAlpha(CYAN, 150),
      getWidth: 1.2,
      widthUnits: 'pixels',
      pickable: false,
      updateTriggers: { getPath: globe },
    }));
  }
  if (main.length > 0) {
    // A faint solid line under the dashed flow: the gaps in the dashes would otherwise break a thin, light link.
    if (!reducedMotion) {
      out.push(new PrimaryPathLayer<OpEdge>({
        id: 'ops-edges-under',
        data: main,
        getPath: pathOf,
        getColor: (e: OpEdge) => withAlpha(CYAN, Math.round(edgeStyle(e).alpha * OP_EDGE_UNDERLAY * edgeFade(e))),
        getWidth: (e: OpEdge) => edgeStyle(e).width,
        widthUnits: 'pixels',
        capRounded: true,
        pickable: true,
        updateTriggers: { getPath: globe, getColor: [widest, hi], getWidth: widest },
        onHover: edgeHover,
        onClick: edgeClick,
      }));
    }
    out.push(new PrimaryPathLayer<OpEdge, DashFlowExtensionProps<OpEdge>>({
      id: 'ops-edges',
      data: main,
      getPath: pathOf,
      getDashDistances: distOf,
      getColor: (e: OpEdge) => withAlpha(CYAN, Math.round(edgeStyle(e).alpha * edgeFade(e))),
      getWidth: (e: OpEdge) => edgeStyle(e).width,
      widthUnits: 'pixels',
      capRounded: true,
      pickable: true,
      extensions: DASH_EXT,
      dash: reducedMotion ? SOLID_DASH : 1.1,
      gap: reducedMotion ? 0 : 1.5,
      speed: reducedMotion ? 0 : 2.4,
      animTime,
      transitions: reducedMotion ? undefined : TR_PATH,
      updateTriggers: { getPath: globe, getDashDistances: globe, getColor: [widest, hi], getWidth: widest },
      // Full evidence lives here (and in the drawer); the map label is the short form.
      onHover: edgeHover,
      onClick: edgeClick,
    }));
  }

  // The hovered operation's own pair arcs, brightened and widened over whatever is drawn (pairs already on the map
  // included, which is why a preview that only ADDED missing links was invisible on most rows).
  if (hiEdges.length > 0) {
    out.push(new PrimaryPathLayer<OpEdge>({
      id: 'ops-edges-hi',
      data: hiEdges,
      getPath: pathOf,
      getColor: () => withAlpha(CYAN, 255),
      getWidth: (e: OpEdge) => edgeStyle(e).width + OP_HOVER_EDGE_BOOST,
      widthUnits: 'pixels',
      capRounded: true,
      pickable: false,
      updateTriggers: { getPath: globe, getWidth: widest },
    }));
  }

  // Selection wins the dimming unless a row is hovered: then the hovered footprint is the bright one.
  const focusOp = hi ?? selOp;
  const dim = (n: OpNode): boolean => !nodeInFootprint(n, focusOp);
  const shared = {
    data: nodes,
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
      getRadius: (n: OpNode) => haloPx(opNodePx(n.opCount, range), input.haloScale),
      getFillColor: (n: OpNode) => withAlpha(CYAN, dim(n) ? 6 : hi ? 70 : 34),
      transitions: reducedMotion ? undefined : TR_FILL,
      updateTriggers: { ...shared.updateTriggers, getFillColor: focusOp, getRadius: input.haloScale },
    }),
    new ScatterplotLayer<OpNode, PulseExtensionProps<OpNode>>({
      ...shared,
      id: 'ops-core',
      getRadius: (n: OpNode) => opNodeRadius(n.opCount, range),
      getFillColor: (n: OpNode) => withAlpha(CYAN, dim(n) ? OP_DIM_CORE_ALPHA : Math.round(OP_ALPHA_BASE + 110 * (n.confidence ?? 0.5))),
      stroked: true,
      getLineColor: (n: OpNode) => (n.country === sel.country || n.country === hiHub ? AMBER : withAlpha(CYAN, dim(n) ? 40 : 255)),
      getLineWidth: (n: OpNode) => (n.country === hiHub ? 3 : n.country === sel.country ? 2.5 : 1.2),
      lineWidthUnits: 'pixels',
      pickable: true,
      transitions: reducedMotion ? undefined : TR_DOT,
      updateTriggers: { ...shared.updateTriggers, getFillColor: focusOp, getLineColor: [focusOp, sel.country, hiHub], getLineWidth: [sel.country, hiHub] },
      onHover: (info: PickInfo<OpNode>) => pick.hover(info.object
        ? {
          x: info.x, y: info.y, title: countryName(info.object.country),
          lines: [`${info.object.opCount} operation${info.object.opCount === 1 ? '' : 's'} · ${info.object.threats.toLocaleString()} threats`,
            ...info.object.opIds.slice(0, 4).map(id => m.byId.get(id)?.name ?? id),
            ...(info.object.opCount > 4 ? [`+${info.object.opCount - 4} more`] : [])],
        }
        : null),
      // A country node opens the country drawer, which lists the operations present there.
      onClick: (info: PickInfo<OpNode>) => (info.object ? pick.click({ kind: 'country', id: info.object.country }) : false),
    }),
  );

  // The busiest countries, named with their operation count ("DE 37"); the rest are in the tooltip.
  if (labels.opNodes && labels.opNodes.length > 0) {
    pushHaloed(out, v => new TextLayer<PlacedNodeLabel>({
      id: `ops-node-labels${v.suffix}`,
      ...labelStyle(input.projection),
      getColor: v.getColor,
      data: labels.opNodes,
      getPosition: l => l.position,
      getText: l => l.text,
      getSize: LABEL_PX,
      getTextAnchor: 'middle',
      getAlignmentBaseline: (l: PlacedNodeLabel) => (l.above ? 'bottom' : 'top'),
      getPixelOffset: (l: PlacedNodeLabel) => shifted([0, (l.radiusPx + NODE_LABEL_GAP) * (l.above ? -1 : 1)], v),
      updateTriggers: { getPixelOffset: v.suffix },
    }));
  }

  // Edge evidence: short ("◆ cert"), one per operation, laid along the edge, de-duplicated in screen space.
  if (labels.edges.length > 0) {
    pushHaloed(out, v => new PrimaryTextLayer<PlacedEdgeLabel>({
      id: `ops-edge-labels${v.suffix}`,
      ...labelStyle(input.projection),
      getColor: v.getColor,
      getPixelOffset: shifted([0, 0], v),
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
  // Takedowns measure: the same rings, with takedown outcomes (same window as the colours) in place of the 90-day field.
  const tp = input.measure === 'takedowns' ? input.takedownProviders : null;
  const m = tp ? tp.hosting : input.hosting;
  if (!m || m.rings.length === 0) return [];
  const { sel, reducedMotion, pick, labels } = input;
  const ringColor = (r: ProviderRing): Rgba => (tp ? tp.colors.get(r.id) ?? TAKEDOWN_SMALL_COLOR : TREND_COLORS[r.trend]);
  const animTime = reducedMotion ? 0 : frame.seconds;
  const { bullet, withTakedown } = hostingParts(m);
  const dimmed = (r: ProviderRing): boolean => sel.providerId !== null && r.id !== sel.providerId;
  const hs = input.haloScale;
  /** The ring is the pickable data mark and always keeps its full size; only the glow / arcs round it shrink (their offset from the ring). */
  const ringPx = (r: ProviderRing): number => r.radiusPx;
  const out: Layer[] = [];

  out.push(new ScatterplotLayer<ProviderRing>({
    id: 'hosting-rings',
    data: m.rings,
    getPosition: posNode,
    radiusUnits: 'pixels',
    getRadius: (r: ProviderRing) => r.radiusPx,
    // Takedowns measure: the fill IS the success share (sequential green), so it keeps its own alpha.
    getFillColor: (r: ProviderRing) => (tp ? withAlpha(ringColor(r), dimmed(r) ? 30 : Math.max(ringColor(r)[3], 110)) : withAlpha(TREND_COLORS[r.trend], dimmed(r) ? 14 : 82)),
    stroked: true,
    getLineColor: (r: ProviderRing) => (r.id === sel.providerId ? AMBER : withAlpha(ringColor(r), dimmed(r) ? 50 : 235)),
    getLineWidth: (r: ProviderRing) => (r.id === sel.providerId ? 3 : 1.5),
    lineWidthUnits: 'pixels',
    pickable: true,
    // Size / colour glide when the numbers move (a 15-minute refetch) and when a ring is picked, instead of snapping.
    transitions: reducedMotion ? undefined : TR_RING,
    updateTriggers: { getFillColor: [sel.providerId, tp], getLineColor: [sel.providerId, tp], getLineWidth: sel.providerId },
    onHover: (info: PickInfo<ProviderRing>) => pick.hover(info.object
      ? {
        x: info.x, y: info.y, title: info.object.name,
        lines: [
          [info.object.asn, countryName(info.object.country)].filter(Boolean).join(' · '),
          `${info.object.active.toLocaleString()} active · ${info.object.trend7} this week (${info.object.trend})`,
          ...(info.object.bulletproof ? ['bulletproof host'] : []),
          ...(tp
            ? (() => { const row = tp.rows.get(info.object.id); return row ? takedownFacts(row) : ['no takedowns submitted in this window']; })()
            : info.object.takedownShare !== null ? [`${Math.round(info.object.takedownShare * 100)}% of resolved takedowns succeeded`] : []),
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
      getRadius: (r: ProviderRing) => ringPx(r) + bulletproofHaloPx(hs),
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
      updateTriggers: { getMaskSpin: reducedMotion, getRadius: hs },
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
        getRadius: (r: ProviderRing) => ringPx(r) + takedownTrackPx(hs),
        filled: false, stroked: true,
        getLineColor: TRACK_COLOR, getLineWidth: 2.5, lineWidthUnits: 'pixels',
        pickable: false,
        updateTriggers: { getRadius: hs },
      }),
      new ScatterplotLayer<ProviderRing, RingMaskExtensionProps<ProviderRing>>({
        id: 'hosting-takedown-arc',
        data: withTakedown,
        getPosition: posNode,
        radiusUnits: 'pixels',
        getRadius: (r: ProviderRing) => ringPx(r) + takedownTrackPx(hs),
        filled: false, stroked: true,
        getLineColor: TAKEDOWN_COLOR, getLineWidth: 2.5, lineWidthUnits: 'pixels',
        pickable: false,
        extensions: MASK_EXT,
        getMaskFraction: (r: ProviderRing) => r.takedownShare ?? 0,
        updateTriggers: { getRadius: hs },
        animTime,
      }),
    );
  }

  // Name the biggest providers (and the selected one) that fit without colliding, so the map reads without hovering.
  if (labels.hosts.length > 0) {
    pushHaloed(out, v => new TextLayer<PlacedHostLabel>({
      id: `hosting-labels${v.suffix}`,
      ...labelStyle(input.projection),
      getColor: v.getColor,
      data: labels.hosts,
      getPosition: r => r.position,
      getText: r => r.text,
      getSize: LABEL_PX,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      getPixelOffset: r => shifted([0, r.radiusPx + 10], v),
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
      getRadius: (c: ActorCountry) => haloPx(radius(c) * 2, input.haloScale),
      getFillColor: (c: ActorCountry) => withAlpha(FUCHSIA, Math.round(bandAlpha(c) * 0.16)),
      updateTriggers: { ...shared.updateTriggers, getRadius: input.haloScale },
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
    pushHaloed(out, v => new TextLayer<PlacedActorLabel>({
      id: `actor-labels${v.suffix}`,
      ...labelStyle(input.projection),
      getColor: v.getColor,
      data: labels.actors,
      getPosition: a => a.position,
      getText: a => a.text,
      getSize: LABEL_PX,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      getPixelOffset: a => shifted([0, a.radiusPx + 10], v),
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
  const hopLabels = input.labels.moves ?? [];

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
        ...labelStyle(input.projection),
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

  // What moved, written on the map at each trail's hop midpoint ("+3 IPs · AS4837"): placed in screen space when the
  // camera settles, so they fit, do not collide and are left out at the world view (see `moveLabelMinZoom`).
  if (hopLabels.length > 0) {
    pushHaloed(out, v => new TextLayer<PlacedEdgeLabel>({
      id: `movement-hop-labels${v.suffix}`,
      ...labelStyle(input.projection),
      getColor: v.suffix === '' ? MOVE_TEXT_COLOR_AT : v.getColor,
      data: hopLabels,
      getPosition: l => l.position,
      getText: l => l.text,
      getAngle: l => -l.angle,
      getSize: LABEL_PX,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      getPixelOffset: shifted([0, MOVE_LABEL_LIFT], v),
    }));
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
/** The very-fast nodes, as one array (memoised: layer data identity is stable across frames). */
const velocityHot = memoByModel((m: VelocityModel) => m.points.filter(p => p.hot));

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
      getRadius: (p: VelocityPoint) => haloPx(p.radiusPx * 2.1, input.haloScale),
      getFillColor: (p: VelocityPoint) => withAlpha(VELOCITY_COLOR, p.hot ? 40 : 22),
      updateTriggers: { ...shared.updateTriggers, getRadius: input.haloScale },
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
    // A STATIC ring on the very-fast nodes (outside the breathing core's peak), so the two classes differ without
    // motion: reduced motion, a paused frame and a screenshot all keep the distinction the pulse alone would carry.
    ...(velocityHot(m).length > 0 ? [new ScatterplotLayer<VelocityPoint>({
      id: 'velocity-hot-ring',
      data: velocityHot(m),
      getPosition: (p: VelocityPoint): [number, number] => p.position,
      radiusUnits: 'pixels',
      getRadius: (p: VelocityPoint) => p.radiusPx * (1 + VELOCITY_HOT_AMP) + 3,
      stroked: true,
      filled: false,
      getLineColor: withAlpha(VELOCITY_COLOR, 230),
      getLineWidth: 1.5,
      lineWidthUnits: 'pixels',
      pickable: false,
    })] : []),
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

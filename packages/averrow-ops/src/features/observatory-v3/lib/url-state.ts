/**
 * Observatory view state <-> URL search params.
 *
 * Pure parse/serialise/merge functions (unit-tested) plus a thin
 * `useObservatoryUrlState` hook over React Router's `useSearchParams` (the app
 * mounts at basename /v2, so the shareable URL is /v2/observatory?...).
 *
 * Canonical form: only non-default values are written, unknown / invalid values
 * fall back to the default, and selection (`node`/`arc`/`sel`) only survives on
 * the interactive scenes (not the density heatmap or the bot-share choropleth).
 * A lens is the one question the map answers; `view` (Threats: Points | Heat) and
 * `measure` (Baseline: Over-index | Raw | Bot share) are that lens's option. Old
 * `mode=heatmap` / `mode=bot_density` links still parse and are rewritten. `proj=globe` picks the globe projection
 * (flat is the default and is never written); it is a standing view setting, independent of the lens and the selection.
 * `wall=1` is the wall-screen mode: it defaults the projection to the globe (so `proj` is written only when it differs from
 * THAT default, i.e. `wall=1&proj=flat`), and the page hides the panel and the chrome that is not needed.
 * `sev` (critical,high,medium,low), `type` (threat types) and `brand` are the data filters: empty = no filter, never written.
 * Params that aren't ours are left untouched.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LAYER_IDS, LENS_IDS, lensPreset, isLensId, noLayers, sameLayers,
  type LayerToggles, type LensId,
} from './lenses';
import { DEFAULT_PROJECTION, PROJECTION_IDS, type Projection } from './projection';

export const PERIOD_IDS = ['24h', '7d', '30d', '90d'] as const;
export type Period = (typeof PERIOD_IDS)[number];

export const SOURCE_IDS = ['all', 'feeds', 'spam_trap'] as const;
export type Source = (typeof SOURCE_IDS)[number];

/**
 * The scene the map draws. It is DERIVED from lens + options (see `mapModeOf`), not stored in the
 * URL: `heatmap` is the Threats lens with the Heat view, `bot_density` is the Baseline lens with
 * the Bot share measure. `mode=` is still read from old links (see `LEGACY_MODE_PATCH`).
 */
export const MAP_MODE_IDS = ['global', 'heatmap', 'bot_density'] as const;
export type MapMode = (typeof MAP_MODE_IDS)[number];

export const THREAT_VIEW_IDS = ['points', 'heat', 'fast'] as const;
/**
 * Threats lens option: individual origin nodes, the density heatmap, or the fast-weaponization view
 * (countries whose domains went live within days of registration; has no source split, so `source` is
 * ignored while it is on).
 */
export type ThreatView = (typeof THREAT_VIEW_IDS)[number];

export const SEVERITY_IDS = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITY_IDS)[number];

/** The `threats.threat_type` CHECK values: the only ones the API accepts for `threat_type` (anything else is a 400). */
export const THREAT_TYPE_IDS = [
  'botnet', 'c2', 'credential_harvesting', 'impersonation', 'malicious_ip', 'malicious_ssl',
  'malware_distribution', 'phishing', 'scanning', 'typosquatting',
] as const;
const TYPE_SET: ReadonlySet<string> = new Set(THREAT_TYPE_IDS);
/** A brand id, as the API takes it (`brand=<id>`). */
const BRAND_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Canonical severity list from a comma string: known ids only, in severity order, deduplicated. All four = no filter. */
export function parseSeverities(raw: string | null | undefined): Severity[] {
  if (!raw) return [];
  const on = new Set(raw.split(',').map(x => x.trim().toLowerCase()));
  const out = SEVERITY_IDS.filter(id => on.has(id));
  return out.length === SEVERITY_IDS.length ? [] : out;
}

/** Threat types from a comma string: only the known ones, lower-case, deduplicated, sorted (a stable URL and query key). */
export function parseTypes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const x of raw.split(',')) {
    const t = x.trim().toLowerCase();
    if (TYPE_SET.has(t)) seen.add(t);
  }
  return [...seen].sort();
}

/** A brand filter: one brand ID (not a name), or null when it is not a well-formed id. */
export function parseBrand(raw: string | null | undefined): string | null {
  const b = (raw ?? '').trim();
  return BRAND_ID_RE.test(b) ? b : null;
}

export const COLOR_BY_IDS = ['severity', 'type'] as const;
export type ColorBy = (typeof COLOR_BY_IDS)[number];

export { LAYER_IDS, LENS_IDS, type LayerId, type LayerToggles, type LensId } from './lenses';

export const MEASURE_IDS = ['index', 'raw', 'bot', 'takedowns'] as const;
/**
 * A lens's measure. Baseline: over-index vs Radar (`index`, the default), raw volume, Radar bot share, or
 * takedown success by country. Hosting: its providers by active threats (`index`, the default) or takedown
 * outcomes by provider. `takedowns` needs the `manage_takedowns` permission: the URL cannot know it, so the
 * page falls back to the default for a viewer without it (see ObservatoryV3).
 */
export type Measure = (typeof MEASURE_IDS)[number];

/** Which measures each lens has (the first is its default). Other lenses have none. */
export function measuresFor(lens: LensId): readonly Measure[] {
  if (lens === 'baseline') return MEASURE_IDS;
  if (lens === 'hosting') return ['index', 'takedowns'];
  return ['index'];
}

export const SEL_KINDS = ['country', 'op', 'provider', 'actor', 'campaign', 'move'] as const;
export type SelKind = (typeof SEL_KINDS)[number];
const SEL_RE = /^(country|op|provider|actor|campaign|move):(.{1,160})$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

/** Split a `sel` value into kind + id; null when it isn't a valid selection. */
export function parseSel(raw: string | null | undefined): { kind: SelKind; id: string } | null {
  if (!raw) return null;
  const m = SEL_RE.exec(raw);
  if (!m) return null;
  const kind = m[1] as SelKind;
  const id = m[2];
  if (kind === 'country' && !COUNTRY_RE.test(id)) return null;
  return { kind, id };
}

export function selValue(kind: SelKind, id: string): string {
  return `${kind}:${id}`;
}

export interface ObservatoryUrlState {
  /** Which question the map answers (global mode only). */
  lens: LensId;
  /** Threats lens option (`heat` = density heatmap, `fast` = fast weaponization). Always `points` on other lenses. */
  view: ThreatView;
  period: Period;
  source: Source;
  colorBy: ColorBy;
  layers: LayerToggles;
  /** Selected node key (`lat,lng`, see `nodeKey`) — global mode only. */
  node: string | null;
  /** Selected arc key (see `arcKey`) — global mode only. */
  arc: string | null;
  /**
   * Any other selection, `kind:id` (country, operation, provider, actor, campaign,
   * movement) — global mode only. Mutually exclusive with `node` / `arc`.
   */
  sel: string | null;
  /** Baseline / Hosting lens option (see `measuresFor`). Always `index` on other lenses. */
  measure: Measure;
  /** Map projection: the flat map (default) or the globe (`proj=globe`). Independent of the lens. */
  proj: Projection;
  /** Operations lens: include the clusters the backend flags as shared infrastructure (`shared=1`; off by default). */
  shared: boolean;
  /** Wall-screen mode (`wall=1`): globe by default, no panel, no toolbar / rail / legend / replay bar; the idle spin keeps running. */
  wall: boolean;
  /** Severity filter (`sev=critical,high`). Empty = all. Applied to the threat nodes on the client (per-severity counts). */
  sev: Severity[];
  /** Threat-type filter (`type=phishing,malware`). Empty = all. Sent to the nodes / arcs / stats endpoints. */
  type: string[];
  /** Brand filter (`brand=<brand id>`). Sent to /arcs, /stats and /timeline; /nodes has no brand dimension (it would 400), so the node layer ignores it. */
  brand: string | null;
}

/** The scene the map draws for a state. */
export function mapModeOf(s: Pick<ObservatoryUrlState, 'lens' | 'view' | 'measure'>): MapMode {
  if (s.lens === 'threats' && s.view === 'heat') return 'heatmap';
  if (s.lens === 'baseline' && s.measure === 'bot') return 'bot_density';
  return 'global';
}

/** What an old `mode=` link / patch means in lens + option terms. */
export const LEGACY_MODE_PATCH: Record<MapMode, { lens: LensId; view: ThreatView; measure: Measure }> = {
  global: { lens: 'threats', view: 'points', measure: 'index' },
  heatmap: { lens: 'threats', view: 'heat', measure: 'index' },
  bot_density: { lens: 'baseline', view: 'points', measure: 'bot' },
};

export const DEFAULT_LAYERS: LayerToggles = lensPreset('threats');

export const DEFAULT_STATE: ObservatoryUrlState = {
  lens: 'threats',
  view: 'points',
  period: '7d',
  source: 'all',
  colorBy: 'severity',
  layers: DEFAULT_LAYERS,
  node: null,
  arc: null,
  sel: null,
  measure: 'index',
  proj: DEFAULT_PROJECTION,
  shared: false,
  wall: false,
  sev: [],
  type: [],
  brand: null,
};

/** The projection a link without `proj` opens on: the globe on a wall screen, the flat map otherwise. */
export const defaultProjectionFor = (wall: boolean): Projection => (wall ? 'globe' : DEFAULT_PROJECTION);

/** Every query-string key this module owns. */
export const OWNED_KEYS = ['lens', 'view', 'period', 'source', 'mode', 'colorBy', 'layers', 'node', 'arc', 'sel', 'measure', 'proj', 'shared', 'wall', 'sev', 'type', 'brand'] as const;

const NODE_KEY_RE = /^-?\d{1,3}(\.\d{1,6})?,-?\d{1,3}(\.\d{1,6})?$/;
const ARC_KEY_MAX = 200;

function pick<T extends string>(allowed: readonly T[], raw: string | null, fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function parseLayers(raw: string | null, lens: LensId): LayerToggles {
  const preset = lensPreset(lens);
  if (raw === null) return preset;
  if (raw === 'none') return noLayers();
  const on = new Set(raw.split(',').map(x => x.trim()));
  // A value with no recognised ids is garbage — treat as the lens default, not "all off".
  if (!LAYER_IDS.some(id => on.has(id))) return preset;
  const out = noLayers();
  for (const id of LAYER_IDS) out[id] = on.has(id);
  return out;
}

function serializeLayers(l: LayerToggles, lens: LensId): string | null {
  if (sameLayers(l, lensPreset(lens))) return null;
  const on = LAYER_IDS.filter(id => l[id]);
  return on.length === 0 ? 'none' : on.join(',');
}

/** Stable key for a map node (clusters are identified by their grid position). */
export function nodeKey(n: { lat: number; lng: number }): string {
  return `${n.lat.toFixed(2)},${n.lng.toFixed(2)}`;
}

/** Stable key for an arc corridor. */
export function arcKey(a: {
  threat_type?: string | null;
  severity?: string | null;
  brand_name?: string | null;
  target_brand?: string | null;
  sourcePosition: [number, number];
}): string {
  const target = a.brand_name ?? a.target_brand ?? '';
  return `${a.threat_type ?? ''}|${target}|${a.sourcePosition[0].toFixed(1)},${a.sourcePosition[1].toFixed(1)}|${a.severity ?? ''}`;
}

export function parseObservatoryParams(sp: URLSearchParams): ObservatoryUrlState {
  // Old links carried `mode=`: it names a lens + option now.
  const rawMode = sp.get('mode');
  const legacy = (MAP_MODE_IDS as readonly string[]).includes(rawMode ?? '') && rawMode !== 'global'
    ? LEGACY_MODE_PATCH[rawMode as MapMode]
    : null;
  const rawLens = sp.get('lens');
  const lens: LensId = legacy ? legacy.lens : isLensId(rawLens) ? rawLens : 'threats';
  const view: ThreatView = lens === 'threats'
    ? (legacy?.view === 'heat' ? 'heat' : pick(THREAT_VIEW_IDS, sp.get('view'), DEFAULT_STATE.view))
    : DEFAULT_STATE.view;
  const measure: Measure = pick(measuresFor(lens), legacy ? legacy.measure : sp.get('measure'), DEFAULT_STATE.measure);
  // Selection lives on the interactive scenes: not on the density heatmap, nor the bot-share choropleth.
  const selectable = mapModeOf({ lens, view, measure }) === 'global';
  const rawNode = sp.get('node');
  const rawArc = sp.get('arc');
  const nodeOk = selectable && !!rawNode && NODE_KEY_RE.test(rawNode);
  const arcOk = selectable && !nodeOk && !!rawArc && rawArc.length <= ARC_KEY_MAX;
  const parsedSel = selectable && !nodeOk && !arcOk ? parseSel(sp.get('sel')) : null;
  const wall = sp.get('wall') === '1';
  return {
    lens,
    view,
    period: pick(PERIOD_IDS, sp.get('period'), DEFAULT_STATE.period),
    source: pick(SOURCE_IDS, sp.get('source'), DEFAULT_STATE.source),
    colorBy: pick(COLOR_BY_IDS, sp.get('colorBy'), DEFAULT_STATE.colorBy),
    // A legacy `mode=` link predates the layer toggles: its `layers` (if any) described another scene, so the lens preset applies.
    layers: legacy ? lensPreset(lens) : parseLayers(sp.get('layers'), lens),
    // node, arc and sel are mutually exclusive; node wins, then arc, then sel.
    node: nodeOk ? rawNode : null,
    arc: arcOk ? rawArc : null,
    sel: parsedSel ? selValue(parsedSel.kind, parsedSel.id) : null,
    measure,
    // Absent / unknown = flat, so every pre-globe link keeps opening on the flat map.
    proj: pick(PROJECTION_IDS, sp.get('proj'), defaultProjectionFor(wall)),
    shared: sp.get('shared') === '1',
    wall,
    sev: parseSeverities(sp.get('sev')),
    type: parseTypes(sp.get('type')),
    brand: parseBrand(sp.get('brand')),
  };
}

/** Write `state` into a copy of `base`, replacing only the keys this module owns. */
export function applyObservatoryState(base: URLSearchParams, state: ObservatoryUrlState): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of OWNED_KEYS) out.delete(k);
  if (state.period !== DEFAULT_STATE.period) out.set('period', state.period);
  if (state.source !== DEFAULT_STATE.source) out.set('source', state.source);
  if (state.colorBy !== DEFAULT_STATE.colorBy) out.set('colorBy', state.colorBy);
  if (state.lens !== DEFAULT_STATE.lens) out.set('lens', state.lens);
  if (state.lens === 'threats' && state.view !== DEFAULT_STATE.view) out.set('view', state.view);
  const layers = serializeLayers(state.layers, state.lens);
  if (layers) out.set('layers', layers);
  if (measuresFor(state.lens).includes(state.measure) && state.measure !== DEFAULT_STATE.measure) out.set('measure', state.measure);
  if (state.proj !== defaultProjectionFor(state.wall)) out.set('proj', state.proj);
  if (state.shared) out.set('shared', '1');
  if (state.wall) out.set('wall', '1');
  if (state.sev.length > 0 && state.sev.length < SEVERITY_IDS.length) out.set('sev', SEVERITY_IDS.filter(id => state.sev.includes(id)).join(','));
  if (state.type.length > 0) out.set('type', state.type.join(','));
  if (state.brand) out.set('brand', state.brand);
  if (mapModeOf(state) === 'global') {
    if (state.node) out.set('node', state.node);
    else if (state.arc) out.set('arc', state.arc);
    else if (state.sel) out.set('sel', state.sel);
  }
  return out;
}

export type ObservatoryPatch = Partial<Omit<ObservatoryUrlState, 'layers'>> & {
  layers?: Partial<LayerToggles>;
  /** Legacy shorthand for a lens + option pair (the old Mode tabs); prefer `lens` / `view` / `measure`. */
  mode?: MapMode;
};

/**
 * Merge a patch into a state. Changing period / source / lens / view clears the
 * selection (the selected object belongs to the old view) unless the patch sets
 * one explicitly, and choosing a lens resets the layers to that lens's preset
 * and its option to the default unless the patch sets them. A lens option only
 * exists on its lens (view on Threats, measure on Baseline). Selecting one kind
 * of object clears the others.
 */
export function mergeObservatoryState(prev: ObservatoryUrlState, rawPatch: ObservatoryPatch): ObservatoryUrlState {
  const { mode, ...rest } = rawPatch;
  // `mode: 'global'` means "leave the heat / bot-share scene" and keeps the lens; the others name a lens + option.
  const patch: Omit<ObservatoryPatch, 'mode'> =
    mode === 'global' ? { view: 'points', ...(prev.measure === 'bot' ? { measure: DEFAULT_STATE.measure } : {}), ...rest }
      : mode ? { ...LEGACY_MODE_PATCH[mode], ...rest }
        : rest;
  const lensChanged = patch.lens !== undefined && patch.lens !== prev.lens;
  const viewChanged =
    lensChanged ||
    (patch.view !== undefined && patch.view !== prev.view) ||
    (patch.period !== undefined && patch.period !== prev.period) ||
    (patch.source !== undefined && patch.source !== prev.source) ||
    (patch.sev !== undefined && patch.sev.join() !== prev.sev.join()) ||
    (patch.type !== undefined && patch.type.join() !== prev.type.join()) ||
    (patch.brand !== undefined && patch.brand !== prev.brand);
  const next: ObservatoryUrlState = {
    ...prev,
    ...patch,
    layers: { ...prev.layers, ...patch.layers },
  };
  if (lensChanged) {
    if (patch.view === undefined) next.view = DEFAULT_STATE.view;
    if (patch.measure === undefined) next.measure = DEFAULT_STATE.measure;
    if (patch.layers === undefined) next.layers = lensPreset(next.lens);
  }
  if (next.lens !== 'threats') next.view = DEFAULT_STATE.view;
  // Filters are normalised the way the URL parser would read them back, so state and URL never disagree.
  next.sev = parseSeverities(next.sev.join(','));
  next.type = parseTypes(next.type.join(','));
  next.brand = parseBrand(next.brand);
  if (!measuresFor(next.lens).includes(next.measure)) next.measure = DEFAULT_STATE.measure;
  const setsSelection = patch.node !== undefined || patch.arc !== undefined || patch.sel !== undefined;
  if (viewChanged && !setsSelection) {
    next.node = null;
    next.arc = null;
    next.sel = null;
  }
  if (patch.node) { next.arc = null; next.sel = null; }
  else if (patch.arc) { next.node = null; next.sel = null; }
  else if (patch.sel) { next.node = null; next.arc = null; }
  // Scenes without selection drop it (heat, bot share).
  if (mapModeOf(next) !== 'global') { next.node = null; next.arc = null; next.sel = null; }
  return next;
}

export function useObservatoryUrlState() {
  const [sp, setSp] = useSearchParams();
  const state = useMemo(() => parseObservatoryParams(sp), [sp]);

  const update = useCallback(
    (patch: ObservatoryPatch) => {
      setSp(
        prev => applyObservatoryState(prev, mergeObservatoryState(parseObservatoryParams(prev), patch)),
        { replace: true },
      );
    },
    [setSp],
  );

  // Canonicalise hand-edited / stale URLs once they land.
  useEffect(() => {
    const canonical = applyObservatoryState(sp, state);
    if (canonical.toString() !== sp.toString()) setSp(canonical, { replace: true });
  }, [sp, state, setSp]);

  return { state, update };
}

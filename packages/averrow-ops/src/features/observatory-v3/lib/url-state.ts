/**
 * Observatory view state <-> URL search params.
 *
 * Pure parse/serialise/merge functions (unit-tested) plus a thin
 * `useObservatoryUrlState` hook over React Router's `useSearchParams` (the app
 * mounts at basename /v2, so the shareable URL is /v2/observatory?...).
 *
 * Canonical form: only non-default values are written, unknown / invalid values
 * fall back to the default, and selection (`node`/`arc`) only survives in the
 * global map mode. Params that aren't ours are left untouched.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  LAYER_IDS, LENS_IDS, lensPreset, isLensId, noLayers, sameLayers,
  type LayerToggles, type LensId,
} from './lenses';

export const PERIOD_IDS = ['24h', '7d', '30d', '90d'] as const;
export type Period = (typeof PERIOD_IDS)[number];

export const SOURCE_IDS = ['all', 'feeds', 'spam_trap'] as const;
export type Source = (typeof SOURCE_IDS)[number];

export const MAP_MODE_IDS = ['global', 'heatmap', 'bot_density'] as const;
export type MapMode = (typeof MAP_MODE_IDS)[number];

export const COLOR_BY_IDS = ['severity', 'type'] as const;
export type ColorBy = (typeof COLOR_BY_IDS)[number];

export { LAYER_IDS, LENS_IDS, type LayerId, type LayerToggles, type LensId } from './lenses';

export const MEASURE_IDS = ['index', 'raw'] as const;
/** Baseline lens: colour countries by over-index vs Radar, or by raw volume. */
export type Measure = (typeof MEASURE_IDS)[number];

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
  period: Period;
  source: Source;
  mode: MapMode;
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
  /** Baseline lens colouring. */
  measure: Measure;
}

export const DEFAULT_LAYERS: LayerToggles = lensPreset('threats');

export const DEFAULT_STATE: ObservatoryUrlState = {
  lens: 'threats',
  period: '7d',
  source: 'all',
  mode: 'global',
  colorBy: 'severity',
  layers: DEFAULT_LAYERS,
  node: null,
  arc: null,
  sel: null,
  measure: 'index',
};

/** Every query-string key this module owns. */
export const OWNED_KEYS = ['lens', 'period', 'source', 'mode', 'colorBy', 'layers', 'node', 'arc', 'sel', 'measure'] as const;

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
  const mode = pick(MAP_MODE_IDS, sp.get('mode'), DEFAULT_STATE.mode);
  const isGlobal = mode === 'global';
  const rawLens = sp.get('lens');
  // Lenses only exist on the global map; other modes ignore the param.
  const lens: LensId = isGlobal && isLensId(rawLens) ? rawLens : 'threats';
  const rawNode = sp.get('node');
  const rawArc = sp.get('arc');
  const nodeOk = isGlobal && !!rawNode && NODE_KEY_RE.test(rawNode);
  const arcOk = isGlobal && !nodeOk && !!rawArc && rawArc.length <= ARC_KEY_MAX;
  const parsedSel = isGlobal && !nodeOk && !arcOk ? parseSel(sp.get('sel')) : null;
  return {
    lens,
    period: pick(PERIOD_IDS, sp.get('period'), DEFAULT_STATE.period),
    source: pick(SOURCE_IDS, sp.get('source'), DEFAULT_STATE.source),
    mode,
    colorBy: pick(COLOR_BY_IDS, sp.get('colorBy'), DEFAULT_STATE.colorBy),
    layers: parseLayers(sp.get('layers'), lens),
    // node, arc and sel are mutually exclusive; node wins, then arc, then sel.
    node: nodeOk ? rawNode : null,
    arc: arcOk ? rawArc : null,
    sel: parsedSel ? selValue(parsedSel.kind, parsedSel.id) : null,
    measure: pick(MEASURE_IDS, sp.get('measure'), DEFAULT_STATE.measure),
  };
}

/** Write `state` into a copy of `base`, replacing only the keys this module owns. */
export function applyObservatoryState(base: URLSearchParams, state: ObservatoryUrlState): URLSearchParams {
  const out = new URLSearchParams(base);
  for (const k of OWNED_KEYS) out.delete(k);
  if (state.period !== DEFAULT_STATE.period) out.set('period', state.period);
  if (state.source !== DEFAULT_STATE.source) out.set('source', state.source);
  if (state.mode !== DEFAULT_STATE.mode) out.set('mode', state.mode);
  if (state.colorBy !== DEFAULT_STATE.colorBy) out.set('colorBy', state.colorBy);
  const lens = state.mode === 'global' ? state.lens : 'threats';
  if (lens !== DEFAULT_STATE.lens) out.set('lens', lens);
  const layers = serializeLayers(state.layers, lens);
  if (layers) out.set('layers', layers);
  if (state.measure !== DEFAULT_STATE.measure) out.set('measure', state.measure);
  if (state.mode === 'global') {
    if (state.node) out.set('node', state.node);
    else if (state.arc) out.set('arc', state.arc);
    else if (state.sel) out.set('sel', state.sel);
  }
  return out;
}

export type ObservatoryPatch = Partial<Omit<ObservatoryUrlState, 'layers'>> & { layers?: Partial<LayerToggles> };

/**
 * Merge a patch into a state. Changing period / source / mode / lens clears the
 * selection (the selected object belongs to the old view) unless the patch sets
 * one explicitly, and choosing a lens resets the layers to that lens's preset
 * unless the patch sets them. Selecting one kind of object clears the others.
 */
export function mergeObservatoryState(prev: ObservatoryUrlState, patch: ObservatoryPatch): ObservatoryUrlState {
  const lensChanged = patch.lens !== undefined && patch.lens !== prev.lens;
  const viewChanged =
    lensChanged ||
    (patch.period !== undefined && patch.period !== prev.period) ||
    (patch.source !== undefined && patch.source !== prev.source) ||
    (patch.mode !== undefined && patch.mode !== prev.mode);
  const next: ObservatoryUrlState = {
    ...prev,
    ...patch,
    layers: { ...prev.layers, ...patch.layers },
  };
  // Leaving the global map drops the lens (it only exists there); returning starts at Threats.
  if (patch.mode !== undefined && patch.mode !== 'global' && patch.lens === undefined) next.lens = 'threats';
  // A lens pick implies the global map.
  if (lensChanged && patch.mode === undefined && prev.mode !== 'global') next.mode = 'global';
  if (lensChanged && patch.layers === undefined) next.layers = lensPreset(next.lens);
  const setsSelection = patch.node !== undefined || patch.arc !== undefined || patch.sel !== undefined;
  if (viewChanged && !setsSelection) {
    next.node = null;
    next.arc = null;
    next.sel = null;
  }
  if (patch.node) { next.arc = null; next.sel = null; }
  else if (patch.arc) { next.node = null; next.sel = null; }
  else if (patch.sel) { next.node = null; next.arc = null; }
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

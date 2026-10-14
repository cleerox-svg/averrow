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

export const PERIOD_IDS = ['24h', '7d', '30d', '90d'] as const;
export type Period = (typeof PERIOD_IDS)[number];

export const SOURCE_IDS = ['all', 'feeds', 'spam_trap'] as const;
export type Source = (typeof SOURCE_IDS)[number];

export const MAP_MODE_IDS = ['global', 'heatmap', 'bot_density'] as const;
export type MapMode = (typeof MAP_MODE_IDS)[number];

export const COLOR_BY_IDS = ['severity', 'type'] as const;
export type ColorBy = (typeof COLOR_BY_IDS)[number];

export const LAYER_IDS = ['nodes', 'particles', 'beams'] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type LayerToggles = Record<LayerId, boolean>;

export interface ObservatoryUrlState {
  period: Period;
  source: Source;
  mode: MapMode;
  colorBy: ColorBy;
  layers: LayerToggles;
  /** Selected node key (`lat,lng`, see `nodeKey`) — global mode only. */
  node: string | null;
  /** Selected arc key (see `arcKey`) — global mode only. */
  arc: string | null;
}

export const DEFAULT_LAYERS: LayerToggles = { nodes: true, particles: true, beams: false };

export const DEFAULT_STATE: ObservatoryUrlState = {
  period: '7d',
  source: 'all',
  mode: 'global',
  colorBy: 'severity',
  layers: DEFAULT_LAYERS,
  node: null,
  arc: null,
};

/** Every query-string key this module owns. */
export const OWNED_KEYS = ['period', 'source', 'mode', 'colorBy', 'layers', 'node', 'arc'] as const;

const NODE_KEY_RE = /^-?\d{1,3}(\.\d{1,6})?,-?\d{1,3}(\.\d{1,6})?$/;
const ARC_KEY_MAX = 200;

function pick<T extends string>(allowed: readonly T[], raw: string | null, fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function parseLayers(raw: string | null): LayerToggles {
  if (raw === null) return { ...DEFAULT_LAYERS };
  if (raw === 'none') return { nodes: false, particles: false, beams: false };
  const on = new Set(raw.split(',').map(s => s.trim()));
  const known = LAYER_IDS.filter(id => on.has(id));
  // A value with no recognised ids is garbage — treat as default, not "all off".
  if (known.length === 0) return { ...DEFAULT_LAYERS };
  return { nodes: on.has('nodes'), particles: on.has('particles'), beams: on.has('beams') };
}

function serializeLayers(l: LayerToggles): string | null {
  if (LAYER_IDS.every(id => l[id] === DEFAULT_LAYERS[id])) return null;
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
  const rawNode = sp.get('node');
  const rawArc = sp.get('arc');
  const isGlobal = mode === 'global';
  return {
    period: pick(PERIOD_IDS, sp.get('period'), DEFAULT_STATE.period),
    source: pick(SOURCE_IDS, sp.get('source'), DEFAULT_STATE.source),
    mode,
    colorBy: pick(COLOR_BY_IDS, sp.get('colorBy'), DEFAULT_STATE.colorBy),
    layers: parseLayers(sp.get('layers')),
    // node and arc are mutually exclusive; node wins if both are present.
    node: isGlobal && rawNode && NODE_KEY_RE.test(rawNode) ? rawNode : null,
    arc:
      isGlobal && !(rawNode && NODE_KEY_RE.test(rawNode)) && rawArc && rawArc.length <= ARC_KEY_MAX
        ? rawArc
        : null,
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
  const layers = serializeLayers(state.layers);
  if (layers) out.set('layers', layers);
  if (state.mode === 'global') {
    if (state.node) out.set('node', state.node);
    else if (state.arc) out.set('arc', state.arc);
  }
  return out;
}

export type ObservatoryPatch = Partial<Omit<ObservatoryUrlState, 'layers'>> & { layers?: Partial<LayerToggles> };

/**
 * Merge a patch into a state. Changing period / source / mode clears the
 * selection (the selected object belongs to the old view) unless the patch
 * sets one explicitly. Selecting a node clears the arc and vice-versa.
 */
export function mergeObservatoryState(prev: ObservatoryUrlState, patch: ObservatoryPatch): ObservatoryUrlState {
  const viewChanged =
    (patch.period !== undefined && patch.period !== prev.period) ||
    (patch.source !== undefined && patch.source !== prev.source) ||
    (patch.mode !== undefined && patch.mode !== prev.mode);
  const next: ObservatoryUrlState = {
    ...prev,
    ...patch,
    layers: { ...prev.layers, ...patch.layers },
  };
  const setsSelection = patch.node !== undefined || patch.arc !== undefined;
  if (viewChanged && !setsSelection) {
    next.node = null;
    next.arc = null;
  }
  if (patch.node) next.arc = null;
  else if (patch.arc) next.node = null;
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

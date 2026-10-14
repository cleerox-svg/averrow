/**
 * Which data each Observatory map mode / lens layer actually needs, and which
 * load errors are relevant to the user for the current view. Keeps off-view
 * queries disabled (no wasted requests, no phantom error banner).
 */

import type { MapMode, SelKind } from './url-state';
import type { LayerToggles } from './lenses';

export interface DataNeeds {
  /** Geo nodes (global map layer, selection, side panel). */
  nodes: boolean;
  /** Arcs (beams, particles and target rings). */
  arcs: boolean;
  heatmap: boolean;
  /** Summary stats (stats bar, side panel). */
  stats: boolean;
  /** Radar bot-density snapshot. */
  bot: boolean;
  // ── Phase B lens layers ──
  operations: boolean;
  movements: boolean;
  providers: boolean;
  overindex: boolean;
  campaigns: boolean;
  actors: boolean;
  /** Country shapes: only while a choropleth (Baseline lens, any measure) is on screen. */
  geometry: boolean;
  /** Replay histogram (the timeline bar is shown while particles or movement play). */
  timeline: boolean;
  /** Live sonar pings. */
  live: boolean;
}

export interface NeedsOptions {
  /**
   * What is currently selected. Its data must stay loaded even when the layer
   * that draws it is off (a shared link, a search pick, a drawer hop), and a
   * country drawer additionally reads threats, brands, operations, hosts and the
   * Radar baseline.
   */
  selection?: 'node' | 'arc' | SelKind | null;
  /** The search box has been focused: load the lens lists it searches. */
  searching?: boolean;
}

const NONE: DataNeeds = {
  nodes: false, arcs: false, heatmap: false, stats: false, bot: false,
  operations: false, movements: false, providers: false, overindex: false, campaigns: false,
  actors: false, geometry: false, timeline: false, live: false,
};

export function dataNeeds(mode: MapMode, layers: LayerToggles, opts: NeedsOptions = {}): DataNeeds {
  switch (mode) {
    case 'global': {
      const sel = opts.selection ?? null;
      const country = sel === 'country';
      const searching = !!opts.searching;
      return {
        ...NONE,
        nodes: layers.nodes || sel === 'node' || country,
        // Particles + beams are arc-driven; target rings draw with nodes or beams.
        arcs: layers.particles || layers.beams || layers.nodes || sel === 'arc' || country,
        stats: true,
        operations: layers.operations || sel === 'op' || country || searching,
        movements: layers.movement || sel === 'move',
        providers: layers.hosting || sel === 'provider' || country || searching,
        overindex: layers.baseline || country,
        campaigns: layers.campaigns || sel === 'campaign' || searching,
        actors: layers.actors || sel === 'actor' || searching,
        // A country drawer alone does not need the shapes: only a visible choropleth draws them.
        geometry: layers.baseline,
        timeline: layers.particles || layers.movement,
        live: layers.nodes,
      };
    }
    case 'heatmap':
      return { ...NONE, heatmap: true, stats: true };
    case 'bot_density':
      // The Radar bot share is painted on the country shapes.
      return { ...NONE, bot: true, geometry: true };
  }
}

export type NeedKey = keyof DataNeeds;

export type QueryErrors<E> = Partial<Record<NeedKey, E | null>>;

/** Order failures are reported in. */
const FAILURE_KEYS: readonly NeedKey[] = [
  'nodes', 'arcs', 'heatmap', 'stats', 'operations', 'movements', 'providers', 'overindex', 'campaigns', 'actors', 'timeline',
];

/** Names of the failed queries that matter for this view (disabled queries can retain stale errors). */
export function relevantFailures<E>(needs: DataNeeds, errors: QueryErrors<E>): NeedKey[] {
  return FAILURE_KEYS.filter(k => needs[k] && errors[k]);
}

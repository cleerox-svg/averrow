/**
 * Which data each Observatory map mode / lens layer actually needs, and which
 * load errors are relevant to the user for the current view. Keeps off-view
 * queries disabled (no wasted requests, no phantom error banner).
 */

import type { MapMode } from './url-state';
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
  /** Replay histogram (the timeline bar is shown while particles or movement play). */
  timeline: boolean;
  /** Live sonar pings. */
  live: boolean;
}

export interface NeedsOptions {
  /** A node selection exists (it must be resolvable even if the Nodes layer is off). */
  nodeSelected?: boolean;
  /** An arc selection exists. */
  arcSelected?: boolean;
}

const NONE: DataNeeds = {
  nodes: false, arcs: false, heatmap: false, stats: false, bot: false,
  operations: false, movements: false, providers: false, overindex: false, campaigns: false,
  actors: false, timeline: false, live: false,
};

export function dataNeeds(mode: MapMode, layers: LayerToggles, opts: NeedsOptions = {}): DataNeeds {
  switch (mode) {
    case 'global':
      return {
        ...NONE,
        nodes: layers.nodes || !!opts.nodeSelected,
        // Particles + beams are arc-driven; target rings draw with nodes or beams.
        arcs: layers.particles || layers.beams || layers.nodes || !!opts.arcSelected,
        stats: true,
        operations: layers.operations,
        movements: layers.movement,
        providers: layers.hosting,
        overindex: layers.baseline,
        campaigns: layers.campaigns,
        actors: layers.actors,
        timeline: layers.particles || layers.movement,
        live: layers.nodes,
      };
    case 'heatmap':
      return { ...NONE, heatmap: true, stats: true };
    case 'bot_density':
      return { ...NONE, bot: true };
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

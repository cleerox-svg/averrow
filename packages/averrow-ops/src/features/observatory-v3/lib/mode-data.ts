/**
 * Which data each Observatory map mode actually needs, and which load errors
 * are relevant to the user for the current mode. Keeps off-mode queries
 * disabled (no wasted requests, no phantom error banner).
 */

import type { MapMode, LayerToggles } from './url-state';

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
}

export function dataNeeds(mode: MapMode, layers: LayerToggles): DataNeeds {
  switch (mode) {
    case 'global':
      return {
        nodes: true,
        // Particles + beams are arc-driven; target rings draw with nodes or beams.
        arcs: layers.particles || layers.beams || layers.nodes,
        heatmap: false,
        stats: true,
        bot: false,
      };
    case 'heatmap':
      return { nodes: false, arcs: false, heatmap: true, stats: true, bot: false };
    case 'bot_density':
      return { nodes: false, arcs: false, heatmap: false, stats: false, bot: true };
  }
}

export interface QueryErrors<E> {
  nodes?: E | null;
  arcs?: E | null;
  heatmap?: E | null;
  stats?: E | null;
}

/** Names of the failed queries that matter for this mode (disabled queries can retain stale errors). */
export function relevantFailures<E>(needs: DataNeeds, errors: QueryErrors<E>): Array<keyof QueryErrors<E>> {
  const out: Array<keyof QueryErrors<E>> = [];
  if (needs.nodes && errors.nodes) out.push('nodes');
  if (needs.arcs && errors.arcs) out.push('arcs');
  if (needs.heatmap && errors.heatmap) out.push('heatmap');
  if (needs.stats && errors.stats) out.push('stats');
  return out;
}

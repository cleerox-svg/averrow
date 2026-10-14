/**
 * When (and what) to tell the user about an empty global map.
 *
 * "Threat Landscape Clear" is a reassuring claim, so it is only made when we
 * have positively verified it: the map's nodes AND the summary stats for the
 * same view loaded successfully (not stale previous-period data) and agree
 * there is nothing. Anything else shows no overlay, or the honest
 * "no geolocated threats" variant.
 */

import type { MapMode } from './url-state';

export interface ClearOverlayInput {
  mode: MapMode;
  /** Nodes loaded successfully for the CURRENT view (not placeholder data, not errored). */
  nodesReady: boolean;
  nodeCount: number;
  /** Stats loaded successfully for the CURRENT view. */
  stats: { threats_mapped: number; threats_total: number } | null;
}

export type ClearOverlayKind = 'clear' | 'ungeolocated';

export function clearOverlayKind(i: ClearOverlayInput): ClearOverlayKind | null {
  if (i.mode !== 'global') return null;
  if (!i.nodesReady || i.nodeCount > 0) return null;
  if (!i.stats) return null;
  if (i.stats.threats_mapped > 0) return null; // nodes and stats disagree — don't assert anything
  return i.stats.threats_total > 0 ? 'ungeolocated' : 'clear';
}

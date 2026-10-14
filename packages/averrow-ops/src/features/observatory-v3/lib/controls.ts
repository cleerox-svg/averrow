/**
 * The map's secondary controls, as pure state transitions.
 *
 * A lens is the one question the map answers; underneath it the analyst can keep
 * threat traffic as CONTEXT (Off / Nodes / Nodes + Flow), switch the corridors
 * (Beams) and choose the colour key. The URL still stores the nine layer flags
 * (power users keep the 1-9 keys and `?layers=`), so these helpers translate
 * between the two without losing either.
 */

import type { LayerToggles } from './lenses';

export type TrafficMode = 'off' | 'nodes' | 'flow';

/** Which of the three states the nodes / particles flags amount to. */
export function trafficModeOf(l: Pick<LayerToggles, 'nodes' | 'particles'>): TrafficMode {
  if (l.particles) return 'flow';
  return l.nodes ? 'nodes' : 'off';
}

/** The layer flags a traffic mode sets (beams are independent and untouched). */
export function trafficPatch(mode: TrafficMode): Pick<LayerToggles, 'nodes' | 'particles'> {
  switch (mode) {
    case 'off': return { nodes: false, particles: false };
    case 'nodes': return { nodes: true, particles: false };
    case 'flow': return { nodes: true, particles: true };
  }
}

export const TRAFFIC_LABEL: Record<TrafficMode, string> = { off: 'Off', nodes: 'Nodes', flow: 'Nodes + Flow' };

/** Spoken confirmation for a change (the rail announces it through an aria-live region). */
export function announceTraffic(mode: TrafficMode, reducedMotion: boolean): string {
  if (mode === 'off') return 'Threat traffic underneath: off';
  if (mode === 'nodes') return 'Threat traffic underneath: nodes';
  return reducedMotion ? 'Threat traffic underneath: nodes with static beams (reduced motion)' : 'Threat traffic underneath: nodes and flow';
}

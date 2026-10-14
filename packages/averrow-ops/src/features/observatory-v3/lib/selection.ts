/**
 * Map selection (node / arc) — resolution from URL keys and card placement.
 * Pure, so it is unit-tested without a map.
 */

import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import { arcKey, nodeKey } from './url-state';
import { getArcPath } from './trips';

export type MapSelection =
  | { kind: 'node'; node: ThreatPoint }
  | { kind: 'arc'; arc: ArcData };

export function selectionKey(s: MapSelection): string {
  return s.kind === 'node' ? `node:${nodeKey(s.node)}` : `arc:${arcKey(s.arc)}`;
}

/** Find the object a URL key refers to in the CURRENT data; null if it's no longer present. */
export function resolveSelection(
  nodeParam: string | null,
  arcParam: string | null,
  threats: ThreatPoint[],
  arcs: ArcData[],
): MapSelection | null {
  if (nodeParam) {
    const node = threats.find(t => nodeKey(t) === nodeParam);
    return node ? { kind: 'node', node } : null;
  }
  if (arcParam) {
    const arc = arcs.find(a => arcKey(a) === arcParam);
    return arc ? { kind: 'arc', arc } : null;
  }
  return null;
}

/** Geographic anchor ([lng, lat]) used to place the card when there was no click (URL restore). */
export function selectionLngLat(s: MapSelection): [number, number] {
  if (s.kind === 'node') return [s.node.lng, s.node.lat];
  const path = getArcPath(s.arc);
  return path[Math.floor(path.length / 2)];
}

export interface CardBounds {
  /** Container width/height in px. */
  width: number;
  height: number;
  /** Width of whatever overlays the container's right edge (open side panel). */
  rightInset?: number;
}

/**
 * Top-left position for a card anchored at (x, y), kept fully inside the
 * container (minus the right inset). If the card cannot fit, it pins to the margin.
 */
export function clampCardPosition(
  anchor: { x: number; y: number },
  card: { width: number; height: number },
  bounds: CardBounds,
  margin = 8,
  offset = 12,
): { left: number; top: number } {
  const maxLeft = bounds.width - (bounds.rightInset ?? 0) - card.width - margin;
  const maxTop = bounds.height - card.height - margin;
  return {
    left: Math.max(margin, Math.min(anchor.x + offset, maxLeft)),
    top: Math.max(margin, Math.min(anchor.y + offset, maxTop)),
  };
}

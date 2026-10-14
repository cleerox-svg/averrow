/**
 * Map selection (node / arc) — resolution from URL keys and card placement.
 * Pure, so it is unit-tested without a map.
 */

import type { ArcData, ThreatPoint } from '@/hooks/useObservatory';
import { arcKey, nodeKey } from './url-state';
import { getArcPath } from './trips';
import { hasValidArc, hasValidPosition } from './geo';

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

/**
 * Geographic anchor ([lng, lat]) of a selection: the node itself, or the arc's
 * mid-point. Null when the selection has no placeable position (so callers skip
 * the projection / camera move instead of feeding NaN to the map).
 */
export function selectionLngLat(s: MapSelection): [number, number] | null {
  if (s.kind === 'node') {
    return hasValidPosition(s.node.lat, s.node.lng) ? [s.node.lng, s.node.lat] : null;
  }
  if (!hasValidArc(s.arc)) return null;
  const path = getArcPath(s.arc);
  const mid = path[Math.floor(path.length / 2)];
  if (mid && hasValidPosition(mid[1], mid[0])) return [mid[0], mid[1]];
  // Degenerate path: fall back to the endpoints' mid-point.
  const [sx, sy] = s.arc.sourcePosition;
  const [tx, ty] = s.arc.targetPosition;
  return [(sx + tx) / 2, (sy + ty) / 2];
}

export interface CardBounds {
  /** Container width/height in px. */
  width: number;
  height: number;
  /** Width of whatever overlays the container's right edge (open side panel). */
  rightInset?: number;
}

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);

/**
 * Top-left position for a card anchored at (x, y), kept fully inside the
 * container (minus the right inset). If the card cannot fit, it pins to the
 * margin. Non-finite inputs (an unmeasured card, a projection that failed) are
 * treated as 0 so the result is always finite.
 */
export function clampCardPosition(
  anchor: { x: number; y: number },
  card: { width: number; height: number },
  bounds: CardBounds,
  margin = 8,
  offset = 12,
): { left: number; top: number } {
  const maxLeft = finite(bounds.width, 0) - finite(bounds.rightInset ?? 0, 0) - finite(card.width, 0) - margin;
  const maxTop = finite(bounds.height, 0) - finite(card.height, 0) - margin;
  return {
    left: Math.max(margin, Math.min(finite(anchor.x, 0) + offset, maxLeft)),
    top: Math.max(margin, Math.min(finite(anchor.y, 0) + offset, maxTop)),
  };
}

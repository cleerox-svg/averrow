/**
 * Greedy screen-space label placement.
 *
 * Map labels are cheap to draw and expensive to read: a dozen overlapping edge
 * names are noise. Given candidates already projected to screen pixels, keep the
 * highest-priority ones that neither overlap each other nor sit on a node, cap
 * the total, and flip rotated text so it never reads upside down. No library:
 * the candidate counts are tens, so an O(n·k) box test is plenty, and it only
 * runs when the camera settles (not per frame).
 */

export interface LabelCandidate {
  id: string;
  text: string;
  /** Anchor, screen px. */
  x: number;
  y: number;
  /** Higher wins a collision. */
  priority: number;
  /** Screen angle of the thing it labels, degrees (y down). Text is rotated to follow it, kept upright. */
  angle?: number;
  /** Pixel offset the layer applies from the anchor (so the box is tested where the text really sits). */
  dx?: number;
  dy?: number;
}

/** A disc the labels must keep clear of (a node). */
export interface Obstacle { x: number; y: number; r: number }

export interface PlacedLabel {
  id: string;
  /** Upright screen angle, degrees. */
  angle: number;
}

export interface PlaceOptions {
  width: number;
  height: number;
  /** Mono glyph advance at the label size (px). */
  charPx?: number;
  /** Line height (px). */
  heightPx?: number;
  /** Clearance kept round every label (px). */
  pad?: number;
  /** Most labels to keep. */
  max?: number;
  obstacles?: readonly Obstacle[];
}

/** Rotate text so it reads left-to-right: (-90, 90]. */
export function uprightAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = ((deg + 180) % 360 + 360) % 360 - 180; // (-180, 180]
  if (a === -180) a = 180;
  if (a > 90) a -= 180;
  else if (a <= -90) a += 180;
  return a;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

function boxFor(c: LabelCandidate, angle: number, charPx: number, heightPx: number, pad: number): Box {
  const w = c.text.length * charPx + 2 * pad;
  const h = heightPx + 2 * pad;
  const rad = (angle * Math.PI) / 180;
  const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
  const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
  const cx = c.x + (c.dx ?? 0);
  const cy = c.y + (c.dy ?? 0);
  return { x0: cx - bw / 2, x1: cx + bw / 2, y0: cy - bh / 2, y1: cy + bh / 2 };
}

const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const hitsDisc = (b: Box, o: Obstacle): boolean => {
  const nx = Math.max(b.x0, Math.min(o.x, b.x1));
  const ny = Math.max(b.y0, Math.min(o.y, b.y1));
  return (nx - o.x) ** 2 + (ny - o.y) ** 2 < o.r * o.r;
};

/** Keep the labels that fit. Result order = priority order. */
export function placeLabels(candidates: readonly LabelCandidate[], opts: PlaceOptions): PlacedLabel[] {
  const charPx = opts.charPx ?? 6.4;
  const heightPx = opts.heightPx ?? 13;
  const pad = opts.pad ?? 3;
  const max = opts.max ?? 24;
  const obstacles = opts.obstacles ?? [];
  const sorted = [...candidates].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept: Box[] = [];
  const out: PlacedLabel[] = [];
  for (const c of sorted) {
    if (out.length >= max) break;
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const angle = uprightAngle(c.angle ?? 0);
    const box = boxFor(c, angle, charPx, heightPx, pad);
    // Off screen (or half off it): skip rather than clip.
    if (box.x0 < 0 || box.y0 < 0 || box.x1 > opts.width || box.y1 > opts.height) continue;
    if (kept.some(k => overlaps(box, k))) continue;
    if (obstacles.some(o => hitsDisc(box, o))) continue;
    kept.push(box);
    out.push({ id: c.id, angle });
  }
  return out;
}

/** Same placement (ids, order, angles to the degree)? Lets the map keep layer data identity across no-op camera moves. */
export function samePlacement(a: readonly PlacedLabel[], b: readonly PlacedLabel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.id !== b[i]!.id || Math.round(a[i]!.angle) !== Math.round(b[i]!.angle)) return false;
  }
  return true;
}

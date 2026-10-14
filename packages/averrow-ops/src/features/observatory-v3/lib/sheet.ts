/**
 * Peek sheet snap logic (pure). The sheet rests at ~30% (peek), ~60% or ~90% of
 * the area it sits in; a drag settles on the nearest snap, a fast flick goes to
 * the next one in its direction, and a hard downward flick from the lowest snap
 * dismisses it.
 */

export const SNAPS = [0.3, 0.6, 0.9] as const;
export type SnapIndex = 0 | 1 | 2;

const FLICK_PX_PER_MS = 0.6;

/** Height fraction of a snap. */
export const snapFraction = (i: number): number => SNAPS[Math.min(SNAPS.length - 1, Math.max(0, i))]!;

/**
 * Where a drag ends.
 * @param startFrac fraction the drag began at
 * @param dyPx      pointer travel, px (positive = down)
 * @param areaPx    height of the area the sheet sits in
 * @param velocity  px/ms (positive = down)
 */
export function settleSnap(startFrac: number, dyPx: number, areaPx: number, velocity = 0): { snap: SnapIndex; dismiss: boolean } {
  const area = areaPx > 0 ? areaPx : 1;
  const frac = Math.min(1, Math.max(0, startFrac - dyPx / area));
  const nearest = SNAPS.reduce<number>((best, s, i) => (Math.abs(s - frac) < Math.abs(SNAPS[best]! - frac) ? i : best), 0);
  if (Math.abs(velocity) >= FLICK_PX_PER_MS) {
    const from = SNAPS.reduce<number>((best, s, i) => (Math.abs(s - startFrac) < Math.abs(SNAPS[best]! - startFrac) ? i : best), 0);
    if (velocity > 0) {
      if (from === 0) return { snap: 0, dismiss: true };
      return { snap: Math.max(0, from - 1) as SnapIndex, dismiss: false };
    }
    return { snap: Math.min(SNAPS.length - 1, from + 1) as SnapIndex, dismiss: false };
  }
  // Dragged well below the lowest snap: let go to dismiss.
  if (frac < SNAPS[0]! - 0.12) return { snap: 0, dismiss: true };
  return { snap: nearest as SnapIndex, dismiss: false };
}

/** Next snap when the handle is activated with the keyboard / a tap (cycles peek -> half -> full -> peek). */
export function nextSnap(i: number): SnapIndex {
  return ((i + 1) % SNAPS.length) as SnapIndex;
}

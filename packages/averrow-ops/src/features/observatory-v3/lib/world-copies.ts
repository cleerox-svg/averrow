/**
 * Which world copies a layer is drawn in.
 *
 * On the flat map deck repeats EVERY layer in each visible world copy (the basemap repeats, and a node at 140E must
 * also show at -220E when the camera is over the Pacific). That is right for points and areas, but a flat Operations
 * arc is one polyline in the primary copy ([-180, 180], long way round): repeated, a second copy of the whole web
 * shows up at the edge of the map and again on any canvas wider than the world.
 *
 * Switching the copies off for the lens (the previous approach) is not an answer: MapLibre then clamps the longitude
 * to [-180, 180], so the Pacific cannot be crossed, a selection near the date line sits against the clamp (under the
 * panel), and a canvas wider than the world is force-zoomed (and stays zoomed when the lens is left). So the copies
 * stay ON, and the arc layers alone are skipped in every copy but the primary one, through deck's `layerFilter`.
 */

/** Layers drawn once, in the primary world copy only (the Operations arcs and their labels). */
export const PRIMARY_COPY_ONLY: ReadonlySet<string> = new Set([
  'ops-edges', 'ops-edges-under', 'ops-edges-preview', 'ops-edge-labels',
]);

/** The slice of deck's draw context the filter reads. `subViewports` is null on a repeat-OFF viewport and on an offset copy. */
export interface DrawContextLike {
  layer: { id: string };
  viewport: { subViewports?: unknown } | null | undefined;
}

export interface RepeatState {
  /** The flat (Mercator) map: the globe has no world copies. */
  flat: boolean;
  /** MapLibre's `renderWorldCopies`: when off deck does not repeat, so every viewport is the primary one. */
  renderWorldCopies: boolean;
}

/**
 * deck `layerFilter` for the overlay. In a repeating flat viewport the parent viewport (the primary copy) answers
 * `subViewports` with its list of copies; the offset copies are built without `repeat`, so theirs is null.
 */
export function primaryCopyFilter(state: () => RepeatState): (ctx: DrawContextLike) => boolean {
  return ctx => {
    if (!PRIMARY_COPY_ONLY.has(ctx.layer.id)) return true;
    const { flat, renderWorldCopies } = state();
    if (!flat || !renderWorldCopies) return true;
    return ctx.viewport?.subViewports !== null;
  };
}

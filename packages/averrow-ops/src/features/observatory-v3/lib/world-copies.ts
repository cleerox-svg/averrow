/**
 * Which world copies a layer is drawn in.
 *
 * On the flat map deck repeats EVERY layer in each visible world copy (the basemap repeats, and a node at 140E must
 * also show at -220E when the camera is over the Pacific). That is right for points and areas, but a flat Operations
 * arc is one polyline in the primary copy ([-180, 180], long way round): repeated, a second copy of the whole web
 * shows up at the edge of the map and again on any canvas wider than the world.
 *
 * Switching the copies off for the lens is not an answer: MapLibre then clamps the longitude to [-180, 180], so the
 * Pacific cannot be crossed, a selection near the date line sits against the clamp (under the panel), and a canvas
 * wider than the world is force-zoomed (and stays zoomed when the lens is left). So the copies stay ON and the arc
 * layers skip every copy but the primary one.
 *
 * deck's `layerFilter` cannot do it: it is evaluated once for the PARENT viewport, before the copies are drawn. What
 * does see each copy is the layer's own `_drawLayer`, which receives the copy's viewport (`project.viewport`). The
 * parent viewport answers `subViewports` with its list of copies; the offset copies are built without `repeat`, so
 * theirs is null.
 */

export interface RepeatState {
  /** The flat (Mercator) map: the globe has no world copies. */
  flat: boolean;
  /** MapLibre's `renderWorldCopies`: when off deck does not repeat, so every viewport is the primary one. */
  renderWorldCopies: boolean;
}

let state: RepeatState = { flat: false, renderWorldCopies: false };

/** The map reports how deck is repeating (set whenever the layers are pushed). */
export function setRepeatState(next: RepeatState): void {
  state = next;
}

/** The slice of a deck draw call the check reads. */
export interface DrawArgsLike {
  shaderModuleProps?: { project?: { viewport?: { subViewports?: unknown } | null } | null } | null;
}

/** True when this draw call is for an OFFSET world copy (not the primary one) of a repeating flat map. */
export function isOffsetCopy(args: DrawArgsLike | undefined, s: RepeatState = state): boolean {
  if (!s.flat || !s.renderWorldCopies) return false;
  const viewport = args?.shaderModuleProps?.project?.viewport;
  return !!viewport && viewport.subViewports === null;
}

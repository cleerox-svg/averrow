/**
 * Repaint the flat map's deck canvas in the SAME frame it is resized.
 *
 * The flat map runs deck.gl in overlaid mode: deck owns a second canvas on top of MapLibre's. luma.gl resizes that canvas
 * from its own ResizeObserver, and assigning `canvas.width / height` wipes the drawing buffer. deck only flags a redraw
 * ("Canvas resized") and draws it on the NEXT animation frame, so the browser composites one frame with every deck layer
 * (nodes, blooms, arcs, rings) missing while the basemap is already redrawn: all the dots blink at once, like a refresh.
 *
 * Nothing resizes the canvas on a desktop, but a phone does it all the time: the shell is `100dvh`, so the browser's URL bar
 * collapsing / expanding, a rotation, the on-screen keyboard or a banner changing the page height each resize the map
 * container, and the toolbar animation does it once per frame.
 *
 * Fix: from luma's resize callback (it runs before paint, right after the buffer was cleared) bring deck's own size up to
 * date and redraw synchronously, so the cleared buffer is never presented. Uses deck internals (`MapboxOverlay._deck`,
 * `Deck._updateCanvasSize`): every access is guarded, and a missing member degrades to deck's own next-frame redraw.
 */

interface RepaintableDeck {
  redraw?: (reason?: string) => void;
  _updateCanvasSize?: () => void;
}

/** The Deck behind a MapboxOverlay (private in the typings), or null. */
function deckOf(overlay: unknown): RepaintableDeck | null {
  if (typeof overlay !== 'object' || overlay === null) return null;
  const deck = (overlay as { _deck?: unknown })._deck;
  return typeof deck === 'object' && deck !== null ? (deck as RepaintableDeck) : null;
}

/** Refresh deck's canvas size and draw now. Returns true when a draw was issued. Never throws (a failed draw is deck's next frame). */
export function repaintDeckNow(overlay: unknown): boolean {
  const deck = deckOf(overlay);
  if (!deck || typeof deck.redraw !== 'function') return false;
  try {
    deck._updateCanvasSize?.();
    deck.redraw('Canvas resized');
    return true;
  } catch {
    return false;
  }
}

/**
 * `deviceProps` for an overlaid `MapboxOverlay`: repaints the overlay the moment luma resizes its canvas. `getOverlay` is
 * read lazily because the callback is created before the overlay exists.
 */
export function repaintOnResizeProps(getOverlay: () => unknown): { onResize: () => void } {
  return { onResize: () => { repaintDeckNow(getOverlay()); } };
}

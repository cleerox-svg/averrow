import { useContext, useEffect, useRef } from 'react';
import { UNSAFE_DataRouterContext, UNSAFE_NavigationContext, useLocation, useNavigate } from 'react-router-dom';

/**
 * History-backed dismissal for overlays (sheets, dialogs, drawers) so the
 * system Back gesture closes the overlay instead of leaving the page.
 *
 * - open:        PUSHES one entry for the SAME URL through the router, marked in
 *                `location.state.overlays` with this overlay's id (never raw
 *                `history.pushState`, so react-router's `idx` stays consistent).
 * - system Back: the entry is popped, the marker is gone, `onClose` runs.
 * - UI close:    (X, Esc, backdrop, confirm) the overlay's own entry is still the
 *                current one, so it is popped with `navigate(-1)` exactly once.
 * - forward nav: a link inside the overlay lands on a new entry without the
 *                marker: `onClose` runs, nothing is popped. (The overlay entry
 *                stays behind it; a link that should leave no trace of the
 *                overlay navigates with `replace`.)
 * - nesting:     each entry carries the list of every open overlay id, so Back
 *                closes the topmost one only.
 *
 * Needs a Router. Overlays that must work without one use {@link HistoryDismiss}
 * conditionally (the shared Dialog does, behind `dismissOnBack`).
 *
 * Unmounting while open (e.g. a ConfirmDialog inside a panel that closes with
 * it) pops the entry too, judged against the router's CURRENT entry, so an
 * unmount caused by Back or a forward navigation never pops.
 *
 * Limit: a `setSearchParams(…, { replace: true })` without `state` on the
 * overlay's own entry erases the marker and reads as a close.
 */
export function useHistoryDismiss(open: boolean, onClose: () => void): void {
  const navigate = useNavigate();
  const location = useLocation();
  const idRef = useRef<string | null>(null);
  // True once the router has landed on an entry carrying our marker. Until
  // then a marker-less location is the pre-push location, not a Back.
  const landed = useRef(false);
  const locRef = useRef(location);
  locRef.current = location;
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // The router's live entry state (not the last render's), for decisions made
  // in effects and unmount cleanups. Data routers expose it on `router.state`;
  // Browser/MemoryRouter on the history object.
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const liveState = useRef<() => unknown>(() => location.state);
  liveState.current = () => {
    const fromData = dataRouter?.router.state.location;
    if (fromData) return fromData.state;
    const fromHistory = (navigator as { location?: { state?: unknown } }).location;
    return fromHistory ? fromHistory.state : locRef.current.state;
  };

  // Open pushes; a UI close pops.
  useEffect(() => {
    const loc = locRef.current;
    if (open) {
      if (idRef.current) return;
      const id = newOverlayId();
      idRef.current = id;
      landed.current = false;
      navRef.current(
        { pathname: loc.pathname, search: loc.search, hash: loc.hash },
        { replace: false, state: { ...asRecord(loc.state), [OVERLAYS_KEY]: [...overlayIds(loc.state), id] } },
      );
      return;
    }
    const id = idRef.current;
    if (!id) return;
    idRef.current = null; // before navigating: a second close can never pop again
    if (landed.current) popOverlayEntries(id, liveState.current(), navRef.current);
  }, [open]);

  // Unmounted while open: remove our entry if it is still the current one.
  // Skipped before the push has landed (also the StrictMode simulated unmount).
  useEffect(() => () => {
    const id = idRef.current;
    if (!id || !landed.current) return;
    idRef.current = null;
    popOverlayEntries(id, liveState.current(), navRef.current);
  }, []);

  // The marker leaving the current entry means Back or a forward navigation.
  useEffect(() => {
    const id = idRef.current;
    if (!id) return;
    if (overlayIds(location.state).includes(id)) { landed.current = true; return; }
    if (!landed.current) return;
    idRef.current = null; // not a UI close: never pop afterwards
    consumed.delete(id);
    closeRef.current();
  }, [location]);
}

/** Mount-only wrapper so a component without a Router can opt in conditionally. */
export function HistoryDismiss({ open, onClose }: { open: boolean; onClose: () => void }): null {
  useHistoryDismiss(open, onClose);
  return null;
}

const OVERLAYS_KEY = 'overlays';

/**
 * Ids whose entry an overlay below them already popped (a panel closing together
 * with the confirm nested in it pops both at once, whichever of the two effects
 * runs first, and the router may apply the pops synchronously or not).
 */
const consumed = new Set<string>();

/** Remove `id`'s entry (and the not-yet-removed entries of overlays stacked above it) from history. */
function popOverlayEntries(id: string, state: unknown, navigate: (delta: number) => void): void {
  if (consumed.delete(id)) return;
  const ids = overlayIds(state);
  const at = ids.indexOf(id);
  if (at < 0) return; // the entry is already gone (Back, forward navigation)
  let n = 1;
  for (const above of ids.slice(at + 1)) {
    if (!consumed.has(above)) { consumed.add(above); n += 1; }
  }
  navigate(-n);
}
let seq = 0;
const newOverlayId = (): string => `ov${Date.now().toString(36)}.${(seq++).toString(36)}`;

function asRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}
function overlayIds(state: unknown): string[] {
  const v = asRecord(state)[OVERLAYS_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

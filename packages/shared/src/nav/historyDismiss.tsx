import { useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import { UNSAFE_DataRouterContext, UNSAFE_NavigationContext, useInRouterContext, useLocation, useNavigate } from 'react-router-dom';
import { stateRecord } from './historyState';

/**
 * History-backed dismissal for MODAL overlays (sheets, dialogs, drawers, the
 * palette: anything with a scrim / focus trap / aria-modal) so the system Back
 * gesture closes the overlay instead of leaving the page. Anchored popovers do
 * not use it.
 *
 * - open:        PUSHES one entry for the SAME URL through the router, marked in
 *                `location.state.overlays` with this overlay's id (never raw
 *                `history.pushState`, so react-router's `idx` stays consistent).
 * - system Back: the entry is popped, the marker is gone, `onClose` runs. If the
 *                consumer refuses the close (`open` is still true on the next
 *                render, e.g. a pending ConfirmDialog) the entry is pushed again.
 * - UI close:    (X, Esc, backdrop, confirm) the overlay's own entry is still the
 *                current one, so it is popped with `navigate(-1)` exactly once.
 * - forward nav: a link inside the overlay lands on a new entry without the
 *                marker: `onClose` runs, nothing is popped. Navigate with
 *                `replace` (`useOverlayNavigate` / `OverlayLink`) to leave no
 *                trace of the overlay entry.
 * - nesting:     each entry carries the list of every open overlay id, so Back
 *                closes the topmost one only.
 * - stale ids:   marker ids that no live overlay owns (a reload, Forward into an
 *                old entry) are stripped from the current entry when an overlay
 *                mounts or opens.
 *
 * The hook needs a Router; kit overlays use {@link HistoryDismiss}, which is a
 * no-op without one.
 *
 * Unmounting while open (e.g. a ConfirmDialog inside a panel that closes with
 * it) pops the entry too, judged against the router's CURRENT entry, so an
 * unmount caused by Back or a forward navigation never pops.
 *
 * Limit: a `setSearchParams(…, { replace: true })` without `state` on the
 * overlay's own entry erases the marker and reads as a close; use
 * `useSetSearchParamsKeepState`.
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
  const openRef = useRef(open);
  openRef.current = open;
  const [recheck, setRecheck] = useState(0);
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

  const push = () => {
    const loc = locRef.current;
    const to = { pathname: loc.pathname, search: loc.search, hash: loc.hash };
    let base = stateRecord(liveState.current());
    const all = overlayIds(base);
    const live = all.filter((x) => liveIds.has(x));
    if (live.length !== all.length) {
      // Dead ids from an earlier page life: drop them from this entry first.
      base = { ...base, [OVERLAYS_KEY]: live };
      navRef.current(to, { replace: true, state: base });
    }
    const id = newOverlayId();
    idRef.current = id;
    liveIds.add(id);
    landed.current = false;
    navRef.current(to, { replace: false, state: { ...base, [OVERLAYS_KEY]: [...live, id] } });
  };
  const release = () => {
    const id = idRef.current;
    if (id) liveIds.delete(id);
    idRef.current = null;
  };

  // Open pushes; a UI close pops.
  useEffect(() => {
    if (open) {
      if (!idRef.current) push();
      return;
    }
    const id = idRef.current;
    if (!id) return;
    release(); // before navigating: a second close can never pop again
    popOverlayEntries(id, liveState.current(), navRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push/release only read refs
  }, [open]);

  // Unmounted while open: remove our entry if it is still the current one.
  // Skipped before the push has landed (also the StrictMode simulated unmount).
  useEffect(() => () => {
    const id = idRef.current;
    if (!id || !landed.current) return;
    release();
    popOverlayEntries(id, liveState.current(), navRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The marker leaving the current entry means Back or a forward navigation.
  useEffect(() => {
    const id = idRef.current;
    if (!id) return;
    if (overlayIds(location.state).includes(id)) { landed.current = true; return; }
    if (!landed.current) return;
    release(); // not a UI close: never pop afterwards
    removed.delete(id);
    closeRef.current();
    setRecheck((n) => n + 1); // did the consumer actually close?
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // The consumer refused a Back close (still open): put the entry back.
  useEffect(() => {
    if (recheck > 0 && openRef.current && !idRef.current) push();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheck]);
}

function HistoryDismissInner({ open, onClose }: { open: boolean; onClose: () => void }): null {
  useHistoryDismiss(open, onClose);
  return null;
}

/**
 * Component form of {@link useHistoryDismiss} for kit overlays: outside a Router it
 * does nothing (Back is simply not wired), so `dismissOnBack` never breaks a tree
 * without one.
 */
export function HistoryDismiss({ open, onClose }: { open: boolean; onClose: () => void }): ReactElement | null {
  const inRouter = useInRouterContext();
  return inRouter ? <HistoryDismissInner open={open} onClose={onClose} /> : null;
}

const OVERLAYS_KEY = 'overlays';

/** Ids of overlays that currently own a pushed entry (this page life). */
const liveIds = new Set<string>();

/**
 * Ids whose entry has been (or is being) popped by someone: an outer overlay
 * popping on behalf of the overlays stacked above it, or an inner overlay that
 * popped its own entry. Whichever of a nested pair runs first (React runs child
 * effects first, so an outer overlay that is a hook in an ancestor runs second),
 * the other counts these ids as already removed, and the router may apply pops
 * synchronously (memory) or not (browser).
 */
const removed = new Set<string>();

/** Remove `id`'s entry (and the not-yet-removed entries of overlays stacked above it) from history. */
function popOverlayEntries(id: string, state: unknown, navigate: (delta: number) => void): void {
  if (removed.delete(id)) return; // an overlay below already popped it
  const ids = overlayIds(state);
  const at = ids.indexOf(id);
  if (at < 0) return; // the entry is already gone (Back, forward navigation)
  let n = 1;
  for (const above of ids.slice(at + 1)) {
    if (removed.delete(above)) continue; // the inner overlay already popped its own
    removed.add(above); // its hook will skip (outer-first order)
    n += 1;
  }
  removed.add(id); // inner-first order: a later outer overlay skips this id
  // Keep only marks that can still matter: ids on the entry being popped. A mark
  // for an id no longer on the current entry can never be consulted again (its
  // entry is gone), so prune those instead of letting the set grow. Never clear
  // wholesale: that could wipe the mark a nested partner still needs (over-pop).
  for (const r of removed) if (!ids.includes(r)) removed.delete(r);
  schedulePop(n, navigate);
}

/**
 * Pops requested in the same tick are applied as ONE `navigate(-total)`: two
 * `history.go(-1)` calls issued back to back are not guaranteed to compound
 * (each may be resolved against the same current entry).
 */
let pendingPop = 0;
function schedulePop(n: number, navigate: (delta: number) => void): void {
  const first = pendingPop === 0;
  pendingPop += n;
  if (!first) return;
  queueMicrotask(() => {
    const total = pendingPop;
    pendingPop = 0;
    navigate(-total);
  });
}

let seq = 0;
const newOverlayId = (): string => `ov${Date.now().toString(36)}.${(seq++).toString(36)}`;

function overlayIds(state: unknown): string[] {
  const v = stateRecord(state)[OVERLAYS_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

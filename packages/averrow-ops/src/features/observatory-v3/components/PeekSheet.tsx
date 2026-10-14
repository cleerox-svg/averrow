/**
 * Peek sheet: a NON-modal bottom sheet for phones. It rests at ~30% of the page
 * (a peek that leaves the map usable), drags to ~60% / ~90%, and has no scrim and
 * no focus trap: the map above it stays live. `role="dialog"` WITHOUT `aria-modal`.
 *
 * It reports its height so the map can frame its target in what is left above it
 * (camera bottom inset), instead of flying the target under the sheet. The height is
 * the SETTLED one (snap fraction x area), reported when the snap or the area changes,
 * never per drag frame, so the page doesn't re-render while a finger is moving the sheet.
 *
 * Focus: it takes focus when it opens (the control that opened it may unmount, like the
 * Intel button) and gives it back on close: to the opener, or to `restoreFocus()` when
 * that is gone, never to <body>.
 *
 * Added alongside the shared modal BottomSheet rather than changing it: other
 * screens depend on that one's scrim / scroll lock / modality.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { nextSnap, settleSnap, snapFraction, type SnapIndex } from '../lib/sheet';
import { shouldHandleEscape } from './DrillDrawer';

export interface PeekSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  /** Called with the sheet's current height in px (0 when closed) so the page can set the camera inset. */
  onHeight?: (px: number) => void;
  /** Initial snap each time it opens (default the peek). */
  initialSnap?: SnapIndex;
  /** A stable control to focus on close when the opener no longer exists. */
  restoreFocus?: () => HTMLElement | null;
  children: ReactNode;
}

export function PeekSheet({ open, onClose, label, onHeight, initialSnap = 0, restoreFocus, children }: PeekSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [snap, setSnap] = useState<SnapIndex>(initialSnap);
  const [drag, setDrag] = useState<number | null>(null); // live height fraction while dragging
  const dragRef = useRef<{ startY: number; startFrac: number; lastY: number; lastT: number; v: number; area: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  const restoreRef = useRef(restoreFocus);
  restoreRef.current = restoreFocus;
  const openerRef = useRef<Element | null>(null);

  // A (re)opened sheet starts at its initial snap BEFORE it paints: reset on close, and again as it opens.
  useLayoutEffect(() => {
    setSnap(initialSnap);
    setDrag(null);
  }, [open, initialSnap]);

  // Report the settled height: snap fraction x the area it sits in (what the CSS height resolves to).
  // Re-reported when the area resizes (rotation, URL bar); never while a drag is in flight.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) { onHeightRef.current?.(0); return; }
    const area = () => el.parentElement?.clientHeight ?? 0;
    const report = () => onHeightRef.current?.(Math.round(snapFraction(snap) * area()));
    report();
    const parent = el.parentElement;
    const ro = typeof ResizeObserver !== 'undefined' && parent ? new ResizeObserver(report) : null;
    if (ro && parent) ro.observe(parent);
    return () => { ro?.disconnect(); onHeightRef.current?.(0); };
  }, [open, snap]);

  // Focus in on open, back on close. The opener is read in a layout effect: it runs before the
  // content's own effects, and before anything inside the sheet can take focus.
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    openerRef.current = el && !el.contains(document.activeElement) ? document.activeElement : null;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    // The content (a drill drawer) may already have claimed focus.
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    return () => {
      const cur = document.activeElement;
      if (cur && cur !== document.body && !el?.contains(cur)) return; // focus went somewhere deliberate
      const prev = openerRef.current;
      const target = prev instanceof HTMLElement && prev !== document.body && prev.isConnected ? prev : restoreRef.current?.();
      if (target && target.isConnected) target.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldHandleEscape(e, ref.current)) {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const el = ref.current;
    const area = el?.parentElement?.clientHeight ?? 0;
    if (!el || area <= 0) return;
    dragRef.current = { startY: e.clientY, startFrac: drag ?? snapFraction(snap), lastY: e.clientY, lastT: e.timeStamp, v: 0, area };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  }, [drag, snap]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    setDrag(Math.min(0.95, Math.max(0.12, d.startFrac - (e.clientY - d.startY) / d.area)));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    const dy = e.clientY - d.startY;
    setDrag(null);
    if (Math.abs(dy) < 4) { setSnap(s => nextSnap(s)); return; } // a tap cycles
    const out = settleSnap(d.startFrac, dy, d.area, d.v);
    if (out.dismiss) onCloseRef.current(); else setSnap(out.snap);
  }, []);

  if (!open) return null;
  const frac = drag ?? snapFraction(snap);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={cn('absolute left-0 right-0 bottom-0 flex flex-col rounded-t-2xl outline-none animate-sheet-in motion-reduce:animate-none')}
      style={{
        height: `${Math.round(frac * 1000) / 10}%`,
        zIndex: 25,
        background: 'var(--bg-elevated-solid, var(--bg-elevated))',
        borderTop: '1px solid var(--border-base)',
        boxShadow: '0 -10px 32px rgba(0,0,0,0.35)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        transition: drag === null ? 'height 200ms cubic-bezier(0.22, 0.9, 0.3, 1)' : 'none',
      }}
    >
      <button
        type="button"
        aria-label="Resize panel (drag, or press to cycle height)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // Enter / Space click the button with detail 0 (a pointer tap is handled on pointer-up).
        onClick={e => { if (e.detail === 0) setSnap(s => nextSnap(s)); }}
        onKeyDown={e => {
          if (e.key === 'ArrowUp') { e.preventDefault(); setSnap(s => Math.min(2, s + 1) as SnapIndex); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setSnap(s => Math.max(0, s - 1) as SnapIndex); }
        }}
        className="ds-focusable shrink-0 flex justify-center items-center w-full min-h-[28px] bg-transparent border-0 cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      >
        <span aria-hidden className="block w-10 h-1 rounded-full" style={{ background: 'var(--border-strong)' }} />
      </button>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );
}

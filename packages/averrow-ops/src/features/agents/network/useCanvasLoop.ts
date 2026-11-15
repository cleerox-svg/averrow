// Shared canvas plumbing for the Network view: visibility (tab hidden /
// scrolled offscreen), content-box width, DPR-aware sizing, and a frame loop
// that only runs while there is something to animate.

import { useCallback, useEffect, useRef, useState } from 'react';

/** A ref that also exposes the mounted element as state, so effects re-run
 *  when a conditionally rendered element appears. */
export function useMountedElement<T extends Element>(): [
  { current: T | null }, (node: T | null) => void, T | null,
] {
  const ref = useRef<T | null>(null);
  const [el, setEl] = useState<T | null>(null);
  const callback = useCallback((node: T | null) => {
    ref.current = node;
    setEl(node);
  }, []);
  return [ref, callback, el];
}

/** False while the tab is hidden or the element is scrolled out of view. */
export function useIsVisible(el: Element | null): boolean {
  const [onscreen, setOnscreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(
    typeof document === 'undefined' ? true : !document.hidden,
  );
  useEffect(() => {
    const onVis = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnscreen(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return onscreen && tabVisible;
}

function contentWidth(el: Element): number {
  const rect = el.getBoundingClientRect().width;
  if (typeof getComputedStyle !== 'function') return rect;
  const cs = getComputedStyle(el);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  return Math.max(0, rect - pad - border);
}

/** Content-box width of an element (padding excluded), 0 until measured. */
export function useElementWidth(el: Element | null): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const read = () => setW(Math.round(contentWidth(el)));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

/** Size a canvas backing store for the device pixel ratio and return the 2D context. */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Repaint callback for a device-pixel-ratio change (zoom, moving screens).
 *  A resolution query only matches one ratio, so re-arm it after each change. */
function watchDpr(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  let mql: MediaQueryList | null = null;
  let handler: (() => void) | null = null;
  const detach = () => { if (mql && handler) mql.removeEventListener?.('change', handler); };
  const arm = () => {
    mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    handler = () => { onChange(); detach(); arm(); };
    mql.addEventListener?.('change', handler);
  };
  arm();
  return detach;
}

export const IDLE_REPAINT_MS = 1000;

/**
 * Drive `draw` while `animate` and `visible` hold. `draw` returns false when
 * nothing on the frame is moving: the loop then repaints once a second
 * (clock, heartbeat) instead of every frame. When not animating (reduced
 * motion, Pause, no timeline, hidden or offscreen) no frames are requested:
 * it draws once whenever `deps` change or the DPR does.
 */
export function useCanvasLoop(
  draw: () => boolean | void,
  animate: boolean,
  visible: boolean,
  deps: ReadonlyArray<unknown>,
): void {
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    if (!visible) return;
    if (!animate) {
      drawRef.current();
      return watchDpr(() => { drawRef.current(); });
    }
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = () => {
      const busy = drawRef.current();
      if (busy === false) timer = setTimeout(frame, IDLE_REPAINT_MS);
      else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [animate, visible, ...deps]);
}

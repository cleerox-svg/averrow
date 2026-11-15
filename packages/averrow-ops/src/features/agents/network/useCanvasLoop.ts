// Shared canvas plumbing for the Network view: reduced-motion preference,
// visibility (tab hidden / scrolled offscreen), DPR-aware sizing, and a
// frame loop that only runs while there is something to animate.

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

const RM_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeRm(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(RM_QUERY);
  mql.addEventListener?.('change', onChange);
  return () => mql.removeEventListener?.('change', onChange);
}
function rmSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(RM_QUERY).matches;
}
/** True when the OS asks for reduced motion. */
export function useReducedMotionPref(): boolean {
  return useSyncExternalStore(subscribeRm, rmSnapshot, () => false);
}

/** False while the tab is hidden or the element is scrolled out of view. */
export function useIsVisible(ref: RefObject<Element | null>): boolean {
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
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnscreen(last.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return onscreen && tabVisible;
}

/** Width of an element, tracked with ResizeObserver (0 until measured). */
export function useElementWidth(ref: RefObject<Element | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.round(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
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

/**
 * Run `draw(now)` every animation frame while `animate` and `visible` hold;
 * otherwise draw once whenever `deps` change (reduced motion, hidden tab,
 * offscreen: no frames are requested at all).
 */
export function useCanvasLoop(
  draw: () => void,
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
      return;
    }
    let id = 0;
    const frame = () => {
      drawRef.current();
      id = requestAnimationFrame(frame);
    };
    id = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(id);
  }, [animate, visible, ...deps]);
}

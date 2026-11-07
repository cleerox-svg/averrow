// Gliding indicator (FLIP): place an absolutely positioned indicator on the
// active item of a container and animate it from its previous box to the new
// one. Shared by the nav rail (axis y) and the tab underline (axis x).
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { MOTION, fadeIn, play, prefersReducedMotion, springEasing } from './motion';

export interface GlideOptions {
  /** 'y' = vertical rail (top/height), 'x' = underline (left/width). */
  axis: 'x' | 'y';
  /** Selector for the active item inside the container. */
  selector: string;
  /** Shrink the indicator by this many px at each end. */
  inset?: number;
  /** Only true while motion is on (the indicator element is rendered). */
  enabled: boolean;
}

/**
 * While enabled, marks the container `data-glide` (CSS hands the item's own
 * active mark over to the indicator) and keeps the indicator on the active
 * item; every `moveKey` change glides it there. Disabled: removes the mark.
 */
export function useGlideIndicator(
  containerRef: RefObject<HTMLElement | null>,
  indicatorRef: RefObject<HTMLElement | null>,
  moveKey: unknown,
  { axis, selector, inset = 0, enabled }: GlideOptions,
): void {
  const last = useRef<{ pos: number; size: number } | null>(null);

  useLayoutEffect(() => {
    const box = containerRef.current;
    const ind = indicatorRef.current;
    if (!enabled || !box || !ind) {
      box?.removeAttribute('data-glide');
      last.current = null;
      return;
    }
    box.setAttribute('data-glide', '');
    const posProp = axis === 'x' ? 'left' : 'top';
    const sizeProp = axis === 'x' ? 'width' : 'height';

    const place = (animate: boolean) => {
      const target = box.querySelector<HTMLElement>(selector);
      if (!target) {
        ind.style.opacity = '0';
        last.current = null;
        return;
      }
      const b = box.getBoundingClientRect();
      const t = target.getBoundingClientRect();
      const pos = (axis === 'x'
        ? t.left - b.left + box.scrollLeft - box.clientLeft
        : t.top - b.top + box.scrollTop - box.clientTop) + inset;
      const size = Math.max(0, (axis === 'x' ? t.width : t.height) - inset * 2);
      const prev = last.current;
      last.current = { pos, size };
      ind.style.opacity = '1';
      ind.style[posProp] = `${pos}px`;
      ind.style[sizeProp] = `${size}px`;
      if (!animate) return;
      if (!prev) { fadeIn(ind); return; }
      if (prev.pos === pos && prev.size === size) return;
      if (prefersReducedMotion()) { fadeIn(ind); return; }
      play(ind, [
        { [posProp]: `${prev.pos}px`, [sizeProp]: `${prev.size}px` },
        { [posProp]: `${pos}px`, [sizeProp]: `${size}px` },
      ], MOTION.slow, springEasing());
    };

    place(true);
    // Items can shift while the container keeps its size (a tab count
    // loading late, a web-font swap), so observe the container's children
    // and the active item too, and re-place once the fonts have loaded.
    let live = true;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (live) place(false); }) : null;
    if (ro) {
      ro.observe(box);
      for (const child of Array.from(box.children)) if (child !== ind) ro.observe(child);
      const active = box.querySelector(selector);
      if (active && active.parentElement !== box) ro.observe(active);
    }
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    fonts?.ready?.then(() => { if (live) place(false); }, () => {});
    return () => { live = false; ro?.disconnect(); };
  }, [containerRef, indicatorRef, moveKey, axis, selector, inset, enabled]);

  // Unmount: leave the container as we found it.
  useLayoutEffect(() => {
    const box = containerRef.current;
    return () => box?.removeAttribute('data-glide');
  }, [containerRef]);
}

// Gliding shared nav indicator (Kinetic move 2). Render it as a child of the
// nav container; it rides to the active link ([aria-current="page"] by
// default) on every `activeKey` change. Renders nothing without an accent.
import { useLayoutEffect, useRef } from 'react';
import { useMotionOn } from './motion';
import { useGlideIndicator } from './useGlideIndicator';

export interface NavIndicatorProps {
  /** Changes whenever the active link may have moved (e.g. the pathname). */
  activeKey: unknown;
  selector?: string;
  /** Vertical inset at each end, px (matches the legacy bar's 6px). */
  inset?: number;
}

export function NavIndicator({ activeKey, selector = '[aria-current="page"]', inset = 6 }: NavIndicatorProps) {
  const on = useMotionOn();
  const ref = useRef<HTMLSpanElement>(null);
  const container = useRef<HTMLElement | null>(null);
  // Runs before the glide effect below (declaration order).
  useLayoutEffect(() => {
    if (ref.current?.parentElement) container.current = ref.current.parentElement;
  });
  useGlideIndicator(container, ref, activeKey, { axis: 'y', selector, inset, enabled: on });
  return on ? <span ref={ref} aria-hidden="true" className="motion-glide motion-glide--y" /> : null;
}

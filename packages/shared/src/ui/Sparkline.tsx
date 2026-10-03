// @averrow/shared/ui — Sparkline
//
// Small inline trend line for cards. Promoted from averrow-ops
// `TrendSparkline`: memoised, `useId` gradients, ResizeObserver for fluid
// width. SVG only, no chart dependency.
//
// Decorative (`aria-hidden`) by default; pass `label` to expose it as
// `role="img"` with an accessible name. Fewer than 2 points renders a flat
// placeholder line so rows keep their height.

import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from './lib/useReducedMotion';

export interface SparklineProps {
  data: number[];
  /** Pixel width (ignored when `fill`). Default 80. */
  width?: number;
  /** Pixel height. Default 28. */
  height?: number;
  /** Line + fill colour (any CSS colour). Default `var(--amber)`. */
  color?: string;
  /** Fill the container width (measured with ResizeObserver). */
  fill?: boolean;
  /** Fade in on mount. Disabled under reduced motion. Default true. */
  animate?: boolean;
  /** Accessible name. Omit for a purely decorative sparkline. */
  label?: string;
  /**
   * Y-range anchor. `auto` (default) spans the data's min..max; `zero` always
   * includes 0, so the line height is proportional to the value (use for
   * counts/backlogs where "half the peak" should look like half).
   */
  baseline?: 'auto' | 'zero';
}

// Inset from the box edge: end-dot radius (2.5) + stroke, so the dot and its
// glow stay inside the viewBox and never bleed into a card border.
const PAD = 4;

export const Sparkline = memo(function Sparkline({
  data,
  width: widthProp = 80,
  height = 28,
  color = 'var(--amber)',
  fill = false,
  animate = true,
  label,
  baseline = 'auto',
}: SparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(widthProp);
  const reduced = useReducedMotion();
  const uid = useId().replace(/:/g, '');
  const gradId = `spk-${uid}`;
  const glowId = `spk-glow-${uid}`;

  useEffect(() => {
    const el = containerRef.current;
    if (!fill || !el) return;
    const measure = () => setMeasured(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  const width = fill ? measured : widthProp;

  const points = useMemo(() => {
    if (!data || data.length < 2) return null;
    const finite = data.filter(Number.isFinite);
    if (finite.length < 2) return null;
    const min = baseline === 'zero' ? Math.min(0, ...finite) : Math.min(...finite);
    const max = baseline === 'zero' ? Math.max(0, ...finite) : Math.max(...finite);
    const range = max - min || 1;
    const w = width - PAD * 2;
    const h = height - PAD * 2;
    return data.map((v, i) => ({
      x: PAD + (i / (data.length - 1)) * w,
      y: PAD + h - (((Number.isFinite(v) ? v : min) - min) / range) * h,
    }));
  }, [data, width, height, baseline]);

  const a11y = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);

  const svgStyle = {
    // Clip to the viewBox (PAD keeps the end dot inside it).
    overflow: 'hidden',
    flexShrink: 0,
    display: 'block',
    animation: animate && !reduced ? 'shared-fade-in 600ms ease-out' : undefined,
  } as const;

  let svg;
  if (!points) {
    const y = height / 2;
    svg = (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={svgStyle} {...a11y}>
        <line
          x1={PAD} x2={Math.max(PAD, width - PAD)} y1={y} y2={y}
          stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 3"
        />
      </svg>
    );
  } else {
    const last = points[points.length - 1]!;
    const first = points[0]!;
    const linePath = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
    const areaPath = `${linePath} L ${last.x.toFixed(1)} ${height} L ${first.x.toFixed(1)} ${height} Z`;
    svg = (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={svgStyle} {...a11y}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
          <filter id={glowId}>
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1" strokeOpacity="0.35" filter={`url(#${glowId})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={last.x} cy={last.y} r="2.5" fill={color} style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      </svg>
    );
  }

  return fill ? <div ref={containerRef} style={{ width: '100%' }}>{svg}</div> : svg;
});

// Averrow — TrendSparkline
// Small inline sparkline for use inside cards.
// SVG-based, no external dependency.
// Gradient fill + glowing line + animated on mount.
// Supports fluid width (fill=true) for responsive layouts.

import { memo, useId, useMemo, useRef, useState, useEffect } from 'react';

export interface TrendSparklineProps {
  data:     number[];
  width?:   number;
  height?:  number;
  color?:   string;    // line + fill color, defaults to amber
  animate?: boolean;
  fill?:    boolean;   // fill container width (ignores width prop)
}

export const TrendSparkline = memo(function TrendSparkline({
  data,
  width:  widthProp = 80,
  height  = 28,
  color   = 'var(--amber)',
  animate = true,
  fill    = false,
}: TrendSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState(widthProp);

  useEffect(() => {
    if (!fill || !containerRef.current) return;
    const measure = () => {
      if (containerRef.current) setMeasuredWidth(containerRef.current.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [fill]);

  const width = fill ? measuredWidth : widthProp;
  const gradId = useId();

  const points = useMemo(() => {
    if (!data || data.length < 2) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 2;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const pts = data.map((v, i) => ({
      x: pad + (i / (data.length - 1)) * w,
      y: pad + h - ((v - min) / range) * h,
    }));
    return pts;
  }, [data, width, height]);

  if (!points) return null;

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const areaPath = [
    linePath,
    `L ${points[points.length - 1].x.toFixed(1)} ${height}`,
    `L ${points[0].x.toFixed(1)} ${height}`,
    'Z',
  ].join(' ');

  const svg = (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        overflow: 'visible',
        flexShrink: 0,
        display: 'block',
        animation: animate ? 'trend-sparkline-fade 600ms ease-out' : undefined,
      }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
        <filter id={`${gradId}-glow`}>
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
        </filter>
      </defs>

      {/* Area fill */}
      <path d={areaPath} fill={`url(#${gradId})`} />

      {/* Glow line */}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1"
        strokeOpacity="0.35"
        filter={`url(#${gradId}-glow)`}
      />

      {/* Main line */}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* End dot */}
      <circle
        cx={points[points.length - 1].x}
        cy={points[points.length - 1].y}
        r="2.5"
        fill={color}
        style={{ filter: `drop-shadow(0 0 4px ${color})` }}
      />
    </svg>
  );

  if (fill) {
    return <div ref={containerRef} style={{ width: '100%' }}>{svg}</div>;
  }
  return svg;
});

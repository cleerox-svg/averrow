import { cn } from '@/lib/cn';

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  className?: string;
}

function tierColor(data: number[]): string {
  const max = Math.max(...data);
  if (max >= 200) return '#f87171';
  if (max >= 100) return '#fb923c';
  if (max >= 50) return '#fbbf24';
  return '#78A0C8';
}

export function Sparkline({ data, color, width = 120, height = 28, className }: SparklineProps) {
  if (!data || data.length === 0) return null;

  const resolvedColor = color ?? tierColor(data);
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  const padding = 1;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;

  const points = data
    .map((value, i) => {
      const x = padding + (i / (data.length - 1 || 1)) * plotWidth;
      const y = padding + plotHeight - ((value - min) / range) * plotHeight;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('block', className)}
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={resolvedColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

import { cn } from '@/lib/cn';

interface TrendBadgeProps {
  trend: number | null;
  className?: string;
}

export function TrendBadge({ trend, className }: TrendBadgeProps) {
  if (trend == null || !isFinite(trend) || trend === 0) {
    return <span className={cn('font-mono text-xs text-white/40', className)}>&mdash;</span>;
  }

  const isPositive = trend > 0;

  return (
    <span
      className={cn(
        'font-mono text-xs font-semibold',
        isPositive ? 'text-red-400' : 'text-green-400',
        className,
      )}
    >
      {isPositive ? '\u25B2' : '\u25BC'} {Math.abs(trend).toFixed(1)}%
    </span>
  );
}

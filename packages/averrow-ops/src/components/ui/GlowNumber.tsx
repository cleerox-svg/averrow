// Averrow UI Standard — GlowNumber v1.0
// Animated metric with accent text shadow.
// See AVERROW_UI_STANDARD.md for full spec.

import { useCountUp } from '@/hooks/useCountUp';

export type GlowSize = 'sm' | 'md' | 'lg' | 'xl';
export type GlowFormat = 'number' | 'compact';

export interface GlowNumberProps {
  value: number;
  color: string;
  size?: GlowSize;
  animate?: boolean;
  format?: GlowFormat;
  suffix?: string;
}

const SIZE_MAP: Record<GlowSize, { fontSize: number; letterSpacing: number }> = {
  sm: { fontSize: 18, letterSpacing: -0.5 },
  md: { fontSize: 24, letterSpacing: -0.5 },
  lg: { fontSize: 32, letterSpacing: -1   },
  xl: { fontSize: 42, letterSpacing: -2   },
};

function toCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function GlowNumber({
  value,
  color,
  size    = 'lg',
  animate = true,
  format  = 'number',
  suffix,
}: GlowNumberProps) {
  const counted = useCountUp(animate ? value : 0);
  const final   = animate ? counted : value;
  const display = format === 'compact' ? toCompact(final) : final.toLocaleString();
  const sz      = SIZE_MAP[size];

  return (
    <span
      style={{
        fontSize:      sz.fontSize,
        fontWeight:    900,
        fontFamily:    'monospace',
        letterSpacing: sz.letterSpacing,
        color,
        textShadow:    `0 0 20px ${color}60, 0 0 40px ${color}30`,
        fontVariantNumeric: 'tabular-nums',
        lineHeight:    1,
      }}
    >
      {display}
      {suffix && (
        <span style={{ fontSize: sz.fontSize * 0.55, marginLeft: 2, opacity: 0.7 }}>
          {suffix}
        </span>
      )}
    </span>
  );
}

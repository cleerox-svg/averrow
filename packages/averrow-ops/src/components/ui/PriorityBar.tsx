// Averrow Design System — PriorityBar
//
// Linear progress / score visualization for takedown priority,
// alert priority, lead score, and any other 0-N "how urgent is
// this row" indicator.
//
// Promoted from the inline implementation on Takedown cards
// (`PRIORITY 70/100` with a red fill bar). Audit reframe under
// RESTRUCTURE_SPEC.md spec amendments (Bundle C).
//
// Auto color derives from the percentage filled:
//   0-30%   → green   (low priority / on-track)
//   30-60%  → amber   (medium / monitoring)
//   60-80%  → orange  (high / pay attention)
//   80-100% → red     (critical / act now)
//
// Callers can override with `color` if the semantic doesn't match
// (e.g. for a "% complete" display where high=good, override to
// `green`).

import type { CSSProperties } from 'react';

export type PriorityBarColor = 'auto' | 'green' | 'amber' | 'orange' | 'red';

export interface PriorityBarProps {
  value:      number;
  max?:       number;
  size?:      'sm' | 'md';
  /**
   * When true, renders "{value}/{max}" inline above the bar in
   * monospace small caps. Default false.
   */
  showLabel?: boolean;
  /** Override the auto-derived color. Default 'auto'. */
  color?:     PriorityBarColor;
  className?: string;
  style?:     CSSProperties;
}

const COLOR_MAP: Record<Exclude<PriorityBarColor, 'auto'>, { fill: string; glow: string }> = {
  green:  { fill: 'var(--green)',         glow: 'var(--green-glow)' },
  amber:  { fill: 'var(--sev-medium)',    glow: 'var(--sev-medium-glow)' },
  orange: { fill: 'var(--sev-high)',      glow: 'var(--sev-high-glow)' },
  red:    { fill: 'var(--sev-critical)',  glow: 'var(--sev-critical-glow)' },
};

function autoColor(pct: number): Exclude<PriorityBarColor, 'auto'> {
  if (pct >= 80) return 'red';
  if (pct >= 60) return 'orange';
  if (pct >= 30) return 'amber';
  return 'green';
}

const SIZE: Record<NonNullable<PriorityBarProps['size']>, { height: number; radius: number; labelSize: number }> = {
  sm: { height: 4, radius: 99, labelSize: 9 },
  md: { height: 6, radius: 99, labelSize: 10 },
};

export function PriorityBar({
  value,
  max = 100,
  size = 'sm',
  showLabel = false,
  color = 'auto',
  className,
  style,
}: PriorityBarProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.max(0, Math.min(value, safeMax));
  const pct = (clamped / safeMax) * 100;
  const resolved = color === 'auto' ? autoColor(pct) : color;
  const c = COLOR_MAP[resolved];
  const z = SIZE[size];

  return (
    <div className={className} style={style}>
      {showLabel && (
        <div
          style={{
            fontSize: z.labelSize,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.10em',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
            marginBottom: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>Priority</span>
          <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>
            {Math.round(clamped)}/{safeMax}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        style={{
          width: '100%',
          height: z.height,
          borderRadius: z.radius,
          background: 'rgba(255,255,255,0.06)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: c.fill,
            boxShadow: `0 0 8px ${c.glow}`,
            transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        />
      </div>
    </div>
  );
}

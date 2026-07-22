// Averrow Design System — Card v2.0
// Drop-in replacement for Card + DeepCard.
// Uses CSS custom properties from design-system/tokens.css.
// Same import path, backward-compatible API + new variant system.

import React from 'react';
import { cn } from '@/lib/cn';

export type CardVariant = 'base' | 'elevated' | 'active' | 'critical';

export interface CardProps {
  children: React.ReactNode;
  variant?:    CardVariant;
  accent?:     string;
  padding?:    string | number;
  radius?:     number;
  style?:      React.CSSProperties;
  className?:  string;
  onClick?:    () => void;
  hover?:      boolean;
  // Optional a11y pass-through for Cards that act as a clickable control
  // (e.g. an expand/collapse row). Additive only — omitting these keeps
  // every existing call site's rendered output unchanged.
  role?:       string;
  tabIndex?:   number;
  onKeyDown?:  (e: React.KeyboardEvent<HTMLDivElement>) => void;
  'aria-label'?:    string;
  'aria-expanded'?: boolean;
}

const VARIANT_STYLES: Record<CardVariant, {
  bg: string;
  border: string;
  rim: string;
  shadow: string;
}> = {
  base: {
    bg:     'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%)',
    border: 'var(--border-base)',
    rim:    'var(--border-strong)',
    shadow: 'var(--card-shadow)',
  },
  elevated: {
    bg:     'linear-gradient(160deg, var(--bg-elevated) 0%, var(--bg-card-deep) 100%)',
    border: 'var(--border-strong)',
    rim:    'rgba(255, 255, 255, 0.18)',
    shadow: '0 12px 48px rgba(0, 0, 0, 0.75)',
  },
  active: {
    bg:     'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%)',
    border: 'var(--amber-border)',
    rim:    'rgba(229, 168, 50, 0.35)',
    shadow: 'var(--card-shadow), 0 0 20px var(--amber-glow)',
  },
  critical: {
    // Theme-aware — dark default is byte-identical to the literal this
    // replaced; [data-theme="light"] resolves to a pale red-washed card
    // instead of the same near-black box (see tokens.css --card-critical-bg).
    bg:     'var(--card-critical-bg)',
    border: 'var(--red-border)',
    rim:    'rgba(239, 68, 68, 0.45)',
    shadow: 'var(--card-shadow), 0 0 24px var(--red-glow)',
  },
};

export function Card({
  children,
  variant   = 'base',
  accent,
  padding,
  radius,
  style     = {},
  className = '',
  onClick,
  hover: _hover,
  role,
  tabIndex,
  onKeyDown,
  'aria-label': ariaLabel,
  'aria-expanded': ariaExpanded,
}: CardProps) {
  const v = VARIANT_STYLES[variant];

  // Accent tints previously used raw hex-alpha concatenation
  // (`${accent}30`), which only produces valid CSS when `accent` is a
  // 6-digit hex string. The design system's own guidance is to pass CSS
  // custom properties (`accent="var(--blue)"`), and `var(--blue)30` is
  // invalid CSS — the accent silently no-ops. color-mix() works for both
  // raw hex and var() tokens.
  //
  // The mix percentages are theme-aware CSS vars (tokens.css
  // --card-accent-*-pct), not hardcoded numbers: dark mode stays at the
  // original 19%/25%/9% (matching the visual weight of the old
  // hex-alpha suffixes — 0x30/255≈18.8%, 0x40/255≈25.1%, 0x18/255≈9.4%),
  // but light mode boosts them ~1.56x so an accent border doesn't read
  // weaker on a white card than it does on the dark page — the same
  // boost --border-base/--border-strong already get in light mode
  // (S2.3 follow-up, design review MED).
  const border = accent && variant === 'active'
    ? `color-mix(in srgb, ${accent} var(--card-accent-border-pct), transparent)`
    : v.border;
  const rim    = accent && variant === 'active'
    ? `color-mix(in srgb, ${accent} var(--card-accent-rim-pct), transparent)`
    : v.rim;
  const shadow = accent && variant === 'active'
    ? `var(--card-shadow), 0 0 20px color-mix(in srgb, ${accent} var(--card-accent-glow-pct), transparent)`
    : v.shadow;

  return (
    <div
      onClick={onClick}
      role={role}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      className={className}
      style={{
        background:           v.bg,
        backdropFilter:       'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border:               `1px solid ${border}`,
        borderRadius:         radius ?? 'var(--card-radius)',
        position:             'relative',
        overflow:             'hidden',
        cursor:               onClick ? 'pointer' : 'default',
        // Default to 20px so callers that don't pass a `padding` prop
        // or inline `style.padding` don't have content sitting flush
        // against the rounded corners (which clips section labels).
        // The trailing `...style` spread still wins for explicit overrides.
        padding:              padding ?? '20px',
        boxShadow: [
          shadow,
          `inset 0 1px 0 ${rim}`,
          'inset 0 -1px 0 rgba(0, 0, 0, 0.40)',
        ].join(', '),
        ...style,
      }}
    >
      <div
        aria-hidden
        style={{
          position:      'absolute',
          top: 0, left: 0, right: 0,
          height:        1,
          background:    `linear-gradient(90deg, transparent, ${rim} 25%, ${rim} 75%, transparent)`,
          pointerEvents: 'none',
          zIndex:        2,
        }}
      />
      <div
        aria-hidden
        style={{
          position:      'absolute',
          bottom: 0, left: 0, right: 0,
          height:        1,
          background:    'rgba(0, 0, 0, 0.50)',
          pointerEvents: 'none',
          zIndex:        2,
        }}
      />
      {children}
    </div>
  );
}

export function CardHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'font-mono text-xs font-bold uppercase tracking-wider mb-3',
        className,
      )}
      style={{ color: 'var(--amber)' }}
    >
      {children}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('', className)}>{children}</div>;
}

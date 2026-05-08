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
    bg:     'linear-gradient(150deg, rgba(40, 12, 12, 0.95) 0%, rgba(15, 8, 8, 0.98) 100%)',
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
}: CardProps) {
  const v = VARIANT_STYLES[variant];

  const border = accent && variant === 'active' ? `${accent}30` : v.border;
  const rim    = accent && variant === 'active' ? `${accent}40` : v.rim;
  const shadow = accent && variant === 'active'
    ? `var(--card-shadow), 0 0 20px ${accent}18`
    : v.shadow;

  return (
    <div
      onClick={onClick}
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

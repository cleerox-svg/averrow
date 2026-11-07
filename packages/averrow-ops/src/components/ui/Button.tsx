// Averrow Design System — Button v2.0
// Drop-in replacement for Button + DimensionalButton.
// Uses CSS custom properties from design-system/tokens.css.

import React from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
export type ButtonSize    = 'sm' | 'md' | 'lg';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:   ButtonVariant;
  size?:      ButtonSize;
  fullWidth?: boolean;
  loading?:   boolean;
  icon?:      React.ReactNode;
}

const VARIANT_STYLES: Record<ButtonVariant, React.CSSProperties> = {
  // L2 primary. Legacy look (no data-accent): --btn-primary-* are unset, so the
  // fallbacks render today's amber gradient + black ink. Accent hover/press:
  // tokens.css `.ds-btn-primary` (inline styles cannot carry :hover).
  primary: {
    background: 'var(--btn-primary-bg, linear-gradient(135deg, var(--primary), var(--primary-pressed)))',
    border:     '1px solid color-mix(in srgb, var(--primary) 60%, transparent)',
    color:      'var(--btn-primary-ink, #000)',
    boxShadow: [
      '0 4px 16px var(--primary-glow)',
      '0 2px 4px rgba(0, 0, 0, 0.40)',
      'inset 0 1px 0 rgba(255, 255, 255, 0.30)',
      'inset 0 -1px 0 rgba(0, 0, 0, 0.20)',
    ].join(', '),
  },
  secondary: {
    background: 'linear-gradient(160deg, var(--bg-card), var(--bg-card-deep))',
    border:     '1px solid var(--border-strong)',
    color:      'var(--text-secondary)',
    boxShadow: [
      '0 4px 16px rgba(0, 0, 0, 0.20)',
      'inset 0 1px 0 var(--border-base)',
      'inset 0 -1px 0 var(--border-base)',
    ].join(', '),
  },
  danger: {
    background: 'linear-gradient(135deg, var(--red), var(--red-dim))',
    border:     '1px solid var(--red-border)',
    color:      '#fff',
    boxShadow: [
      '0 4px 16px var(--red-glow)',
      '0 2px 4px rgba(0, 0, 0, 0.40)',
      'inset 0 1px 0 rgba(255, 120, 120, 0.35)',
      'inset 0 -1px 0 rgba(0, 0, 0, 0.30)',
    ].join(', '),
  },
  ghost: {
    background: 'transparent',
    border:     '1px solid var(--border-base)',
    color:      'var(--text-tertiary)',
    boxShadow:  'none',
  },
  success: {
    background: 'linear-gradient(135deg, var(--green), var(--green-dim))',
    border:     '1px solid var(--green-border)',
    color:      '#fff',
    boxShadow: [
      '0 4px 16px var(--green-glow)',
      'inset 0 1px 0 rgba(255, 255, 255, 0.20)',
      'inset 0 -1px 0 rgba(0, 0, 0, 0.25)',
    ].join(', '),
  },
};

const SIZE_STYLES: Record<ButtonSize, React.CSSProperties & { fontSize: number }> = {
  sm: { fontSize: 10, padding: '6px 14px',  borderRadius: 8  },
  md: { fontSize: 11, padding: '9px 20px',  borderRadius: 10 },
  lg: { fontSize: 12, padding: '12px 28px', borderRadius: 12 },
};

export function Button({
  children,
  variant   = 'primary',
  size      = 'md',
  fullWidth = false,
  loading   = false,
  disabled  = false,
  icon,
  className,
  style,
  ...props
}: ButtonProps) {
  const v = VARIANT_STYLES[variant];
  const s = SIZE_STYLES[size];

  return (
    <button
      disabled={disabled || loading}
      className={cn('ds-focusable', variant === 'primary' && 'ds-btn-primary', className)}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        justifyContent: 'center',
        gap:            6,
        width:          fullWidth ? '100%' : 'auto',
        fontFamily:     'var(--font-mono)',
        fontWeight:     800,
        letterSpacing:  '0.06em',
        textTransform:  'uppercase',
        cursor:         disabled || loading ? 'not-allowed' : 'pointer',
        opacity:        disabled ? 0.4 : 1,
        transition:     'var(--transition-fast)',
        userSelect:     'none',
        ...v,
        ...s,
        ...style,
      }}
      {...props}
    >
      {loading ? (
        <span style={{
          width: 12, height: 12, borderRadius: '50%',
          border: '2px solid currentColor',
          borderTopColor: 'transparent',
          animation: 'spin 0.6s linear infinite',
          display: 'inline-block',
        }} />
      ) : icon ? (
        <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>
      ) : null}
      {children}
    </button>
  );
}

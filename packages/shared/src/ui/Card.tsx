import * as React from 'react';
import { cn } from './cn';

// Cinematic glass card. `variant` controls elevation/glow; fully fluid width
// so it reflows in any responsive grid. Styling is inline + CSS custom
// properties from @averrow/shared/theme (portable across both apps).
//
// Composition note: `padding` defaults to 20px so a bare <Card> never sits its
// content flush against the rounded corners. When composing with CardHeader /
// CardContent / CardFooter (which carry their own padding), pass padding="none".
export type CardVariant = 'base' | 'elevated' | 'active' | 'critical' | 'flat';
export type CardPaddingToken = 'none' | 'sm' | 'md' | 'lg';

/** Token scale. `md` is the historical ops default (20px). */
const PADDING_TOKENS: Record<CardPaddingToken, string> = {
  none: '0',
  sm: '12px',
  md: '20px',
  lg: '24px',
};

/** Token -> CSS; number -> px; any other string is passed through as raw CSS. */
export function resolveCardPadding(padding: CardPaddingToken | string | number | undefined): string {
  if (padding === undefined) return PADDING_TOKENS.md;
  if (typeof padding === 'number') return `${padding}px`;
  return (PADDING_TOKENS as Record<string, string>)[padding] ?? padding;
}

const VARIANT_STYLES: Record<CardVariant, { bg: string; border: string; rim: string; shadow: string }> = {
  base: {
    bg: 'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%)',
    border: 'var(--border-base)',
    rim: 'var(--border-strong)',
    shadow: 'var(--card-shadow)',
  },
  elevated: {
    bg: 'linear-gradient(160deg, var(--bg-elevated) 0%, var(--bg-card-deep) 100%)',
    border: 'var(--border-strong)',
    rim: 'var(--card-rim-elevated)',
    shadow: 'var(--card-shadow-elevated)',
  },
  active: {
    bg: 'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%)',
    border: 'var(--amber-border)',
    rim: 'rgba(229, 168, 50, 0.35)',
    shadow: 'var(--card-shadow), 0 0 20px var(--amber-glow)',
  },
  // Inset panel (e.g. a table's expansion row): surface + border only, no
  // shadow, rims or blur.
  flat: {
    bg: 'var(--bg-card-deep)',
    border: 'var(--border-base)',
    rim: 'transparent',
    shadow: 'none',
  },
  critical: {
    // Theme-aware: dark default is the near-black red wash; light resolves to a
    // pale red-washed card (tokens.css --card-critical-bg).
    bg: 'var(--card-critical-bg)',
    border: 'var(--red-border)',
    rim: 'rgba(239, 68, 68, 0.45)',
    shadow: 'var(--card-shadow), 0 0 24px var(--red-glow)',
  },
};

export interface CardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'color'> {
  variant?: CardVariant | 'glow';
  /** Custom glow colour (hex or `var(--token)`); only applies with `variant="active"`. */
  accent?: string;
  /** `none | sm | md | lg`, a number (px) or raw CSS (`'16px 20px'`). Default `md` (20px). */
  padding?: CardPaddingToken | string | number;
  /**
   * Default `hidden` (clips the rim lines to the rounded corners). Use `visible` or
   * `clip` when a descendant needs `position: sticky` (overflow:hidden makes the card
   * the sticky scroll container, so sticky never engages). `clip` still clips paint
   * without creating a scroll container.
   */
  overflow?: 'hidden' | 'visible' | 'clip';
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ variant: variantProp = 'base', accent, padding, overflow = 'hidden', style, onClick, children, ...props }, ref) => {
    // `glow` is the pre-6c shared name for the amber look.
    const variant: CardVariant = variantProp === 'glow' ? 'active' : variantProp;
    const v = VARIANT_STYLES[variant];

    // color-mix works for raw hex and var() tokens alike (hex-alpha suffixes
    // are invalid on var()). Percentages are theme-aware tokens
    // (--card-accent-*-pct) so light mode keeps the accent legible.
    const custom = !!accent && variant === 'active';
    const border = custom ? `color-mix(in srgb, ${accent} var(--card-accent-border-pct), transparent)` : v.border;
    const rim = custom ? `color-mix(in srgb, ${accent} var(--card-accent-rim-pct), transparent)` : v.rim;
    const shadow = custom
      ? `var(--card-shadow), 0 0 20px color-mix(in srgb, ${accent} var(--card-accent-glow-pct), transparent)`
      : v.shadow;

    return (
      <div
        ref={ref}
        onClick={onClick}
        {...props}
        style={{
          background: v.bg,
          backdropFilter: variant === 'flat' ? undefined : 'blur(20px)',
          WebkitBackdropFilter: variant === 'flat' ? undefined : 'blur(20px)',
          border: `1px solid ${border}`,
          borderRadius: 'var(--card-radius)',
          position: 'relative',
          overflow,
          cursor: onClick ? 'pointer' : 'default',
          padding: resolveCardPadding(padding),
          boxShadow: variant === 'flat'
            ? 'none'
            : [shadow, `inset 0 1px 0 ${rim}`, 'inset 0 -1px 0 rgba(0, 0, 0, 0.40)'].join(', '),
          ...style,
        }}
      >
        {variant !== 'flat' && (<>
        <div
          aria-hidden
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, height: 1,
            background: `linear-gradient(90deg, transparent, ${rim} 25%, ${rim} 75%, transparent)`,
            pointerEvents: 'none', zIndex: 2,
          }}
        />
        <div
          aria-hidden
          style={{
            position: 'absolute', bottom: 0, left: 0, right: 0, height: 1,
            background: 'rgba(0, 0, 0, 0.50)', pointerEvents: 'none', zIndex: 2,
          }}
        />
        </>)}
        {children}
      </div>
    );
  },
);
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5 border-b border-[var(--border-base)]', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-[13px] font-bold tracking-[0.01em] text-[var(--text-primary)]', className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-4 sm:p-5', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center gap-3 px-4 py-3.5 sm:px-5 border-t border-[var(--border-base)]', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

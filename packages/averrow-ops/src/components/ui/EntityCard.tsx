// Averrow Design System — EntityCard
// The shared card shell used by Brands, Providers, Campaigns, Threat Actors.
// Provides: gradient background, backdrop blur, left accent border, hover effects.
// Children are fully responsible for internal layout.

import type { ReactNode, CSSProperties } from 'react';

export interface EntityCardProps {
  children: ReactNode;
  /** Left accent border color (typically severity or status color) */
  accent: string;
  /** Click handler — makes the card interactive */
  onClick?: () => void;
  /** Padding. Defaults to '14px 16px' matching Brands. */
  padding?: string | number;
  /** Additional inline styles (merged last) */
  style?: CSSProperties;
  /** className pass-through */
  className?: string;
}

/**
 * The canonical Averrow entity card shell.
 * Matches the Brands module's visual style: gradient + accent border + hover glow.
 */
export function EntityCard({
  children,
  accent,
  onClick,
  padding = '14px 16px',
  style,
  className,
}: EntityCardProps) {
  return (
    <div
      onClick={onClick}
      className={className}
      style={{
        background: 'linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: `1px solid var(--border-base)`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 'var(--card-radius)',
        padding,
        cursor: onClick ? 'pointer' : undefined,
        position: 'relative',
        overflow: 'hidden',
        transition: 'var(--transition-fast)',
        boxShadow: 'var(--card-shadow), inset 0 1px 0 var(--border-strong)',
        ...style,
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = `${accent}60`;
        el.style.boxShadow = `var(--card-shadow), inset 0 1px 0 var(--border-strong), 0 0 20px ${accent}12`;
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.borderColor = 'var(--border-base)';
        el.style.borderLeftColor = accent;
        el.style.boxShadow = 'var(--card-shadow), inset 0 1px 0 var(--border-strong)';
      }}
    >
      {children}
    </div>
  );
}

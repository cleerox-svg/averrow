// Averrow Design System — DimensionalCard
//
// Three-variant dimensional glass card with optional accent-tinted
// gradient and halo. Distinct from the standard Card primitive:
//   - Card uses CSS custom properties for theme-aware fills.
//   - DimensionalCard uses hardcoded rgba values for a deeper, more
//     opaque look — matches the original MobileCommandCenter feel.
//
// Originally lived in components/mobile/MobileUIKit.tsx as DeepCard;
// promoted to the shared design system as part of the unified-Home
// rebuild. The 'stat' variant, when given an accent color, renders
// with that color's gradient + glow — used by StatTile.

export type DimensionalCardVariant = 'base' | 'stat' | 'critical';

export interface DimensionalCardProps {
  children: React.ReactNode;
  /** Hex color for stat-variant gradient + border + glow. */
  accentColor?: string;
  variant?: DimensionalCardVariant;
  style?: React.CSSProperties;
  onClick?: () => void;
}

export function DimensionalCard({
  children,
  accentColor,
  variant = 'base',
  style = {},
  onClick,
}: DimensionalCardProps) {
  const cfg = {
    base: {
      bg: 'linear-gradient(160deg,rgba(22,30,48,0.85),rgba(12,18,32,0.95))',
      border: 'rgba(255,255,255,0.09)',
      rim: 'rgba(255,255,255,0.14)',
      shadow: '0 8px 32px rgba(0,0,0,0.6)',
      inner: 'inset 0 1px 0 rgba(255,255,255,0.10),inset 0 -1px 0 rgba(0,0,0,0.3)',
    },
    stat: {
      bg: accentColor
        ? `linear-gradient(150deg,rgba(22,30,48,0.90),${accentColor}18 70%,rgba(12,18,32,0.98))`
        : 'linear-gradient(160deg,rgba(22,30,48,0.85),rgba(12,18,32,0.95))',
      border: accentColor ? `${accentColor}30` : 'rgba(255,255,255,0.09)',
      rim:    accentColor ? `${accentColor}40` : 'rgba(255,255,255,0.14)',
      shadow: `0 8px 32px rgba(0,0,0,0.6)${accentColor ? `,0 0 20px ${accentColor}18` : ''}`,
      inner:  `inset 0 1px 0 ${accentColor ? accentColor + '30' : 'rgba(255,255,255,0.10)'},inset 0 -1px 0 rgba(0,0,0,0.3)`,
    },
    critical: {
      bg: 'linear-gradient(150deg,rgba(40,12,12,0.95),rgba(15,8,8,0.98))',
      border: 'rgba(239,68,68,0.35)',
      rim: 'rgba(239,68,68,0.45)',
      shadow: '0 8px 32px rgba(0,0,0,0.6),0 0 24px rgba(239,68,68,0.15)',
      inner: 'inset 0 1px 0 rgba(239,68,68,0.30),inset 0 -1px 0 rgba(0,0,0,0.4)',
    },
  }[variant];

  return (
    <div
      onClick={onClick}
      style={{
        background: cfg.bg,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: `1px solid ${cfg.border}`,
        borderRadius: 16,
        position: 'relative',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: `${cfg.shadow},${cfg.inner}`,
        ...style,
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 1,
          pointerEvents: 'none', zIndex: 2,
          background: `linear-gradient(90deg,transparent,${cfg.rim} 30%,${cfg.rim} 70%,transparent)`,
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: 1,
          background: 'rgba(0,0,0,0.5)', pointerEvents: 'none', zIndex: 2,
        }}
      />
      {children}
    </div>
  );
}

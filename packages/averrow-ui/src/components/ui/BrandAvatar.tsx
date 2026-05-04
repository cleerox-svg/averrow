// Averrow Design System — BrandAvatar
//
// 40px gradient-fill avatar with rim lighting + outer glow, intended
// for brand/entity rows in lists. The single white-on-gradient initial
// reads at small sizes against the dark canvas.
//
// Distinct from the Avatar primitive (which supports favicon, severity
// borders, and multiple sizes). BrandAvatar is fixed-size and styled
// for visual depth — used in the Brands at Risk section and similar.
//
// Originally lived in components/mobile/MobileUIKit.tsx; promoted to
// the shared design system as part of the unified-Home rebuild.

export interface BrandAvatarProps {
  /** Display name — first character is rendered as the initial. */
  name: string;
  /** Hex color for the gradient start + border + glow. */
  color: string;
  /** Optional darker hex for the gradient end. Falls back to `color`. */
  dimColor?: string;
}

export function BrandAvatar({ name, color, dimColor }: BrandAvatarProps) {
  return (
    <div
      style={{
        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
        background: `linear-gradient(145deg,${color},${dimColor ?? color})`,
        border: `1px solid ${color}70`,
        boxShadow: [
          '0 4px 14px rgba(0,0,0,0.70)',
          'inset 0 1px 0 rgba(255,255,255,0.28)',
          'inset 0 -1px 0 rgba(0,0,0,0.45)',
          `0 0 18px ${color}35`,
        ].join(','),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 15, fontWeight: 900, color: '#fff',
        textShadow: '0 1px 3px rgba(0,0,0,0.65)',
      }}
    >
      {name[0]?.toUpperCase() ?? '?'}
    </div>
  );
}

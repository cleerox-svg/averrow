// Averrow Design System — BrandAvatar
//
// 40px gradient-fill avatar with rim lighting + outer glow, intended
// for brand/entity rows in lists. Renders the brand's favicon if a
// URL is supplied (with image-load error fallback to the initial), or
// the first letter on a colored gradient when no favicon is available.
//
// Distinct from the Avatar primitive (which carries severity borders
// and multiple sizes). BrandAvatar is fixed-size and tuned for
// vertical visual depth — used in the Brands at Risk section, Brand
// Movers, and similar rows where the brand identity is the primary
// signal.
//
// Originally lived in components/mobile/MobileUIKit.tsx; promoted to
// the shared design system as part of the unified-Home rebuild. The
// favicon support was added in the Phase 1 D1 spend-reduction sweep
// because Brand Movers was rendering letter-only despite the backend
// already returning `logo_url` for every row.

import { useState } from 'react';

export interface BrandAvatarProps {
  /** Display name — first character is rendered as the initial fallback. */
  name: string;
  /** Hex color for the gradient start + border + glow. */
  color: string;
  /** Optional darker hex for the gradient end. Falls back to `color`. */
  dimColor?: string;
  /**
   * Optional favicon/logo URL. When provided, the image is rendered
   * inside the gradient bubble. If the request 404s or fails, the
   * component silently falls back to the colored-gradient initial —
   * the brand row still reads as a brand, never as a broken image.
   */
  faviconUrl?: string | null;
}

export function BrandAvatar({ name, color, dimColor, faviconUrl }: BrandAvatarProps) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const showFavicon = !!faviconUrl && !faviconFailed;

  return (
    <div
      style={{
        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
        background: showFavicon
          // Favicon mode: neutral dark interior so colored logos read
          // cleanly without competing against the brand-tinted gradient.
          ? 'linear-gradient(145deg, rgba(25,35,55,0.95), rgba(10,15,28,0.98))'
          : `linear-gradient(145deg,${color},${dimColor ?? color})`,
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
        overflow: 'hidden',
      }}
    >
      {showFavicon ? (
        <img
          src={faviconUrl!}
          alt={name}
          width={22}
          height={22}
          onError={() => setFaviconFailed(true)}
          style={{ objectFit: 'contain', display: 'block' }}
        />
      ) : (
        name[0]?.toUpperCase() ?? '?'
      )}
    </div>
  );
}

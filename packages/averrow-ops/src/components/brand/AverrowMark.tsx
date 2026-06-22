import { useId } from 'react';

/**
 * Averrow logo MARK — the red-triangle "A"/arrow in a dark rounded tile,
 * standalone (no wordmark). This is the same mark used in the in-app Sidebar
 * (AverrowLogo) and the canonical email lockup (email-layout.ts), extracted as
 * a sizeable tile so brand surfaces — the login brand tile, the passkey
 * enrollment gate — can render the real logo instead of a placeholder glyph.
 *
 * Pair with the AVERROW wordmark separately when a full lockup is wanted.
 */
export function AverrowMark({ size = 56 }: { size?: number }) {
  // Unique gradient id per instance so two marks on one page can't collide.
  const gradId = useId();
  const rx = (size * 6) / 32; // match the SVG's rx=6 on a 32-unit viewBox

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: rx,
        lineHeight: 0,
        flexShrink: 0,
        boxShadow: '0 0 24px rgba(200,60,60,0.38)',
      }}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" fill="none" role="img" aria-label="Averrow">
        <defs>
          <linearGradient id={gradId} x1="16" y1="5" x2="16" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#6B1010" />
            <stop offset="100%" stopColor="#C83C3C" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="6" fill="#0C1220" />
        <rect x="0.5" y="0.5" width="31" height="31" rx="5.5" fill="none" stroke="rgba(200,60,60,0.30)" strokeWidth="1" />
        <path d="M16 5L26 26H18L16 21L14 26H6Z" fill={`url(#${gradId})`} />
        <path d="M14.5 22H17.5L16 18Z" fill="#0C1220" />
      </svg>
    </div>
  );
}

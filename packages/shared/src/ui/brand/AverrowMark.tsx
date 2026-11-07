// R3 Averrow mark (BRAND_BRIEF §9 G1; docs/brand/logo/).
//
// Inline SVG, flat (no glow, no gradient, no rim). Two forms:
//   tile (default) — the mark on the #121B31 tile, radius 7/32, mark 22/32
//                    high: app-icon.svg. Login brand tile, passkey gate.
//   bare           — the mark alone (mark-red.svg), for lockups and inline use.
// The mark is always red #C83C3C, in every accent. Minimum 16px (smaller
// sizes are clamped up); keep a quarter of the mark height clear around it.
//
// Until the P3-6 flip the legacy logo is what users see: swap sites render
// both and toggle with LOGO_LEGACY_CLASS / LOGO_R3_CLASS (see ./logoToggle).

import type { CSSProperties } from 'react';
import { R3_MARK_PATH, R3_MARK_RED, R3_TILE_FILL } from './paths';

export const AVERROW_MARK_MIN_PX = 16;

export interface AverrowMarkProps {
  /** Rendered height in px (the tile is square). Clamped to >= 16. Default 32. */
  size?: number;
  /** Draw the #121B31 tile behind the mark. Default true. */
  tile?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Accessible name. Default "Averrow". Ignored when `decorative`. */
  title?: string;
  /** Hide from assistive tech (when a visible product name sits next to it). */
  decorative?: boolean;
}

export function AverrowMark({
  size = 32, tile = true, className, style, title = 'Averrow', decorative = false,
}: AverrowMarkProps) {
  const h = Math.max(AVERROW_MARK_MIN_PX, size);
  const a11y = decorative
    ? { 'aria-hidden': true as const, focusable: false as const }
    : { role: 'img' as const, 'aria-label': title };

  if (tile) {
    return (
      <svg
        width={h} height={h} viewBox="0 0 32 32" fill="none"
        className={className} style={{ flexShrink: 0, ...style }} data-logo="r3" {...a11y}
      >
        <rect width="32" height="32" rx="7" fill={R3_TILE_FILL} />
        <path transform="translate(1.02 0.86) scale(0.94)" d={R3_MARK_PATH} fill={R3_MARK_RED} />
      </svg>
    );
  }

  return (
    <svg
      width={+(h * 25 / 27.5).toFixed(2)} height={h} viewBox="3.5 2 25 27.5" fill="none"
      className={className} style={{ flexShrink: 0, ...style }} data-logo="r3" {...a11y}
    >
      <path d={R3_MARK_PATH} fill={R3_MARK_RED} />
    </svg>
  );
}

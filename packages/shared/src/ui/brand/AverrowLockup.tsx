// R3 horizontal lockup: bare mark + AVERROW wordmark, no tagline
// (lockup-horizontal-*.svg). The sidebars use this; the tagline stays on login
// and marketing (BRAND_BRIEF §9, "Sidebar").
//
// The wordmark follows `currentColor` by default, so it reads on either theme
// (the svg sets color: var(--text-primary) unless `style.color` overrides it).
// `tone` pins it to the exact brand ink of lockup-horizontal-dark / -light.svg.

import type { CSSProperties } from 'react';
import { AVERROW_MARK_MIN_PX } from './AverrowMark';
import {
  R3_MARK_PATH, R3_MARK_RED, R3_WORDMARK_ON_DARK, R3_WORDMARK_ON_LIGHT, R3_WORDMARK_PATH,
} from './paths';

/** viewBox 172.15 x 48; the mark spans 40 of the 48 units (23.5 * 1.7). */
const VIEW_W = 172.15;
const VIEW_H = 48;
const MARK_SHARE = 40 / VIEW_H;

export interface AverrowLockupProps {
  /** Rendered height in px. Clamped so the mark stays >= 16px. Default 28. */
  height?: number;
  /** Wordmark ink: `current` (currentColor, default), `on-dark` #F2F4F8, `on-light` #0B0F1A. */
  tone?: 'current' | 'on-dark' | 'on-light';
  className?: string;
  style?: CSSProperties;
  /** Accessible name. Default "Averrow". Ignored when `decorative`. */
  title?: string;
  decorative?: boolean;
}

export function AverrowLockup({
  height = 28, tone = 'current', className, style, title = 'Averrow', decorative = false,
}: AverrowLockupProps) {
  const h = Math.max(Math.ceil(AVERROW_MARK_MIN_PX / MARK_SHARE), height);
  const ink = tone === 'on-dark' ? R3_WORDMARK_ON_DARK : tone === 'on-light' ? R3_WORDMARK_ON_LIGHT : 'currentColor';
  const a11y = decorative
    ? { 'aria-hidden': true as const, focusable: false as const }
    : { role: 'img' as const, 'aria-label': title };
  return (
    <svg
      width={+(h * VIEW_W / VIEW_H).toFixed(2)} height={h} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} fill="none"
      className={className}
      style={{ flexShrink: 0, color: 'var(--text-primary)', ...style }}
      data-logo="r3"
      {...a11y}
    >
      <path transform="translate(-5.36 -2.81) scale(1.7)" d={R3_MARK_PATH} fill={R3_MARK_RED} />
      <path transform="translate(55.74 32.1) scale(0.01007)" d={R3_WORDMARK_PATH} fill={ink} />
    </svg>
  );
}

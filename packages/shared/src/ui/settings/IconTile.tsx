// @averrow/shared/ui/settings — IconTile (ACCOUNT_DESIGN_SPEC §4.0)
//
// Tinted rounded tile that carries a section glyph: rails, rows, hero chips.
// Tint percentages come from `--tile-tint-pct` (16% dark / 20% light); glyph
// colours use the AA `-text` tokens. Decorative (aria-hidden).

import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../cn';

export type IconTileTone = 'primary' | 'amber' | 'green' | 'blue' | 'violet' | 'cyan' | 'red' | 'neutral';

/** TINT = accent fill/border colour, GLYPH = AA text colour for the icon. */
export const ICON_TILE_TONES: Record<IconTileTone, { tint: string; glyph: string }> = {
  // Decorative tiles that used to be amber (Profile, its Theme / Time zone
  // rows, the staff-view toggle). Legacy --primary / --primary-text ARE amber /
  // --amber-text, so the legacy look is unchanged; under an accent they follow
  // it. Keep `amber` for tiles that signal a warning (status colour).
  primary: { tint: 'var(--primary)',      glyph: 'var(--primary-text)' },
  amber:   { tint: 'var(--amber)',          glyph: 'var(--amber-text)' },
  green:   { tint: 'var(--green)',          glyph: 'var(--sev-info-text)' },
  blue:    { tint: 'var(--blue)',           glyph: 'var(--sev-low-text)' },
  // --tile-violet(-text) = --violet(-text), except under the Violet accent
  // (rose there, so it never matches the violet primary).
  violet:  { tint: 'var(--tile-violet)',    glyph: 'var(--tile-violet-text)' },
  // Appearance's own tone (no other settings section uses it). --cyan-text is
  // the theme-aware AA cyan; the reserved --thrust / --orbital-teal stay unused.
  // --tile-cyan = --cyan-text, except Lime light (indigo, away from emerald --green).
  cyan:    { tint: 'var(--tile-cyan)',      glyph: 'var(--tile-cyan)' },
  red:     { tint: 'var(--red)',            glyph: 'var(--sev-critical-text)' },
  neutral: { tint: 'var(--text-secondary)', glyph: 'var(--text-secondary)' },
};

export interface IconTileProps {
  tone?: IconTileTone;
  /**
   * Pixel size. Spec sizes: 28 (rail), 32 (row, 36 on mobile — SettingsRow does
   * that itself), 40 (status / dialog), 48 (install card). Omit to inherit the
   * default (32) so a parent can resize it with CSS.
   */
  size?: number;
  /** An inline `<svg>` (sized to 56% of the tile) or any glyph. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function IconTile({ tone = 'neutral', size, children, className, style }: IconTileProps) {
  const t = ICON_TILE_TONES[tone];
  const vars = {
    '--ds-tile-tint': t.tint,
    '--ds-tile-glyph': t.glyph,
    ...(size ? { '--ds-tile-size': `${size}px`, '--ds-tile-radius': `${size <= 28 ? 8 : 9}px` } : null),
  } as CSSProperties;
  return (
    <span aria-hidden="true" data-tone={tone} className={cn('ds-tile', className)} style={{ ...vars, ...style }}>
      {children}
    </span>
  );
}

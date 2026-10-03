// @averrow/shared/ui — Avatar (ENTITY avatars only)
//
// Brands, orgs, providers, threat actors: a favicon/logo with an initial
// fallback. This is NOT a user avatar. Users render initials via
// `@/lib/avatar` (`parseInitials` / `colorForUserId` / `SELF_AVATAR_COLOR`),
// never a profile picture, so there is deliberately no `avatarUrl` prop.
//
// Absorbs the ops `BrandAvatar` (`size={40} glow`) and the BrandsGrid
// `FaviconAvatar` (`tone="neutral"`).
//
// Accessibility: decorative (`aria-hidden`) by default, because the entity
// name is normally rendered next to it. Pass `label` for a standalone avatar
// and it becomes `role="img"` with that accessible name.

import { useState, type CSSProperties } from 'react';
import { cn } from './cn';

export type AvatarSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AvatarTone = 'brand' | 'neutral';

export interface AvatarProps {
  /** Entity name; its first character is the fallback initial. */
  name: string;
  /** Favicon / logo URL. Falls back to the initial if missing or it fails to load. */
  faviconUrl?: string | null;
  /** Gradient start / border / glow colour (any CSS colour). Default `var(--red)`. */
  color?: string;
  /** Gradient end colour. Defaults to a translucent `color`. */
  dimColor?: string;
  /** `brand` (default): coloured gradient tile. `neutral`: quiet tile (list rows). */
  tone?: AvatarTone;
  /** Pixel size. Default 40. */
  size?: number;
  /** Corner radius in px. Default 12 (brand) / 26% of size (neutral). */
  radius?: number;
  /** Initial font size in px. Default 37.5% of size. */
  fontSize?: number;
  /** Severity dot in the bottom-right corner. */
  severity?: AvatarSeverity | (string & {}) | null;
  /** Outer coloured glow (the old BrandAvatar look). */
  glow?: boolean;
  /** Accessible name for a standalone avatar. Omit when the name is shown beside it. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const SEV_DOT: Record<string, string> = {
  critical: 'var(--sev-critical)',
  high: 'var(--sev-high)',
  medium: 'var(--sev-medium)',
  low: 'var(--sev-low)',
  info: 'var(--sev-info)',
};

/** `color` at `pct`% opacity; works for hex and var() colours alike. */
const mix = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function Avatar({
  name,
  faviconUrl,
  color = 'var(--red)',
  dimColor,
  tone = 'brand',
  size = 40,
  radius,
  fontSize,
  severity,
  glow = false,
  label,
  className,
  style,
}: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showFavicon = !!faviconUrl && failedUrl !== faviconUrl;
  const neutral = tone === 'neutral';

  const r = radius ?? (neutral ? Math.round(size * 0.26) : 12);
  const fs = fontSize ?? Math.round(size * (neutral ? 0.37 : 0.375));
  const dot = severity ? SEV_DOT[String(severity).toLowerCase()] : undefined;
  const dotSize = Math.round(size * 0.28);
  const initial = ([...name.trim()][0] ?? '?').toUpperCase();
  const dim = dimColor ?? mix(color, 53);

  const tileStyle: CSSProperties = neutral
    ? {
        background: 'linear-gradient(145deg, var(--bg-elevated), var(--bg-card-deep))',
        border: `1px solid ${dot ? mix(dot, 25) : 'var(--border-base)'}`,
        boxShadow: glow ? `0 0 ${Math.round(size * 0.45)}px ${mix(color, 21)}` : undefined,
      }
    : {
        background: showFavicon
          // Neutral dark interior so coloured logos read cleanly.
          ? 'linear-gradient(145deg, rgba(25,35,55,0.95), rgba(10,15,28,0.98))'
          : `linear-gradient(145deg, ${color}, ${dim})`,
        border: `1px solid ${mix(color, 44)}`,
        boxShadow: [
          `0 ${Math.round(size * 0.1)}px ${Math.round(size * 0.35)}px rgba(0,0,0,0.70)`,
          'inset 0 1px 0 var(--text-muted)',
          'inset 0 -1px 0 rgba(0,0,0,0.45)',
          glow ? `0 0 ${Math.round(size * 0.45)}px ${mix(color, 21)}` : '',
        ].filter(Boolean).join(', '),
      };

  const a11y = label
    ? ({ role: 'img', 'aria-label': severity ? `${label}, ${String(severity).toLowerCase()} severity` : label } as const)
    : ({ 'aria-hidden': true } as const);

  return (
    <div
      {...a11y}
      className={cn('relative flex shrink-0 select-none items-center justify-center', className)}
      style={{ width: size, height: size, borderRadius: r, ...tileStyle, ...style }}
    >
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden"
        style={{ borderRadius: Math.max(0, r - 1) }}
      >
        {showFavicon ? (
          <img
            src={faviconUrl}
            width={Math.round(size * (neutral ? 0.6 : 0.55))}
            height={Math.round(size * (neutral ? 0.6 : 0.55))}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(faviconUrl ?? null)}
            style={{ objectFit: 'contain', display: 'block', borderRadius: neutral ? 3 : undefined }}
          />
        ) : (
          <span
            aria-hidden="true"
            className="font-black"
            style={{
              fontSize: fs,
              lineHeight: 1,
              color: neutral ? 'var(--text-secondary)' : '#fff',
              textShadow: neutral ? undefined : '0 1px 3px rgba(0,0,0,0.65)',
            }}
          >
            {initial}
          </span>
        )}
      </div>
      {dot && (
        <span
          aria-hidden="true"
          className="absolute"
          style={{
            bottom: -2, right: -2, width: dotSize, height: dotSize, borderRadius: '50%',
            background: dot, border: '2px solid var(--bg-page)', boxShadow: `0 0 6px ${dot}`,
          }}
        />
      )}
    </div>
  );
}

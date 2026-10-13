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

import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { cn } from './cn';

export type AvatarSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type AvatarTone = 'brand' | 'neutral' | 'self';
export type AvatarShape = 'default' | 'squircle';

export interface AvatarProps {
  /** Entity name; its first character is the fallback initial. */
  name: string;
  /** Favicon / logo URL. Falls back to the initial if missing or it fails to load. */
  faviconUrl?: string | null;
  /** Gradient start / border / glow colour (any CSS colour). Default `var(--red)`. */
  color?: string;
  /** Gradient end colour. Defaults to a translucent `color`. */
  dimColor?: string;
  /**
   * `brand` (default): coloured gradient tile. `neutral`: quiet tile (list rows).
   * `self`: the signed-in USER's own avatar (ACCOUNT_DESIGN_SPEC §3) — initials
   * only, ink-on-colour (`--text-on-amber`), outer glow. It never renders an
   * image: `faviconUrl` is ignored, so a profile picture can't leak in.
   */
  tone?: AvatarTone;
  /** `squircle` = ~30% corner radius (the account hero tile). Default keeps the per-tone radius. */
  shape?: AvatarShape;
  /**
   * Explicit initials to render instead of the first character of `name`
   * (e.g. `parseInitials(name, email)` -> "CL"). Intended for `tone="self"`.
   */
  initials?: string;
  /** Pixel size. Default 40; up to 72 for the account hero. */
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

// Raw values of the palette vars an Avatar `color` is usually given, so the
// initial's ink can be chosen for contrast against the fill. Mirrors
// theme/tokens.css (accents are theme-invariant). Anything not listed here is
// resolved at runtime from the browser (see `useResolvedRgb`).
const VAR_HEX: Record<string, string> = {
  'var(--amber)': '#E5A832', 'var(--amber-dim)': '#B8821F',
  'var(--red)': '#C83C3C', 'var(--red-dim)': '#8B1A1A',
  'var(--blue)': '#0A8AB5', 'var(--blue-dim)': '#065A78',
  'var(--green)': '#3CB878', 'var(--green-dim)': '#1A6B3C',
  'var(--violet)': '#8B7CF6',
  'var(--orbital-teal)': '#00d4ff', 'var(--thrust)': '#7aeaff',
  'var(--sev-critical)': '#f87171', 'var(--sev-high)': '#fb923c',
  'var(--sev-medium)': '#fbbf24', 'var(--sev-low)': '#60a5fa', 'var(--sev-info)': '#4ade80',
};

type Rgb = [number, number, number];

/** Parses #rgb/#rrggbb, rgb()/rgba() (comma or space syntax) and the `color(srgb r g b)` form browsers resolve color-mix() to. */
function parseRgb(input: string): Rgb | null {
  const raw = (VAR_HEX[input.trim().toLowerCase()] ?? input).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join('') : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(raw);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
    const nums = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
    if (nums.length === 3 && nums.every((n) => Number.isFinite(n))) return nums.map((n) => Math.min(255, Math.max(0, n))) as Rgb;
    return null;
  }
  const srgb = /^color\(srgb\s+([^)]+)\)$/i.exec(raw);
  if (srgb) {
    const nums = srgb[1]!.split(/[\s/]+/).filter(Boolean).slice(0, 3).map(parseFloat);
    if (nums.length === 3 && nums.every((n) => Number.isFinite(n))) return nums.map((n) => Math.min(255, Math.max(0, n * 255))) as Rgb;
  }
  return null;
}

function luminanceOf([r8, g8, b8]: Rgb): number {
  const [r, g, b] = [r8, g8, b8].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark ink beats white once the fill is lighter than the contrast crossover. */
const INK_DARK = '#0A0F1E';
const INK_DARK_L = luminanceOf(parseRgb(INK_DARK)!); // ~0.005
function lightFill(rgb: Rgb | null): boolean {
  if (!rgb) return false;
  const L = luminanceOf(rgb);
  return (L + 0.05) / (INK_DARK_L + 0.05) > 1.05 / (L + 0.05);
}

/**
 * Colour -> rgb. Known hex / rgb() / palette-var strings resolve synchronously;
 * anything else (named colours, other vars, color-mix(), ...) is resolved from
 * the browser by painting a probe inside the tile before first paint. Never
 * throws: an unresolvable colour keeps the white-ink default.
 */
function useResolvedRgb(color: string, tileRef: RefObject<HTMLElement>, enabled: boolean): Rgb | null {
  const known = parseRgb(color);
  const [resolved, setResolved] = useState<{ color: string; rgb: Rgb | null } | null>(null);
  useLayoutEffect(() => {
    if (!enabled || known || typeof document === 'undefined') return;
    const tile = tileRef.current;
    if (!tile) return;
    try {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;color:${color}`;
      tile.appendChild(probe);
      const out = getComputedStyle(probe).color;
      tile.removeChild(probe);
      setResolved({ color, rgb: parseRgb(out) });
    } catch {
      setResolved({ color, rgb: null });
    }
  }, [color, enabled, known, tileRef]);
  if (known) return known;
  return resolved && resolved.color === color ? resolved.rgb : null;
}

/** `color` at `pct`% opacity; works for hex and var() colours alike. */
const mix = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export function Avatar({
  name,
  faviconUrl,
  color: colorProp,
  dimColor,
  tone = 'brand',
  shape = 'default',
  initials,
  size = 40,
  radius,
  fontSize,
  severity,
  glow: glowProp,
  label,
  className,
  style,
}: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const self = tone === 'self';
  // Self avatars default to the static amber (SELF_AVATAR_COLOR); entities to red.
  const color = colorProp ?? (self ? 'var(--amber)' : 'var(--red)');
  // Self avatars are initials-only by contract: never render an image.
  const showFavicon = !self && !!faviconUrl && failedUrl !== faviconUrl;
  const neutral = tone === 'neutral';
  const glow = glowProp ?? self;

  const r = radius ?? (shape === 'squircle' ? Math.round(size * 0.3) : neutral ? Math.round(size * 0.26) : 12);
  const rawText = (initials ?? '').trim();
  const text = self ? [...rawText].slice(0, 2).join('') : rawText;
  const initialCount = [...text].length;
  // 11px floor: small avatars used to render 8-9px initials.
  const fs = Math.max(11, fontSize ?? Math.round(size * (neutral ? 0.37 : self && initialCount > 1 ? 0.36 : 0.375)));
  const tileRef = useRef<HTMLDivElement>(null);
  const inkMatters = !self && !neutral;
  const fillRgb = useResolvedRgb(color, tileRef, inkMatters);
  const darkInk = inkMatters && lightFill(fillRgb);
  const dot = severity ? SEV_DOT[String(severity).toLowerCase()] : undefined;
  const dotSize = Math.round(size * 0.28);
  const initial = (text || ([...name.trim()][0] ?? '?')).toUpperCase();
  const dim = dimColor ?? (self ? `color-mix(in srgb, ${color} var(--avatar-self-dim-pct, 50%), black)` : darkInk ? `color-mix(in srgb, ${color} 80%, white)` : neutral ? mix(color, 53) : `color-mix(in srgb, ${color} 70%, black)`);

  const tileStyle: CSSProperties = self
    ? {
        // DimensionalAvatar recipe (spec §3): gradient, 1px tinted border, top/bottom rims, outer glow.
        background: `linear-gradient(145deg, ${color}, ${dim})`,
        border: `1px solid ${mix(color, 44)}`,
        boxShadow: [
          'inset 0 1px 0 rgba(255, 255, 255, 0.28)',
          'inset 0 -1px 0 rgba(0, 0, 0, 0.45)',
          glow ? `0 0 ${Math.round(size * 0.45)}px ${mix(color, 21)}` : '',
        ].filter(Boolean).join(', '),
      }
    : neutral
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
      ref={tileRef}
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
              color: self ? 'var(--text-on-amber)' : neutral ? 'var(--text-secondary)' : darkInk ? INK_DARK : '#fff',
              fontWeight: self ? 800 : undefined,
              textShadow: neutral || self || darkInk ? undefined : '0 1px 3px rgba(0,0,0,0.65)',
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

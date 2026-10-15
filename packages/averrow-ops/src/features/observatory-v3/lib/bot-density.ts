/**
 * Pure helpers for the Observatory "Bot density" map mode.
 * Kept free of React / deck.gl so they can be unit-tested directly.
 */

import type { BotTrafficDensity } from '@/hooks/useBotTraffic';
import { getCountryCentroid, type LngLat } from '@/lib/country-centroids';

export type Rgba = [number, number, number, number];

export interface BotDensityPoint extends BotTrafficDensity {
  position: LngLat;
}

export interface BotDensityDomain {
  minBot: number;
  maxBot: number;
  maxTraffic: number;
}

/**
 * Fallbacks match the theme tokens (--sev-low, --amber, --sev-critical).
 * The high stop is the lighter --sev-critical so lightness rises with value.
 */
const FALLBACK_STOPS: [Rgba, Rgba, Rgba] = [
  [96, 165, 250, 230],
  [229, 168, 50, 230],
  [248, 113, 113, 240],
];

const STOP_VARS = ['--sev-low', '--amber', '--sev-critical'] as const;

/**
 * Ring stroke for above-average countries. Fixed light: the basemap is always
 * dark-matter regardless of UI theme, so a theme text colour (near-black in
 * light theme) would vanish against it.
 */
export const RING_COLOR: Rgba = [255, 255, 255, 235];

/** Subtle outline for countries at or below the global average (basemap is always dark). */
export const OUTLINE_COLOR: Rgba = [255, 255, 255, 40];

/** Parse #rgb / #rrggbb / rgb()/rgba() into an RGB triple, or null. */
export function parseCssColor(input: string): [number, number, number] | null {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split('').map(c => c + c).join('') : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/**
 * Resolve the sequential-scale stops from CSS vars at runtime. The result is
 * theme-invariant because the stop tokens (--sev-low, --amber, --sev-critical)
 * have the same value in light and dark themes, so no theme dependency is needed.
 */
export function resolveScaleStops(): [Rgba, Rgba, Rgba] {
  if (typeof document === 'undefined') return FALLBACK_STOPS;
  const style = getComputedStyle(document.documentElement);
  return STOP_VARS.map((v, i) => {
    const parsed = parseCssColor(style.getPropertyValue(v));
    const fb = FALLBACK_STOPS[i]!;
    return parsed ? [parsed[0], parsed[1], parsed[2], fb[3]] : fb;
  }) as [Rgba, Rgba, Rgba];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sequential scale: low -> mid -> high across [minBot, maxBot]. */
export function botColor(
  botPct: number,
  minBot: number,
  maxBot: number,
  stops: readonly [Rgba, Rgba, Rgba] = FALLBACK_STOPS,
): Rgba {
  const span = maxBot - minBot;
  const t = span > 0 ? Math.min(1, Math.max(0, (botPct - minBot) / span)) : 0.5;
  const [lo, mid, hi] = stops;
  const [from, to, u] = t < 0.5 ? [lo, mid, t * 2] : [mid, hi, (t - 0.5) * 2];
  return [
    Math.round(lerp(from[0], to[0], u)),
    Math.round(lerp(from[1], to[1], u)),
    Math.round(lerp(from[2], to[2], u)),
    Math.round(lerp(from[3], to[3], u)),
  ];
}

/** Radius in pixels, proportional to sqrt(traffic share) so area ~ traffic. */
export function botRadius(trafficPct: number, maxTraffic: number, minPx = 5, maxPx = 30): number {
  if (!(maxTraffic > 0) || !(trafficPct > 0)) return minPx;
  const t = Math.min(1, Math.sqrt(trafficPct / maxTraffic));
  return minPx + (maxPx - minPx) * t;
}

/** Join density rows to centroids; countries without one are skipped. */
export function buildBotDensityPoints(rows: readonly BotTrafficDensity[] | null | undefined): BotDensityPoint[] {
  if (!rows) return [];
  const out: BotDensityPoint[] = [];
  for (const r of rows) {
    const position = getCountryCentroid(r.code);
    if (!position || !Number.isFinite(r.bot_pct)) continue;
    out.push({ ...r, position });
  }
  return out;
}

export function botDensityDomain(points: readonly BotDensityPoint[]): BotDensityDomain {
  if (points.length === 0) return { minBot: 0, maxBot: 100, maxTraffic: 0 };
  let minBot = Infinity;
  let maxBot = -Infinity;
  let maxTraffic = 0;
  for (const p of points) {
    minBot = Math.min(minBot, p.bot_pct);
    maxBot = Math.max(maxBot, p.bot_pct);
    maxTraffic = Math.max(maxTraffic, p.traffic_pct);
  }
  return { minBot, maxBot, maxTraffic };
}

export function formatPct(n: number): string {
  if (n > 0 && n < 0.1) return '<0.1%';
  return `${n.toFixed(1)}%`;
}

/** Formats a bot share, prefixing estimate bounds: `≥ 12.0%` (floor) / `≤ 12.0%` (ceiling). */
export function formatBotShare(pct: number, bound?: BotTrafficDensity['bound']): string {
  const prefix = bound === 'lower' ? '≥ ' : bound === 'upper' ? '≤ ' : '';
  return `${prefix}${formatPct(pct)}`;
}

/** Average used for above-average marking: the density-specific global figure, else the latest snapshot. */
export function resolveGlobalAvg(
  data: { bot_density_global_pct?: number | null; latest?: { bot_pct: number } | null } | null | undefined,
): number | null {
  const v = data?.bot_density_global_pct;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const l = data?.latest?.bot_pct;
  return typeof l === 'number' && Number.isFinite(l) ? l : null;
}

export function botDensityTooltip(d: BotTrafficDensity, globalAvg: number | null | undefined): string {
  const parts = [
    `${d.name} (${d.code}) — Bot share ${formatBotShare(d.bot_pct, d.bound)} of its traffic`,
    `${formatPct(d.traffic_pct)} of global traffic`,
  ];
  if (typeof globalAvg === 'number' && Number.isFinite(globalAvg)) {
    parts.push(`global avg ${formatPct(globalAvg)}`);
  }
  return parts.join(' · ');
}

/**
 * True only when a country's bot share is provably strictly above the global
 * average. A `lower` bound is a floor, so a floor above the average proves the
 * true value is too. An `upper` bound is a ceiling: a ceiling above the
 * average proves nothing, so upper-bounded rows are never marked.
 */
export function isAboveAverage(
  botPct: number,
  globalAvg: number | null | undefined,
  bound?: BotTrafficDensity['bound'],
): boolean {
  if (bound === 'upper') return false;
  return typeof globalAvg === 'number' && Number.isFinite(globalAvg) && botPct > globalAvg;
}

/**
 * The wall screen's tiles for the bot-share scene: the global share, how many countries are painted and the most
 * automated one. Always the same three tiles, so the layout does not jump as the data arrives. `value: null` means still
 * loading; once `loaded`, a figure the data does not have reads "N/A" (a loaded-empty scene is not a busy one).
 */
export function botWallTiles(
  points: readonly BotDensityPoint[],
  globalAvg: number | null | undefined,
  loaded: boolean = points.length > 0,
): Array<{ label: string; value: number | string | null; sub?: string }> {
  const hasAvg = typeof globalAvg === 'number' && Number.isFinite(globalAvg);
  const unknown = loaded ? 'N/A' : null;
  let top: BotDensityPoint | null = null;
  for (const p of points) if (!top || p.bot_pct > top.bot_pct) top = p;
  return [
    { label: 'Global bot share', value: hasAvg ? formatPct(globalAvg) : unknown },
    { label: 'Countries', value: loaded ? points.length : null },
    top
      ? { label: 'Most automated', value: formatBotShare(top.bot_pct, top.bound), sub: `${top.name} (${top.code})` }
      : { label: 'Most automated', value: unknown },
  ];
}

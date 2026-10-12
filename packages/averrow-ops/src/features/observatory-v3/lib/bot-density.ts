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

/** Fallbacks match the theme tokens (--sev-low, --amber, --red). */
const FALLBACK_STOPS: [Rgba, Rgba, Rgba] = [
  [96, 165, 250, 230],
  [229, 168, 50, 230],
  [200, 60, 60, 240],
];

const STOP_VARS = ['--sev-low', '--amber', '--red'] as const;

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

/** Resolve the sequential-scale stops from theme CSS vars at runtime. */
export function resolveScaleStops(): [Rgba, Rgba, Rgba] {
  if (typeof document === 'undefined') return FALLBACK_STOPS;
  const style = getComputedStyle(document.documentElement);
  return STOP_VARS.map((v, i) => {
    const parsed = parseCssColor(style.getPropertyValue(v));
    const fb = FALLBACK_STOPS[i]!;
    return parsed ? [parsed[0], parsed[1], parsed[2], fb[3]] : fb;
  }) as [Rgba, Rgba, Rgba];
}

/** Stroke colour for above-average countries (theme text colour, light/dark safe). */
export function resolveRingColor(): Rgba {
  if (typeof document === 'undefined') return [255, 255, 255, 235];
  const parsed = parseCssColor(getComputedStyle(document.documentElement).getPropertyValue('--text-primary'));
  return parsed ? [parsed[0], parsed[1], parsed[2], 235] : [255, 255, 255, 235];
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

export function botDensityTooltip(d: BotTrafficDensity, globalAvg: number | null | undefined): string {
  const parts = [
    `${d.name} (${d.code}) — Bot share ${formatPct(d.bot_pct)} of its traffic`,
    `${formatPct(d.traffic_pct)} of global traffic`,
  ];
  if (typeof globalAvg === 'number' && Number.isFinite(globalAvg)) {
    parts.push(`global avg ${formatPct(globalAvg)}`);
  }
  return parts.join(' · ');
}

export function isAboveAverage(botPct: number, globalAvg: number | null | undefined): boolean {
  return typeof globalAvg === 'number' && Number.isFinite(globalAvg) && botPct > globalAvg;
}

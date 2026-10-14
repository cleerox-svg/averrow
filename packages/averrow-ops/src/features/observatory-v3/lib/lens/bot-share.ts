/**
 * Baseline lens, "Bot share" measure: Cloudflare Radar's bot share of each
 * country's traffic as a choropleth. Same scale, domain and wording as the old
 * bot-density circles (lib/bot-density.ts), now painted on the country shapes
 * so the three Baseline measures read as one family.
 */

import { botColor, botDensityDomain, botDensityTooltip, isAboveAverage, type BotDensityDomain, type BotDensityPoint, type Rgba } from '../bot-density';

export interface BotShareModel {
  rows: Map<string, BotDensityPoint>;
  /** Per-country fill. */
  colors: Map<string, Rgba>;
  /** Countries provably above the global average (they get a bright outline). */
  above: Set<string>;
  domain: BotDensityDomain;
  globalAvg: number | null;
  asOf: string | null;
}

export const BOT_FILL_ALPHA = 190;

export function buildBotShareModel(
  points: readonly BotDensityPoint[],
  stops: readonly [Rgba, Rgba, Rgba],
  globalAvg: number | null,
  asOf: string | null,
): BotShareModel {
  const domain = botDensityDomain(points);
  const rows = new Map<string, BotDensityPoint>();
  const colors = new Map<string, Rgba>();
  const above = new Set<string>();
  for (const p of points) {
    rows.set(p.code, p);
    const c = botColor(p.bot_pct, domain.minBot, domain.maxBot, stops);
    colors.set(p.code, [c[0], c[1], c[2], BOT_FILL_ALPHA]);
    if (isAboveAverage(p.bot_pct, globalAvg, p.bound)) above.add(p.code);
  }
  return { rows, colors, above, domain, globalAvg, asOf };
}

export interface BotHover { title: string; lines: string[] }

/** Tooltip for a country (the sentence the old circles used, split into title + lines). */
export function botHover(row: BotDensityPoint, globalAvg: number | null): BotHover {
  const [, ...rest] = botDensityTooltip(row, globalAvg).split(' — ');
  return { title: `${row.name} (${row.code})`, lines: rest.join(' — ').split(' · ') };
}


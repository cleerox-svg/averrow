/**
 * Baseline lens: Radar over-index choropleth.
 *
 * ratio = our share of threats ÷ Radar's share of attack origin. 1 means we see
 * a country exactly as much as general attack traffic would predict; above 1 is
 * where phishing operators concentrate beyond normal traffic. The scale is
 * diverging on log2(ratio) (0.25× … 4×), neutral at 1, and countries outside
 * Radar's top list have no baseline: they are grey, never "zero".
 */

import type { OverindexRow } from '@/hooks/useObservatoryLenses';
import type { Rgba } from '../map-colors';

export const RATIO_MIN = 0.25;
export const RATIO_MAX = 4;

/**
 * Diverging stops over t in [0, 1]; t = 0.5 is ratio 1. The neutral stop is a
 * visible slate (not a navy that disappears into the dark basemap): "normal"
 * must look like something, with blue and red departing from it.
 */
export const OVERINDEX_STOPS: ReadonlyArray<{ t: number; color: Rgba }> = [
  { t: 0, color: [43, 108, 176, 215] },
  { t: 0.5, color: [100, 116, 139, 150] },
  { t: 0.75, color: [194, 65, 12, 215] },
  { t: 1, color: [248, 113, 113, 235] },
];

/** Outside Radar's top list: a barely-there fill; the shape is drawn as an outline instead (see NO_BASELINE_OUTLINE). */
export const NO_BASELINE_COLOR: Rgba = [96, 104, 120, 36];
export const NO_BASELINE_OUTLINE: Rgba = [148, 163, 184, 175];
export const NO_DATA_COLOR: Rgba = [0, 0, 0, 0];

/** ratio -> t in [0, 1] on log2, clamped to RATIO_MIN … RATIO_MAX. */
export function ratioToT(ratio: number): number {
  const r = Math.min(RATIO_MAX, Math.max(RATIO_MIN, ratio));
  return 0.5 + Math.log2(r) / (2 * Math.log2(RATIO_MAX));
}

export function lerpStops(stops: ReadonlyArray<{ t: number; color: Rgba }>, t: number): Rgba {
  const c = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!;
    const b = stops[i]!;
    if (c <= b.t) {
      const f = b.t === a.t ? 0 : (c - a.t) / (b.t - a.t);
      return [
        Math.round(a.color[0] + (b.color[0] - a.color[0]) * f),
        Math.round(a.color[1] + (b.color[1] - a.color[1]) * f),
        Math.round(a.color[2] + (b.color[2] - a.color[2]) * f),
        Math.round(a.color[3] + (b.color[3] - a.color[3]) * f),
      ];
    }
  }
  return [...stops[stops.length - 1]!.color] as Rgba;
}

export function overindexColor(ratio: number | null): Rgba {
  if (ratio === null || !Number.isFinite(ratio)) return NO_BASELINE_COLOR;
  return lerpStops(OVERINDEX_STOPS, ratioToT(ratio));
}

const RAW_STOPS: ReadonlyArray<{ t: number; color: Rgba }> = [
  { t: 0, color: [38, 52, 84, 150] },
  { t: 0.5, color: [229, 168, 50, 190] },
  { t: 1, color: [248, 113, 113, 235] },
];

/** Raw volume on a √ scale (so mid-sized countries aren't flattened by the US). */
export function rawColor(count: number, max: number): Rgba {
  if (!(count > 0) || !(max > 0)) return NO_DATA_COLOR;
  return lerpStops(RAW_STOPS, Math.sqrt(count / max));
}

export interface BaselineModel {
  rows: Map<string, OverindexRow>;
  maxCount: number;
  withBaseline: number;
  withoutBaseline: number;
  /** Per-country fill for each measure, precomputed once so the layer accessor is a Map lookup. */
  indexColors: Map<string, Rgba>;
  rawColors: Map<string, Rgba>;
}

export function buildBaselineModel(rows: readonly OverindexRow[]): BaselineModel {
  const byCc = new Map<string, OverindexRow>();
  let maxCount = 0;
  for (const r of rows) {
    byCc.set(r.country_code, r);
    if (r.our_count > maxCount) maxCount = r.our_count;
  }
  const indexColors = new Map<string, Rgba>();
  const rawColors = new Map<string, Rgba>();
  let withBaseline = 0;
  let withoutBaseline = 0;
  for (const [cc, r] of byCc) {
    indexColors.set(cc, overindexColor(r.ratio));
    rawColors.set(cc, rawColor(r.our_count, maxCount));
    if (r.ratio === null) withoutBaseline++; else withBaseline++;
  }
  return { rows: byCc, maxCount, withBaseline, withoutBaseline, indexColors, rawColors };
}

/** Human label for a ratio, e.g. "2.4× Radar". */
export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'no Radar baseline';
  if (ratio >= 10) return `${Math.round(ratio)}× Radar`;
  return `${ratio.toFixed(ratio < 1 ? 2 : 1)}× Radar`;
}

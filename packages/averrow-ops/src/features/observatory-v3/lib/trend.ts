/**
 * "vs prior period" for the drill drawer. The figure comes from `GET /api/observatory/timeline?country=XX&period=…`
 * (`data.trend`, see `useDrillTrend`); the drawer renders it when present and nothing at all when it is absent.
 */

export interface DrillTrend {
  current: number;
  prior: number;
  /** `(current - prior) / prior * 100`; null when `prior` is 0. */
  delta_pct: number | null;
}

export type TrendDirection = 'up' | 'down' | 'flat' | 'new';
export interface TrendView {
  direction: TrendDirection;
  /** "▲ 12%", "▼ 8%", "no change" or "new". */
  text: string;
  /** Spoken form. */
  label: string;
}

/**
 * What to show for a trend: ▲ / ▼ with the percentage, "no change", or "new" when there was nothing before (`delta_pct`
 * is null) and there is something now. Null (render nothing) for a missing trend or one with no activity in either window.
 */
export function trendView(t: DrillTrend | null | undefined): TrendView | null {
  if (!t || !Number.isFinite(t.current) || !Number.isFinite(t.prior)) return null;
  if (t.delta_pct === null || !Number.isFinite(t.delta_pct)) {
    return t.current > 0 ? { direction: 'new', text: 'new', label: 'new compared with the prior period' } : null;
  }
  const rounded = Math.round(Math.abs(t.delta_pct) * 10) / 10;
  if (rounded === 0) return { direction: 'flat', text: 'no change', label: 'no change compared with the prior period' };
  const up = t.delta_pct > 0;
  return {
    direction: up ? 'up' : 'down',
    text: `${up ? '▲' : '▼'} ${rounded}%`,
    label: `${up ? 'up' : 'down'} ${rounded} percent compared with the prior period`,
  };
}

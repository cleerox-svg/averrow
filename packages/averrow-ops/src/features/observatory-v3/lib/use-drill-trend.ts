/**
 * The drill drawer's "vs prior period" data hook. Only a COUNTRY target has one: `GET /api/observatory/timeline?country=XX
 * &period=<period>` answers `data.trend = { current, prior, delta_pct, … }` (the active filters apply too). Cached under the
 * same key as the replay histogram's country series, so selecting a country the replay bar already follows costs no request.
 * Returns undefined while loading, on error, for any other kind of target, or when the payload has no `trend`.
 */

import { useObservatoryTimeline } from '@/hooks/useObservatoryLenses';
import type { ObservatoryFilters } from '@/hooks/useObservatory';
import type { DrillTarget } from './drill';
import type { DrillTrend } from './trend';

export function useDrillTrend(
  target: DrillTarget | null,
  opts: { period: string; source: string; filters?: ObservatoryFilters; enabled?: boolean },
): DrillTrend | undefined {
  const country = target?.kind === 'country' ? target.code : null;
  const q = useObservatoryTimeline({
    enabled: (opts.enabled ?? true) && country !== null,
    period: opts.period, source: opts.source, country, filters: opts.filters,
  });
  const t = country !== null ? q.data?.data.trend : undefined;
  return t ? { current: t.current, prior: t.prior, delta_pct: t.delta_pct } : undefined;
}

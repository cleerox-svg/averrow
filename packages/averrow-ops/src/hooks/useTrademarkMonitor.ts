import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface TrademarkOverviewRow {
  id:                     string;
  brand_name:             string;
  domain:                 string | null;
  assets_active:          number;
  findings_total:         number;
  findings_confirmed:     number;
  findings_likely:        number;
  findings_unknown:       number;
  findings_high_critical: number;
}

export interface TrademarkOverviewTotals {
  brands:    number;
  assets:    number;
  findings:  number;
  confirmed: number;
  likely:    number;
}

export function useTrademarkOverview(params: { limit?: number; offset?: number } = {}) {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();

  return useQuery({
    queryKey: ['trademark-overview', params],
    queryFn: async () => {
      const res = await api.get<TrademarkOverviewRow[]>(
        `/api/trademarks/overview${query ? `?${query}` : ''}`,
      );
      const extras = res as unknown as { totals?: TrademarkOverviewTotals };
      return {
        data: (res.data ?? []) as TrademarkOverviewRow[],
        total: res.total ?? 0,
        totals: extras.totals ?? {
          brands: 0, assets: 0, findings: 0, confirmed: 0, likely: 0,
        },
      };
    },
    placeholderData: keepPreviousData,
  });
}

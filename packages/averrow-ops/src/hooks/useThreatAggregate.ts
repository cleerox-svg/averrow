// Threats catalog aggregate hook — slice-aware narrative numbers.
// Backed by /api/threats/aggregate from PR16. 5min staleTime
// matches the server-side cachedValue TTL.

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface ThreatAggregateFilters {
  severity?:  string;
  type?:      string;
  status?:    string;
  source?:    string;
  search?:    string;
  brand_id?:  string;
  actor_id?:  string;
  country?:   string;
  since?:     string;
}

export interface ThreatAggregateMover {
  kind:        'type' | 'campaign';
  id?:         string;
  label:       string;
  current_7d:  number;
  previous_7d: number;
  delta_pct:   number;
}

export interface ThreatAggregate {
  total:            number;
  confirmed:        number;
  correlated:       number;
  attributed:       number;
  unattributed:     number;
  active:           number;
  addressed:        number;
  remediation_rate: number;
  new_24h:          number;
  by_severity: Array<{ severity: string; count: number }>;
  by_type:     Array<{ type: string; count: number }>;
  by_status:   Array<{ status: string; count: number }>;
  multi_brand_campaigns: Array<{ id: string; name: string; brand_count: number; threat_count: number; status: string }>;
  multi_brand_actors:    Array<{ id: string; name: string; brand_count: number; threat_count: number }>;
  multi_brand_providers: Array<{ id: string; name: string; asn: string | null; brand_count: number; threat_count: number }>;
  surging_signals: ThreatAggregateMover[];
  top_countries: Array<{ country: string; count: number }>;
  top_brands:    Array<{ brand_id: string; brand_name: string; canonical_domain: string; logo_url: string | null; count: number }>;
  top_providers: Array<{ provider_id: string; name: string; asn: string | null; count: number }>;
  top_actors:    Array<{ actor_id: string; actor_name: string; count: number }>;
  top_campaigns: Array<{ campaign_id: string; name: string; threat_count: number; brand_count: number; status: string }>;
}

function toQuery(filters: ThreatAggregateFilters): string {
  const params = new URLSearchParams();
  if (filters.severity)  params.set('severity', filters.severity);
  if (filters.type)      params.set('type',     filters.type);
  if (filters.status)    params.set('status',   filters.status);
  if (filters.source)    params.set('source',   filters.source);
  if (filters.search)    params.set('q',        filters.search);
  if (filters.brand_id)  params.set('brand_id', filters.brand_id);
  if (filters.actor_id)  params.set('actor_id', filters.actor_id);
  if (filters.country)   params.set('country',  filters.country);
  if (filters.since)     params.set('since',    filters.since);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useThreatAggregate(filters: ThreatAggregateFilters) {
  return useQuery({
    queryKey: ['threats', 'aggregate', filters],
    queryFn: async () => {
      const res = await api.get<ThreatAggregate>(`/api/threats/aggregate${toQuery(filters)}`);
      return (res.data ?? null) as ThreatAggregate | null;
    },
    staleTime: 5 * 60_000,
  });
}

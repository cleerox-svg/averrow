// Threat-Actor Intelligence API client.
//
// Backed by:
//   GET /api/orgs/:orgId/modules/threat-actor
//   GET /api/orgs/:orgId/modules/threat-actor/actors/:actorId

import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import { useAuth } from './auth';

export interface ThreatActorSummary {
  actor_id:                string;
  name:                    string;
  aliases:                 string | null;
  affiliation:             string | null;
  country_code:            string | null;
  capability:              string | null;
  status:                  string;
  attribution_confidence:  string;
  threat_count_for_org:    number;
  brands_targeted_for_org: number;
  last_seen_for_org:       string | null;
}

export interface ThreatActorTotals {
  actor_count:            number;
  threat_count:           number;
  countries_count:        number;
  high_confidence_actors: number;
}

export interface ThreatActorModuleSummary {
  org_id: number;
  actors: ThreatActorSummary[];
  totals: ThreatActorTotals;
}

export interface ThreatActorProfile {
  id:                     string;
  name:                   string;
  aliases:                string | null;
  affiliation:            string | null;
  country_code:           string | null;
  capability:             string | null;
  primary_ttps:           string | null;
  description:            string | null;
  first_seen:             string | null;
  last_seen:              string | null;
  status:                 string;
  attribution_confidence: string;
}

export interface OrgThreatRow {
  id:                     string;
  threat_type:            string;
  malicious_url:          string | null;
  malicious_domain:       string | null;
  target_brand_id:        string | null;
  brand_name:             string | null;
  country_code:           string | null;
  severity:               string | null;
  status:                 string;
  first_seen:             string;
  last_seen:              string;
  attribution_confidence: string;
  attribution_source:     string;
  observed_at:            string;
}

export interface ActorInfrastructureRow {
  id:               string;
  asn:              string | null;
  ip_range:         string | null;
  domain:           string | null;
  hosting_provider: string | null;
  country_code:     string | null;
  confidence:       string;
  first_observed:   string;
  last_observed:    string;
}

export interface OrgTargetedBrand {
  brand_id:         string;
  brand_name:       string;
  canonical_domain: string | null;
  first_targeted:   string;
  last_targeted:    string;
}

export interface ThreatActorDetail {
  actor:            ThreatActorProfile;
  org_id:           number;
  targeted_brands:  OrgTargetedBrand[];
  threats:          OrgThreatRow[];
  infrastructure:   ActorInfrastructureRow[];
  page_size:        number;
}

export function useThreatActorModuleSummary() {
  const { user, hasOrg } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<ThreatActorModuleSummary>({
    queryKey: ['threat-actor-module', orgId],
    queryFn: async () => {
      const res = await apiGet<ThreatActorModuleSummary>(`/api/orgs/${orgId}/modules/threat-actor`);
      return res.data;
    },
    enabled: hasOrg && !!orgId,
    staleTime: 30_000,
  });
}

export function useThreatActorDetail(actorId: string | null) {
  const { user } = useAuth();
  const orgId = user?.organization?.id ?? null;
  return useQuery<ThreatActorDetail>({
    queryKey: ['threat-actor-detail', orgId, actorId],
    queryFn: async () => {
      const res = await apiGet<ThreatActorDetail>(
        `/api/orgs/${orgId}/modules/threat-actor/actors/${actorId}`,
      );
      return res.data;
    },
    enabled: !!orgId && !!actorId,
    staleTime: 30_000,
  });
}

export const CAPABILITY_LABELS: Record<string, string> = {
  destructive:    'Destructive',
  espionage:      'Espionage',
  infrastructure: 'Infrastructure',
  influence_ops:  'Influence ops',
  financial:      'Financial',
};

export const STATUS_LABELS: Record<string, string> = {
  active:    'Active',
  dormant:   'Dormant',
  disrupted: 'Disrupted',
  unknown:   'Unknown',
};

export function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function parseTtps(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

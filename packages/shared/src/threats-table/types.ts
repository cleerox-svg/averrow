// Shared advanced Threats table — types.
//
// One module, two consumers: the staff ops SPA (all brands, full
// enrichment firehose) and the customer tenant app (their brands, a
// curated column set). Same component + state model; only the data and
// the chosen columns differ.

import type { ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';

/** A threat row. Core fields are always present; enrichment/evidence
 *  fields are optional (ops returns more than tenant). */
export interface ThreatRow {
  id:                string;
  threat_type:       string;
  malicious_domain:  string | null;
  malicious_url:     string | null;
  ip_address:        string | null;
  target_brand_id:   string | null;
  brand_name?:       string | null;
  source_feed:       string | null;
  severity:          string | null;
  status:            string | null;
  confidence_score?: number | null;
  country_code?:     string | null;
  first_seen?:       string | null;
  last_seen?:        string | null;
  created_at?:       string | null;

  // Infrastructure
  asn?:               string | null;
  hosting_provider?:  string | null;
  registrar?:         string | null;
  registration_date?: string | null;

  // Correlation
  campaign_id?:        string | null;
  cluster_id?:         string | null;
  actor_id?:           string | null;
  actor_name?:         string | null;
  saas_technique_id?:  string | null;
  saas_technique_name?: string | null;

  // Multi-vendor evidence
  vt_checked?:        number | null;
  vt_malicious?:      number | null;
  vt_reputation?:     number | null;
  gsb_checked?:       number | null;
  gsb_flagged?:       number | null;
  gsb_threat_type?:   string | null;
  surbl_checked?:     number | null;
  surbl_listed?:      number | null;
  greynoise_checked?: number | null;
  greynoise_classification?: string | null;
  seclookup_checked?: number | null;
  seclookup_risk_score?: number | null;
  abuseipdb_checked?: number | null;
  abuseipdb_score?:   number | null;
  abuseipdb_reports?: number | null;
  ai_classification?: string | null;

  [key: string]: unknown;
}

/** Built-in column identifiers. Each app passes the subset it wants. */
export type ThreatColumnKey =
  | 'brand' | 'type' | 'target' | 'ip' | 'severity' | 'status'
  | 'source' | 'country' | 'asn' | 'hosting' | 'actor' | 'technique'
  | 'evidence' | 'confidence' | 'first_seen' | 'last_seen';

export interface ThreatsTableState {
  q:        string;
  severity: string;   // '' = all
  type:     string;
  status:   string;
  brandId:  string;
  country:  string;
  sort:     string;   // server sort column key (maps to a DB column)
  dir:      SortDir;
  page:     number;   // 0-based
}

export interface ThreatsQueryParams extends ThreatsTableState {
  limit:  number;
  offset: number;
}

export type FilterControl = 'search' | 'severity' | 'type' | 'status' | 'brand' | 'country';

export interface SelectOption { value: string; label: string }

export interface ThreatsTableProps {
  columns:       ThreatColumnKey[];
  rows:          ThreatRow[];
  total:         number;
  loading:       boolean;
  error?:        string | null;
  state:         ThreatsTableState;
  pageSize:      number;
  onFilter:      (patch: Partial<ThreatsTableState>) => void;
  onSearch:      (q: string) => void;
  onToggleSort:  (key: string) => void;
  onPage:        (page: number) => void;
  controls?:     FilterControl[];
  brands?:       SelectOption[];
  countries?:    SelectOption[];
  /** Map a column key to its server-sort column. Columns absent here are
   *  rendered but not sortable. */
  sortKeys?:     Partial<Record<ThreatColumnKey, string>>;
  /** Optional extra detail content appended to the expanded evidence panel. */
  renderExtraDetail?: (row: ThreatRow) => ReactNode;
  emptyText?:    string;
}

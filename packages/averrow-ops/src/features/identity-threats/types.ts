// Response contract for GET /api/intel/identity-threats?window=7d|30d
// (IDP impersonation plan, T9).

export type IdentityWindow = '7d' | '30d';
export type IdentityVector = 'idp_tenant' | 'idp_lookalike' | 'device_code';
export type IdentityProviderId =
  | 'okta' | 'entra' | 'onelogin' | 'auth0' | 'ping' | 'duo' | 'google' | 'generic_sso';

export interface IdentityKpis {
  detections: number;
  detections_prev: number;
  brands_targeted: number;
  idps_impersonated: number;
  live: number;
  taken_down: number;
  lookalikes_flagged: number;
}

export interface IdentityTrendPoint { day: string; count: number }

export interface IdentityVectorRow {
  vector: IdentityVector;
  label: string;
  count: number;
  prev: number;
}

export interface IdentityIdpRow {
  idp: IdentityProviderId;
  label: string;
  count: number;
  brands: number;
  prev: number;
}

export interface IdentityTopBrand {
  brand_id: string;
  brand_name: string;
  count: number;
  idps: string[];
}

export interface IdentityRecentRow {
  threat_id: string;
  domain: string;
  brand_id: string | null;
  brand_name: string | null;
  idp: string | null;
  vector: string;
  status: string;
  created_at: string;
}

export interface IdentityMitreRow {
  id: string;
  name: string;
  tactic: string;
  vectors: string[];
  count: number;
}

export interface IdentityThreatsData {
  window: IdentityWindow;
  generated_at: string;
  kpis: IdentityKpis;
  trend: IdentityTrendPoint[];
  by_vector: IdentityVectorRow[];
  by_idp: IdentityIdpRow[];
  top_brands: IdentityTopBrand[];
  recent: IdentityRecentRow[];
  mitre: IdentityMitreRow[];
}

// ── Drill-down contract (IdP detections list + detail) ─────────────────────
// GET /api/intel/identity-threats/detections
// GET /api/intel/identity-threats/detections/:threatId

export interface IdentityDetectionListItem {
  threat_id: string;
  domain: string;
  url: string | null;
  brand_id: string | null;
  brand_name: string | null;
  idp: string | null;          // provider id
  idp_label: string | null;    // e.g. "Okta"
  vector: 'idp_tenant' | 'idp_lookalike' | 'device_code';
  vector_label: string;
  status: string;
  severity: string | null;
  source_feed: string | null;
  created_at: string;          // ISO UTC
}

export interface IdentityDetectionList {
  items: IdentityDetectionListItem[];
  next_cursor: string | null;
  total: number;               // count matching filters in window
}

export interface IdentityDetectionDetail extends IdentityDetectionListItem {
  technique: string;                   // threats.technique
  matched_lure: string | null;         // classifier `matched` recomputed at read time
  ttps: { id: string; name: string; tactic: string; url: string }[];
  infrastructure: {
    ip_address: string | null;
    country_code: string | null;
    asn: string | null;
    hosting_provider: { id: string; name: string } | null;
    ssl_cert_issuer: string | null;
  };
  registration: {
    domain_created_at: string | null;
    domain_age_days: number | null;
    weaponization_hours: number | null;
    weaponization_flag: string | null;
  };
  reputation: {
    vt_checked: boolean; vt_malicious: number | null;
    gsb_checked: boolean; gsb_flagged: boolean | null; gsb_threat_type: string | null;
    greynoise_checked: boolean; greynoise_classification: string | null;
    seclookup_checked: boolean; seclookup_risk_score: number | null;
    surbl_listed: boolean | null; dbl_listed: boolean | null;
  };
  timeline: { first_seen: string | null; last_seen: string | null; created_at: string; enriched_at: string | null };
  takedown: { id: string; status: string; updated_at: string | null } | null;
  cluster: { id: string; name: string | null } | null;
}

/** Active drill-down filters (mirrored in the URL search params). */
export interface IdentityFilters {
  idp?: string;
  vector?: string;
  brand_id?: string;
  mitre?: string;
}

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

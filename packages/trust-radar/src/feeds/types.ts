import type { Env } from "../types";

/** Context passed to every feed module's ingest function */
export interface FeedContext {
  env: Env;
  feedName: string;
  feedUrl: string;
}

/** Result returned by every feed module */
export interface FeedResult {
  itemsFetched: number;
  itemsNew: number;
  itemsDuplicate: number;
  itemsError: number;
}

/** A feed module implements a single ingest function */
export interface FeedModule {
  ingest(ctx: FeedContext): Promise<FeedResult>;
}

/**
 * Row shape for inserting into the v2 threats table.
 * Matches the schema in 0001_core_tables.sql.
 */
export interface ThreatRow {
  id: string;
  source_feed: string;
  threat_type: "phishing" | "typosquatting" | "impersonation" | "malware_distribution" | "credential_harvesting" | "c2" | "scanning" | "malicious_ip" | "botnet" | "malicious_ssl";
  malicious_url: string | null;
  malicious_domain: string | null;
  target_brand_id?: string | null;
  hosting_provider_id?: string | null;
  ip_address?: string | null;
  asn?: string | null;
  country_code?: string | null;
  registrar?: string | null;
  status?: "active" | "down" | "remediated";
  confidence_score?: number | null;     // 0-100
  campaign_id?: string | null;
  ioc_value?: string | null;
  severity?: "critical" | "high" | "medium" | "low" | "info" | null;
  technique?: string | null;        // finer-grained TTP, e.g. 'device_code_phishing' (migration 0205)
  named_threat_id?: string | null;  // link to named_threats catalog (migration 0204)
  // SSL certificate identity (migration 0234, NEXUS Lane C). Populated
  // by the two CT sources; NULL for every non-cert feed.
  ssl_cert_serial?: string | null;  // cert serial number as reported by the source
  ssl_cert_issuer?: string | null;  // issuer O/CN (or fingerprint from calidog)
  ssl_san_hash?: string | null;     // sha256 hex of the normalized SAN set — computeSanHash()
}

/** Helper to generate a deterministic ID from source + IOC to prevent duplicates */
export function threatId(source: string, iocType: string, iocValue: string): string {
  const input = `${source}:${iocType}:${iocValue}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `thr-${source}-${Math.abs(hash).toString(36)}`;
}

export { extractDomain } from "../lib/domain-utils";

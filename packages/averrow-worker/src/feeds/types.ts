import type { Env } from "../types";

/** Context passed to every feed module's ingest function */
export interface FeedContext {
  env: Env;
  feedName: string;
  feedUrl: string;
  /**
   * The feeds-family store this pull was resolved under (Track B1d: the
   * routed feed_configs / feed_status / feed_pull_history DB). runFeed always
   * sets it; a module that reads or writes a feeds-family table (its own
   * pull row, its feed_status / feed_configs row) must use it — via
   * feedStoreOf(ctx) — never ctx.env.DB, or a pull that straddles a flip
   * writes half its bookkeeping to the other DB. Optional only so unit tests
   * can build a bare context (they get core).
   */
  feedsDb?: D1Database;
}

/** The pull's feeds-family store (core for a hand-built test context). */
export function feedStoreOf(ctx: FeedContext): D1Database {
  return ctx.feedsDb ?? ctx.env.DB;
}

/** Result returned by every feed module */
export interface FeedResult {
  itemsFetched: number;
  itemsNew: number;
  itemsDuplicate: number;
  itemsError: number;
  /**
   * Optional note for a pull that SUCCEEDED but degraded (e.g. some optional
   * upstream endpoints failed). runFeed writes it to the success row's
   * feed_pull_history.error_message (status stays 'success'); it never
   * touches feed_status.last_error. Omit on a clean pull.
   */
  warning?: string;
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
  // Malware family as reported by the source (migration 0295). Set by
  // ThreatFox; NULL for every other feed. bulkInsertThreats fills it onto
  // an existing NULL row when the IOC is re-reported. The single-row
  // insertThreat path does NOT do that duplicate fill — it only writes the
  // value on a brand-new row.
  malware_family?: string | null;
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

/**
 * Collision-safe deterministic id: `thr-<source>-` + the first 64 bits
 * (16 hex chars) of SHA-256("<source>:<iocType>:<iocValue>"). Use it for
 * feeds whose corpus grows into the tens of thousands, where `threatId`'s
 * 31-bit hash starts to collide (a collision silently drops a NEW IOC via
 * INSERT OR IGNORE). `threatId` ids are base36 of a 31-bit value (≤ 6
 * chars), so the two id spaces never overlap.
 */
export async function threatId64(source: string, iocType: string, iocValue: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${source}:${iocType}:${iocValue}`));
  const hex = Array.from(new Uint8Array(digest, 0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `thr-${source}-${hex}`;
}

export { extractDomain } from "../lib/domain-utils";

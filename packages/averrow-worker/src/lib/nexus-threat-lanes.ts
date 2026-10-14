/**
 * NEXUS threats-table lanes — the ONE implementation shared by both NEXUS
 * dispatch paths:
 *
 *   - workflows/nexusRun.ts (the live 4-hourly Workflow; each lane is one
 *     retry-idempotent `step.do`)
 *   - agents/nexus.ts       (the manual-trigger fallback agent)
 *
 * Both paths upsert the SAME `infrastructure_clusters` rows (deterministic
 * ids) and stamp the SAME `threats.cluster_id` values, so the lane SQL, the
 * confidence model, the naming and the stamp predicates must never diverge.
 * They used to be duplicated byte-for-byte in the two files and drifted
 * repeatedly (the workflow ASN lane kept minting random-UUID ids for months
 * after the agent was fixed; the per-IP lane was missing from the workflow
 * entirely). Keeping them here makes parity structural — test/
 * nexus-lane-parity.test.ts pins that both callers invoke these functions
 * and carry no lane SQL of their own.
 *
 * Lane run-order precedence (MOST-SPECIFIC FIRST — every stamp carries a
 * `cluster_id IS NULL` guard, so the first lane to claim a threat owns it):
 *   cert-serial → cert-SAN → per-IP → /24 subnet → registrar → ASN.
 * Then `retireNonOperationalLaneClusters` flips stale ASN / per-IP / subnet
 * rows that no longer qualify as operator evidence. Callers must keep that
 * order.
 *
 * 2026-10-14 cluster-quality fix (owner-approved):
 *   - Shared infrastructure is two sets (lib/shared-infra-asns.ts):
 *     MULTI_TENANT_ASNS (one IP serves many tenants — CDN, site builders,
 *     parking, free hosts) and SINGLE_TENANT_IAAS_ASNS (hyperscalers / VPS —
 *     the ASN is a landlord but an IP is one customer). ASN and /24 lanes
 *     skip both; the per-IP lane skips only multi-tenant.
 *   - ASN lane: skips IP-reputation threat types (scanning / malicious_ip)
 *     and empty / NULL types, groups ACTIVE threats only (threat_count counts
 *     every active threat on the ASN + type — more-specific lanes may already
 *     own some of them, so it can exceed what this lane stamps), normalises
 *     malformed ASN strings ("AS13335 Cloudflare, Inc." → "AS13335"), never
 *     emits a group whose brand fan-out exceeds the hub threshold, and caps
 *     ASN-only confidence at ASN_CONFIDENCE_CAP — it rises with campaign
 *     overlap, volume and targeting (few brands), never with brand breadth.
 *   - Per-IP lane: candidates capped at the component hub threshold, threats
 *     on multi-tenant ASNs and bogon IPs (reserved / private ranges) excluded,
 *     ranked by threat volume; confidence no longer rewards brand breadth.
 *   - /24 lane: the 5-ASN CDN literal is replaced by SHARED_INFRA_ASNS (both
 *     sets), bogon / private ranges are excluded, and the stamp mirrors the
 *     filter (it used to claim CDN-hosted members the grouping had excluded).
 *   - Every lane writes `country_counts` (migration 0302) from its existing
 *     scan — see tallyCountries — and evidence-first names
 *     (lib/cluster-naming.ts).
 *
 * Pure SQL + deterministic JS. No AI.
 */

import {
  MULTI_TENANT_ASNS,
  MULTI_TENANT_ASNS_SQL_LIST,
  SHARED_INFRA_ASNS,
  SHARED_INFRA_ASNS_SQL_LIST,
  asnKey,
  asnKeySql,
} from "./shared-infra-asns";
import { DEFAULT_HUB_FANOUT_THRESHOLD } from "./cluster-components";
import { buildDormancyPivotPayload } from "./cluster-infra-movement";
import {
  slugifyKey,
  generateClusterName,
  certSerialClusterName,
  certSanClusterName,
  perIpClusterName,
  subnetClusterName,
  registrarClusterName,
} from "./cluster-naming";
import { SHARED_INFRA_RETIRED_REASON, SUPERSEDED_RETIRED_REASON, type ClusterRetiredReason } from "./cluster-status";

// ─── ASN normalisation ────────────────────────────────────────────────
// asnKey / asnKeySql / the shared-infra ASN sets live in
// lib/shared-infra-asns.ts — the single normaliser shared with the
// Observatory operations-geo classifier and cluster retirement.

/**
 * Threat types that are IP-reputation sightings (a host seen scanning, an IP
 * on a blocklist), not phishing/malware OPERATIONS. Grouping them by ASN
 * produces "AS4134 scanning" — a statement about an ISP's dirty address
 * space, not an actor. The ASN lane skips them.
 */
export const IP_REPUTATION_THREAT_TYPES: readonly string[] = ["scanning", "malicious_ip"];
const IP_REP_SQL_LIST = IP_REPUTATION_THREAT_TYPES.map((t) => `'${t}'`).join(", ");

/**
 * Threat row is NOT on a shared-infra ASN of either kind (unknown /
 * unparseable ASN passes). The ASN-grouping lanes' guard (/24).
 */
const NOT_SHARED_ASN_SQL =
  `(asn IS NULL OR COALESCE(${asnKeySql("asn")}, '') NOT IN (${SHARED_INFRA_ASNS_SQL_LIST}))`;

/**
 * Threat row is NOT on a multi-tenant ASN (IaaS and unknown ASNs pass). The
 * per-IP lane's guard: on a hyperscaler / VPS an IP is one customer.
 */
const NOT_MULTI_TENANT_ASN_SQL =
  `(asn IS NULL OR COALESCE(${asnKeySql("asn")}, '') NOT IN (${MULTI_TENANT_ASNS_SQL_LIST}))`;

// ─── Bogon / private IPs (reserved / private ranges) ──────────────────
//
// A "shared IP" of 127.0.0.1, 0.0.0.0, 10.x or a CGNAT address is a feed's
// placeholder / resolver artefact in reserved / private ranges, not hosting
// — hundreds of unrelated domains resolve there. Excluded from the per-IP
// and /24 lanes (SELECT and stamp alike) and retired by the lane retire
// pass. 0/8, 10/8, 127/8, 169.254/16, 192.168/16 are plain prefixes;
// 172.16/12 and 100.64/10 check the second octet numerically. isBogonIpv4
// is the JS twin (test/nexus-threat-lanes.test.ts runs both over the same
// samples).
//
// The SQL tests trim(ip_address), not the raw column: the retire pass
// judges a per-IP row by the CLEANED IP taken from its cluster id, so a
// padded " 10.0.0.1" must read as a bogon here too, or the lane would emit
// a row the retire pass then parks — every run (flip-flop). Prod holds no
// padded IPs today; this is defensive. trim() is a cheap per-row string op
// and none of these predicates is index-driven (the lanes are driven by
// status / ip_subnet24), so it costs no plan change.

const BOGON_IP_EXPR = "trim(ip_address)";
const SECOND_OCTET_SQL = `CAST(substr(${BOGON_IP_EXPR}, 5, instr(substr(${BOGON_IP_EXPR}, 5), '.') - 1) AS INTEGER)`;

/** `trim(ip_address)` is NOT a bogon / private / CGNAT / link-local IPv4. */
export const NOT_BOGON_IP_SQL = `(${BOGON_IP_EXPR} NOT LIKE '0.%'
            AND ${BOGON_IP_EXPR} NOT LIKE '10.%'
            AND ${BOGON_IP_EXPR} NOT LIKE '127.%'
            AND ${BOGON_IP_EXPR} NOT LIKE '169.254.%'
            AND ${BOGON_IP_EXPR} NOT LIKE '192.168.%'
            AND NOT (${BOGON_IP_EXPR} LIKE '172.%' AND ${SECOND_OCTET_SQL} BETWEEN 16 AND 31)
            AND NOT (${BOGON_IP_EXPR} LIKE '100.%' AND ${SECOND_OCTET_SQL} BETWEEN 64 AND 127))`;

/**
 * JS twin of NOT_BOGON_IP_SQL (negated): true for a bogon / private IPv4.
 * Trims spaces only, like SQLite's one-argument trim().
 */
export function isBogonIpv4(raw: string): boolean {
  const ip = raw.replace(/^ +| +$/g, "");
  const lower = ip.toLowerCase();
  if (["0.", "10.", "127.", "169.254.", "192.168."].some((p) => lower.startsWith(p))) return true;
  const octet2 = (): number => {
    const rest = ip.slice(4);
    const dot = rest.indexOf(".");
    const n = parseInt(dot === -1 ? "" : rest.slice(0, dot), 10);
    return Number.isFinite(n) ? n : 0;
  };
  if (ip.startsWith("172.")) { const o = octet2(); return o >= 16 && o <= 31; }
  if (ip.startsWith("100.")) { const o = octet2(); return o >= 64 && o <= 127; }
  return false;
}

const ASN_NORM_SQL = asnKeySql("asn");

// ─── Per-country counts ───────────────────────────────────────────────

/** Top-N countries kept in `infrastructure_clusters.country_counts`. */
export const COUNTRY_COUNTS_CAP = 20;

/**
 * Tally a lane's `GROUP_CONCAT(country_code)` (NOT distinct — one entry per
 * member threat) into per-country counts. This is how country_counts is
 * filled from each lane's EXISTING scan: adding country_code to the GROUP BY
 * instead would break the lanes' COUNT(DISTINCT …) aggregates (brands,
 * domains, IPs aren't additive across country sub-groups) and move their
 * HAVING / ORDER BY / LIMIT bounds out of SQL, so the multiset rides along in
 * the one grouped read instead — no second pass over threats.
 *
 * Returns every distinct country ordered by volume (the `countries` column)
 * and the top COUNTRY_COUNTS_CAP as a {CC: n} object whose key order is the
 * rank. Only ISO-2 codes count; '' and the 'XX' unknown sentinel are skipped.
 */
export function tallyCountries(list: string | null | undefined): {
  countries: string[];
  countryCounts: Record<string, number>;
} {
  const counts = new Map<string, number>();
  for (const raw of (list ?? "").split(",")) {
    const cc = raw.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc) || cc === "XX") continue;
    counts.set(cc, (counts.get(cc) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const countryCounts: Record<string, number> = {};
  for (const [cc, n] of ranked.slice(0, COUNTRY_COUNTS_CAP)) countryCounts[cc] = n;
  return { countries: ranked.map(([cc]) => cc), countryCounts };
}

// ─── Confidence models ────────────────────────────────────────────────

/** ASN-only evidence never scores above this. */
export const ASN_CONFIDENCE_CAP = 40;
/** Dormancy pivot (→ Observer) needs at least this ASN confidence. */
export const ASN_PIVOT_MIN_CONFIDENCE = 25;
/** intel_predictive (agent path) needs at least this ASN confidence. */
export const ASN_PREDICTIVE_MIN_CONFIDENCE = 35;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** ASN group targeting at most this many brands counts as targeted. */
export const ASN_TARGETED_MAX_BRANDS = 5;

/**
 * ASN-lane confidence. ASN-only evidence is weak: a whole provider's address
 * space. It starts low and rises only with SPECIFICITY — its members already
 * overlap known campaigns (the main lift), it has sustained volume, it is
 * targeted (few brands). Country concentration is NOT a signal: an ASN is
 * almost always one country's address space, so "one country" was a
 * tautological bonus. Brand breadth is NOT rewarded (the old `brands * 5`
 * term drove every widely-shared ASN to 100); a single ASN hitting more than
 * 50 brands is commodity hosting and costs confidence.
 *
 * Scale: 15 base, +15 (>= 2 campaigns) / +5 (1 campaign), +5 (>= 50
 * threats), +5 (<= ASN_TARGETED_MAX_BRANDS brands), -10 (> 50 brands);
 * clamped to [5, ASN_CONFIDENCE_CAP]. Every bonus together reaches the cap.
 */
export function computeAsnClusterConfidence(s: {
  threats: number;
  campaigns: number;
  brands: number;
}): number {
  let c = 15;
  if (s.campaigns >= 2) c += 15;
  else if (s.campaigns === 1) c += 5;
  if (s.threats >= 50) c += 5;
  if (s.brands >= 1 && s.brands <= ASN_TARGETED_MAX_BRANDS) c += 5;
  if (s.brands > 50) c -= 10;
  return clamp(c, 5, ASN_CONFIDENCE_CAP);
}

/**
 * Per-IP confidence. One IP hosting impersonations of several brands is
 * genuine shared-operator evidence, so it starts mid-scale; it rises with
 * volume and single-network hosting. Breadth is no longer the signal (the old
 * model scored 90 for ≥100 brands — exactly the parking / anycast hubs); a
 * fan-out approaching the hub threshold costs confidence instead.
 */
export function computePerIpConfidence(s: {
  threats: number;
  brands: number;
  asnCount: number;
}): number {
  let c = 50;
  if (s.threats >= 100) c += 15;
  else if (s.threats >= 20) c += 10;
  if (s.asnCount === 1) c += 5;
  if (s.brands <= 25) c += 10;
  else if (s.brands > 75) c -= 10;
  return clamp(c, 30, 80);
}

// ─── Shared write helpers ─────────────────────────────────────────────

function splitList(v: string | null | undefined): string[] {
  return (v ?? "").split(",").filter(Boolean);
}

function parseJsonArray(v: string | null | undefined): unknown[] {
  if (!v) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonStringArray(v: string | null | undefined): string[] {
  return parseJsonArray(v).filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * A cluster's `asns` JSON → canonical `AS<digits>` keys. Accepts every form
 * asnKey does, INCLUDING bare JSON numbers (`[13335]`) — a string-only
 * filter used to drop those, so a numeric shared-infra ASN escaped retirement.
 */
export function parseJsonAsnArray(v: string | null | undefined): string[] {
  return parseJsonArray(v).map(asnKey).filter((a): a is string => a !== null);
}

/** Raw stamp variants (strings, or numbers when a source stored one). */
function parseJsonScalarArray(v: string | null | undefined): Array<string | number> {
  return parseJsonArray(v).filter((x): x is string | number =>
    (typeof x === "string" && x.length > 0) || (typeof x === "number" && Number.isFinite(x)));
}

interface ClusterUpsert {
  id: string;
  name: string;
  asns: string[];
  countries: string[];
  countryCounts: Record<string, number>;
  attackTypes: string[];
  brandIds: string[];
  providerIds: string[];
  threatCount: number;
  confidence: number;
  firstSeen: string | null;
  lastSeen: string | null;
  status: "active" | "dormant";
  agentNotes: string | null;
}

const UPSERT_COLUMNS = `id, cluster_name, asns, countries, country_counts, attack_types, brand_ids,
            campaign_ids, hosting_provider_ids, threat_count, confidence_score,
            first_detected, last_seen, status, agent_notes`;

const UPSERT_SET = `cluster_name = excluded.cluster_name,
            asns = excluded.asns,
            countries = excluded.countries,
            country_counts = excluded.country_counts,
            attack_types = excluded.attack_types,
            brand_ids = excluded.brand_ids,
            hosting_provider_ids = excluded.hosting_provider_ids,
            threat_count = excluded.threat_count,
            confidence_score = excluded.confidence_score,
            last_seen = excluded.last_seen,
            agent_notes = excluded.agent_notes`;

/**
 * Reactivation on upsert. Retirement never changes `status` (prod CHECK:
 * active / dormant / disrupted — lib/cluster-status.ts), so a reactivated
 * row keeps its status (the ASN lane then overwrites it, see below).
 *
 * Specific lanes (per-IP, /24; the cert / registrar lanes are never
 * retired): a row retireNonOperationalLaneClusters parked as `shared_infra`
 * that the lane emits again (e.g. a per-IP row whose fan-out dropped back
 * under the hub threshold — the lane's filter just re-admitted it) gets
 * retired_reason cleared. Any other reason (`superseded`) is kept; the
 * retire pass never supersedes a per-IP / subnet row, so the guard only
 * matters if a future writer does.
 */
const UPSERT_CLEAR_SHARED_INFRA = `retired_reason = CASE
                WHEN infrastructure_clusters.retired_reason = '${SHARED_INFRA_RETIRED_REASON}' THEN NULL
                ELSE infrastructure_clusters.retired_reason END`;

/** Upsert for the specific lanes. Status is left alone. */
const UPSERT_KEEP_STATUS_SQL = `
          INSERT INTO infrastructure_clusters (
            ${UPSERT_COLUMNS}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            ${UPSERT_SET},
            ${UPSERT_CLEAR_SHARED_INFRA}`;

/**
 * Upsert for the ASN lane, which owns active ↔ dormant (pivot) status.
 *
 * Clears retired_reason UNCONDITIONALLY, `superseded` included. The lane
 * only ever writes the canonical `cluster_asn_<AS digits>_<type>` id it just
 * computed from a normalised ASN, and the ~76K legacy superseded rows have
 * random-UUID ids (not `cluster_`), so the only superseded rows it can hit
 * are canonical `cluster_asn_*` rows the retire pass superseded because
 * their STORED asns / attack_types were unparseable or mismatched. The lane
 * has just overwritten both with good values, so the row is a live
 * operation again; keeping `superseded` would hide it forever while the
 * lane kept refreshing and stamping it.
 *
 * No retire / reactivate loop: the retire pass runs after the lanes and
 * decideLaneRowRetirement mirrors this lane's filter — for a row the lane
 * just wrote, asnClusterId(asns[0], attack_types[0]) === id, the ASN is not
 * shared, the type is not IP-reputation and the fan-out is within
 * ASN_MAX_BRAND_FANOUT, so it returns null. Pinned in
 * test/nexus-threat-lanes.test.ts.
 */
const UPSERT_LANE_STATUS_SQL = `
          INSERT INTO infrastructure_clusters (
            ${UPSERT_COLUMNS}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            ${UPSERT_SET},
            status = excluded.status,
            retired_reason = NULL`;

async function upsertCluster(db: D1Database, c: ClusterUpsert, ownsStatus: boolean): Promise<void> {
  await db.prepare(ownsStatus ? UPSERT_LANE_STATUS_SQL : UPSERT_KEEP_STATUS_SQL).bind(
    c.id,
    c.name,
    JSON.stringify(c.asns),
    JSON.stringify(c.countries),
    JSON.stringify(c.countryCounts),
    JSON.stringify(c.attackTypes),
    JSON.stringify(c.brandIds),
    JSON.stringify([]), // campaign_ids — not aggregated by any lane
    JSON.stringify(c.providerIds),
    c.threatCount,
    c.confidence,
    c.firstSeen,
    c.lastSeen,
    c.status,
    c.agentNotes,
  ).run();
}

export interface LaneResult {
  clustersWritten: number;
  /** Groups the lane's SELECT returned (before per-row guards). */
  analyzed: number;
  /** Per-cluster upsert/stamp failures (the lane continues past them). */
  writeErrors: number;
}

// ─── Lane C1: SSL cert-serial ─────────────────────────────────────────
//
// One certificate serial reused across >= 2 impersonation domains is
// near-conclusive same-operator evidence (a serial is minted per issuance).
// Cluster on the serial ALONE — never the issuer (Let's Encrypt issues to
// every phishing domain on earth; that is the ASN over-merge trap reborn).
// No upper over-merge cap: a serial genuinely reused across 500 domains IS
// one operator. Runs FIRST so the stamp claims these before coarser lanes.

export const CERT_SERIAL_LANE_SQL = `
      SELECT ssl_cert_serial,
             COUNT(*)                               AS threat_count,
             COUNT(DISTINCT malicious_domain)       AS domain_count,
             COUNT(DISTINCT target_brand_id)        AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT ${ASN_NORM_SQL}) AS asns,
             GROUP_CONCAT(country_code)             AS country_list,
             GROUP_CONCAT(DISTINCT threat_type)     AS attack_types,
             MAX(ssl_cert_issuer)                   AS issuer,
             MIN(first_seen)                        AS first_seen,
             MAX(first_seen)                        AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ssl_cert_serial IS NOT NULL
         AND ssl_cert_serial != ''
         AND target_brand_id IS NOT NULL
       GROUP BY ssl_cert_serial
      HAVING COUNT(DISTINCT malicious_domain) >= 2
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 50`;

interface CertLaneRow {
  threat_count: number;
  domain_count: number;
  brand_count: number;
  brand_ids: string | null;
  asns: string | null;
  country_list: string | null;
  attack_types: string | null;
  issuer: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

/** HIGH confidence: certificate reuse is a top-tier infra signal. */
export function computeCertClusterConfidence(brandCount: number): number {
  return Math.min(100, 80 + (brandCount >= 10 ? 20 : brandCount >= 5 ? 10 : 5));
}

export async function runCertSerialLane(db: D1Database): Promise<LaneResult> {
  const rows = (await db.prepare(CERT_SERIAL_LANE_SQL).all<CertLaneRow & { ssl_cert_serial: string }>()).results ?? [];
  const out: LaneResult = { clustersWritten: 0, analyzed: rows.length, writeErrors: 0 };
  for (const row of rows) {
    const id = `cluster_cert_${slugifyKey(row.ssl_cert_serial)}`;
    const { countries, countryCounts } = tallyCountries(row.country_list);
    try {
      await upsertCluster(db, {
        id,
        name: certSerialClusterName(row.ssl_cert_serial, row.domain_count),
        asns: splitList(row.asns),
        countries,
        countryCounts,
        attackTypes: splitList(row.attack_types),
        brandIds: splitList(row.brand_ids),
        providerIds: [],
        threatCount: row.threat_count,
        confidence: computeCertClusterConfidence(row.brand_count),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        status: "active",
        agentNotes: JSON.stringify({
          cluster_type: "ssl_cert_serial",
          ssl_cert_serial: row.ssl_cert_serial,
          ssl_cert_issuer: row.issuer,
          brands_targeted: row.brand_count,
          domains_count: row.domain_count,
          threats_count: row.threat_count,
        }),
      }, false);
      out.clustersWritten++;
      // Stamp predicate MIRRORS the SELECT filter exactly.
      await db.prepare(
        `UPDATE threats SET cluster_id = ?
          WHERE ssl_cert_serial = ? AND status = 'active'
            AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
      ).bind(id, row.ssl_cert_serial).run();
    } catch {
      out.writeErrors++;
    }
  }
  return out;
}

// ─── Lane C2: SSL SAN-set ─────────────────────────────────────────────
//
// One SAN set (ssl_san_hash, hashed cross-source-consistently at ingest)
// reused across >= 2 impersonation domains = the same cert template minted
// for multiple domains = same operator. Runs after the serial lane so a
// serial-identified cluster keeps its tighter grouping.

export const CERT_SAN_LANE_SQL = `
      SELECT ssl_san_hash,
             COUNT(*)                               AS threat_count,
             COUNT(DISTINCT malicious_domain)       AS domain_count,
             COUNT(DISTINCT target_brand_id)        AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT ${ASN_NORM_SQL}) AS asns,
             GROUP_CONCAT(country_code)             AS country_list,
             GROUP_CONCAT(DISTINCT threat_type)     AS attack_types,
             MAX(ssl_cert_issuer)                   AS issuer,
             MIN(first_seen)                        AS first_seen,
             MAX(first_seen)                        AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ssl_san_hash IS NOT NULL
         AND ssl_san_hash != ''
         AND target_brand_id IS NOT NULL
       GROUP BY ssl_san_hash
      HAVING COUNT(DISTINCT malicious_domain) >= 2
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 50`;

export async function runCertSanLane(db: D1Database): Promise<LaneResult> {
  const rows = (await db.prepare(CERT_SAN_LANE_SQL).all<CertLaneRow & { ssl_san_hash: string }>()).results ?? [];
  const out: LaneResult = { clustersWritten: 0, analyzed: rows.length, writeErrors: 0 };
  for (const row of rows) {
    const id = `cluster_cert_${slugifyKey(row.ssl_san_hash)}`;
    const { countries, countryCounts } = tallyCountries(row.country_list);
    try {
      await upsertCluster(db, {
        id,
        name: certSanClusterName(row.ssl_san_hash, row.domain_count),
        asns: splitList(row.asns),
        countries,
        countryCounts,
        attackTypes: splitList(row.attack_types),
        brandIds: splitList(row.brand_ids),
        providerIds: [],
        threatCount: row.threat_count,
        confidence: computeCertClusterConfidence(row.brand_count),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        status: "active",
        agentNotes: JSON.stringify({
          cluster_type: "ssl_san_hash",
          ssl_san_hash: row.ssl_san_hash,
          ssl_cert_issuer: row.issuer,
          brands_targeted: row.brand_count,
          domains_count: row.domain_count,
          threats_count: row.threat_count,
        }),
      }, false);
      out.clustersWritten++;
      await db.prepare(
        `UPDATE threats SET cluster_id = ?
          WHERE ssl_san_hash = ? AND status = 'active'
            AND target_brand_id IS NOT NULL AND cluster_id IS NULL`,
      ).bind(id, row.ssl_san_hash).run();
    } catch {
      out.writeErrors++;
    }
  }
  return out;
}

// ─── Lane: per-IP fan-out ─────────────────────────────────────────────
//
// Same active IP across >= 5 threats AND >= 3 brands ⇒ `cluster_ip_<ip>`.
// Until 2026-10-14 the lane ranked by brand_count DESC, which selected
// exactly the most-SHARED IPs (AWS Global Accelerator parking, Cloudflare
// anycast, Sedo, Squarespace, Shopify, Vercel, Firebase): 35 of 36 per-IP
// clusters exceeded the 150-brand hub threshold, so they could never bridge
// a component either. Now:
//   - candidates must sit at or under DEFAULT_HUB_FANOUT_THRESHOLD brands
//     (the same threshold lib/cluster-components uses — a cluster over it
//     can't bridge anyway);
//   - threats whose ASN is a MULTI-TENANT network (CDN / site builder /
//     parking / free host) are excluded. Hyperscaler / VPS (IaaS) IPs stay
//     eligible: one IaaS IP is normally one customer, and the hub cap above
//     drops the few that aren't. An unknown ASN still qualifies — the IP
//     itself is the evidence;
//   - bogon IPs (reserved / private ranges) are excluded (NOT_BOGON_IP_SQL);
//   - ranking is by threat volume, then breadth.

export const PER_IP_LANE_SQL = `
      SELECT ip_address,
             COUNT(*)                               AS threat_count,
             COUNT(DISTINCT target_brand_id)        AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT ${ASN_NORM_SQL}) AS asns,
             GROUP_CONCAT(country_code)             AS country_list,
             GROUP_CONCAT(DISTINCT threat_type)     AS attack_types,
             MIN(first_seen)                        AS first_seen,
             MAX(first_seen)                        AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ip_address IS NOT NULL
         AND ip_address NOT IN ('', '0.0.0.0')
         AND ${NOT_BOGON_IP_SQL}
         AND target_brand_id IS NOT NULL
         AND ${NOT_MULTI_TENANT_ASN_SQL}
       GROUP BY ip_address
      HAVING brand_count >= 3 AND threat_count >= 5 AND brand_count <= ?
       ORDER BY threat_count DESC, brand_count DESC
       LIMIT 30`;

export const PER_IP_STAMP_SQL = `UPDATE threats SET cluster_id = ?
          WHERE ip_address = ? AND status = 'active'
            AND target_brand_id IS NOT NULL AND cluster_id IS NULL
            AND ${NOT_BOGON_IP_SQL}
            AND ${NOT_MULTI_TENANT_ASN_SQL}`;

export async function runPerIpLane(db: D1Database): Promise<LaneResult> {
  const rows = (await db.prepare(PER_IP_LANE_SQL).bind(DEFAULT_HUB_FANOUT_THRESHOLD).all<{
    ip_address: string;
    threat_count: number;
    brand_count: number;
    brand_ids: string | null;
    asns: string | null;
    country_list: string | null;
    attack_types: string | null;
    first_seen: string | null;
    last_seen: string | null;
  }>()).results ?? [];
  const out: LaneResult = { clustersWritten: 0, analyzed: rows.length, writeErrors: 0 };
  for (const row of rows) {
    // Id keeps the historical char-strip (lib/cluster-components
    // extractBridgeKey reconstructs the IP from it).
    const id = `cluster_ip_${row.ip_address.replace(/[^0-9a-f.:]/gi, "")}`;
    const asns = splitList(row.asns);
    const { countries, countryCounts } = tallyCountries(row.country_list);
    try {
      await upsertCluster(db, {
        id,
        name: perIpClusterName(row.ip_address, row.brand_count),
        asns,
        countries,
        countryCounts,
        attackTypes: splitList(row.attack_types),
        brandIds: splitList(row.brand_ids),
        providerIds: [],
        threatCount: row.threat_count,
        confidence: computePerIpConfidence({ threats: row.threat_count, brands: row.brand_count, asnCount: asns.length }),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        status: "active",
        // Plain string on purpose: per-IP bridge keys are parsed from the id,
        // and classifyClusterKind keys cluster_ip_ rows by prefix.
        agentNotes: `Per-IP fan-out: ${row.ip_address} hosts threats against ${row.brand_count} brands across ${asns.length} ASNs.`,
      }, false);
      out.clustersWritten++;
      await db.prepare(PER_IP_STAMP_SQL).bind(id, row.ip_address).run();
    } catch {
      out.writeErrors++;
    }
  }
  return out;
}

// ─── Lane A: /24 subnet ───────────────────────────────────────────────
//
// Groups active threats by the ip_subnet24 generated column (migration 0235,
// index-backed). Catches an actor spreading across a contiguous block — a
// signal the per-IP lane (one IP) and the ASN lane (whole provider) miss.
// Shared-infra guard: a /24 on a CDN / hyperscaler is co-tenancy noise, so
// members on SHARED_INFRA_ASNS (multi-tenant AND IaaS — on a VPS provider a
// /24 is many customers) are excluded (this replaced a 5-ASN literal —
// Cloudflare, Fastly, CloudFront, Akamai, Google — with both shared lists).
// Bogon / private ranges are excluded too. distinct_ips >= 2 distinguishes
// it from the per-IP lane; brand_count <= hub threshold is the over-merge
// guard.

export const SUBNET_LANE_SQL = `
      SELECT ip_subnet24                            AS subnet24,
             COUNT(*)                               AS threat_count,
             COUNT(DISTINCT ip_address)             AS distinct_ips,
             COUNT(DISTINCT target_brand_id)        AS brand_count,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT ${ASN_NORM_SQL}) AS asns,
             GROUP_CONCAT(country_code)             AS country_list,
             GROUP_CONCAT(DISTINCT threat_type)     AS attack_types,
             MIN(first_seen)                        AS first_seen,
             MAX(first_seen)                        AS last_seen
        FROM threats
       WHERE status = 'active'
         AND ip_subnet24 IS NOT NULL
         AND ${NOT_BOGON_IP_SQL}
         AND target_brand_id IS NOT NULL
         AND ${NOT_SHARED_ASN_SQL}
       GROUP BY ip_subnet24
      HAVING distinct_ips >= 2 AND brand_count >= 3 AND threat_count >= 8 AND brand_count <= ?
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 50`;

export const SUBNET_STAMP_SQL = `UPDATE threats SET cluster_id = ?
          WHERE ip_subnet24 = ? AND status = 'active'
            AND target_brand_id IS NOT NULL AND cluster_id IS NULL
            AND ${NOT_BOGON_IP_SQL}
            AND ${NOT_SHARED_ASN_SQL}`;

/** One notch below per-IP: a /24 is looser evidence than one shared IP. */
export function computeSubnetConfidence(brandCount: number): number {
  return Math.min(100, brandCount >= 100 ? 75 : brandCount >= 25 ? 60 : brandCount >= 10 ? 45 : 30);
}

export async function runSubnetLane(db: D1Database): Promise<LaneResult> {
  const rows = (await db.prepare(SUBNET_LANE_SQL).bind(DEFAULT_HUB_FANOUT_THRESHOLD).all<{
    subnet24: string;
    threat_count: number;
    distinct_ips: number;
    brand_count: number;
    brand_ids: string | null;
    asns: string | null;
    country_list: string | null;
    attack_types: string | null;
    first_seen: string | null;
    last_seen: string | null;
  }>()).results ?? [];
  const out: LaneResult = { clustersWritten: 0, analyzed: rows.length, writeErrors: 0 };
  for (const row of rows) {
    if (row.brand_count > DEFAULT_HUB_FANOUT_THRESHOLD) continue; // belt-and-braces (HAVING caps)
    const id = `cluster_subnet_${slugifyKey(row.subnet24)}`;
    const asns = splitList(row.asns);
    const { countries, countryCounts } = tallyCountries(row.country_list);
    try {
      await upsertCluster(db, {
        id,
        name: subnetClusterName(row.subnet24, row.distinct_ips),
        asns,
        countries,
        countryCounts,
        attackTypes: splitList(row.attack_types),
        brandIds: splitList(row.brand_ids),
        providerIds: [],
        threatCount: row.threat_count,
        confidence: computeSubnetConfidence(row.brand_count),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        status: "active",
        agentNotes: JSON.stringify({
          cluster_type: "subnet_24",
          subnet24: row.subnet24,
          distinct_ips: row.distinct_ips,
          brands_targeted: row.brand_count,
          threats_count: row.threat_count,
          asn_count: asns.length,
        }),
      }, false);
      out.clustersWritten++;
      await db.prepare(SUBNET_STAMP_SQL).bind(id, row.subnet24).run();
    } catch {
      out.writeErrors++;
    }
  }
  return out;
}

// ─── Lane B: registrar temporal cohort ────────────────────────────────
//
// HIGHEST over-merge risk — registrar ALONE is never a key. Mandatory
// guards: 14-day cohort, mega-registrar denylist, brand_count <= 60, and a
// concentration check (skip when spread over > 5 /24s). Written ASNs are
// truncated to the top entry so a loose cohort never trips the Attributor's
// asns.length >= 3 gate. Confidence capped at 50 — corroborating evidence.

export const REGISTRAR_LANE_SQL = `
      SELECT registrar,
             COUNT(*)                               AS threat_count,
             COUNT(DISTINCT target_brand_id)        AS brand_count,
             COUNT(DISTINCT rtrim(ip_address,'0123456789')) AS distinct_subnets,
             GROUP_CONCAT(DISTINCT target_brand_id) AS brand_ids,
             GROUP_CONCAT(DISTINCT ${ASN_NORM_SQL}) AS asns,
             GROUP_CONCAT(country_code)             AS country_list,
             GROUP_CONCAT(DISTINCT threat_type)     AS attack_types,
             MIN(first_seen)                        AS first_seen,
             MAX(first_seen)                        AS last_seen
        FROM threats
       WHERE status = 'active'
         AND registrar IS NOT NULL
         AND target_brand_id IS NOT NULL
         AND first_seen >= datetime('now','-14 days')
         AND lower(registrar) NOT IN ('godaddy.com, llc','namecheap, inc.','tucows domains inc.','google llc',
             'cloudflare, inc.','network solutions, llc','name.com, inc.','gname.com pte. ltd.','publicdomainregistry.com')
       GROUP BY registrar
      HAVING threat_count >= 8 AND brand_count >= 3 AND brand_count <= 60
       ORDER BY brand_count DESC, threat_count DESC
       LIMIT 25`;

export function computeRegistrarConfidence(brandCount: number): number {
  return Math.min(50, brandCount >= 25 ? 45 : brandCount >= 10 ? 35 : 25);
}

export async function runRegistrarLane(db: D1Database): Promise<LaneResult> {
  const rows = (await db.prepare(REGISTRAR_LANE_SQL).all<{
    registrar: string;
    threat_count: number;
    brand_count: number;
    distinct_subnets: number;
    brand_ids: string | null;
    asns: string | null;
    country_list: string | null;
    attack_types: string | null;
    first_seen: string | null;
    last_seen: string | null;
  }>()).results ?? [];
  const out: LaneResult = { clustersWritten: 0, analyzed: rows.length, writeErrors: 0 };
  for (const row of rows) {
    if (row.brand_count > 60) continue;
    if (row.distinct_subnets > 5) continue;
    const id = `cluster_registrar_${slugifyKey(row.registrar)}`;
    const asnsAll = splitList(row.asns);
    const { countries, countryCounts } = tallyCountries(row.country_list);
    try {
      await upsertCluster(db, {
        id,
        name: registrarClusterName(row.registrar),
        asns: asnsAll.slice(0, 1),
        countries,
        countryCounts,
        attackTypes: splitList(row.attack_types),
        brandIds: splitList(row.brand_ids),
        providerIds: [],
        threatCount: row.threat_count,
        confidence: computeRegistrarConfidence(row.brand_count),
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        status: "active",
        agentNotes: JSON.stringify({
          cluster_type: "registrar_cohort",
          registrar: row.registrar,
          brands_targeted: row.brand_count,
          threats_count: row.threat_count,
          distinct_subnets: row.distinct_subnets,
          asn_count_observed: asnsAll.length,
          window_days: 14,
        }),
      }, false);
      out.clustersWritten++;
      await db.prepare(
        `UPDATE threats SET cluster_id = ?
          WHERE registrar = ? AND status = 'active'
            AND target_brand_id IS NOT NULL
            AND first_seen >= datetime('now','-14 days') AND cluster_id IS NULL`,
      ).bind(id, row.registrar).run();
    } catch {
      out.writeErrors++;
    }
  }
  return out;
}

// ─── Lane: ASN + threat_type (RUNS LAST — mops up) ────────────────────
//
// The coarsest key (a whole provider), hence lowest precedence: its stamp
// only claims threats no specific lane already owns. Groups ACTIVE threats
// only (the old lane grouped every status — cluster_asn_as13335_malware_
// distribution reported 65,048 while 9,275 were stamped). threat_count is
// every active threat on the ASN + type, INCLUDING ones a more-specific lane
// already claimed, so it can exceed what this lane's stamp writes. The group
// key is the NORMALISED ASN; the stamp matches the raw asn spellings that
// normalise to it (`asn IN (…)`, index-backed by (asn, threat_type)).
//
// Skipped: shared-infra ASNs of either kind, IP-reputation types, NULL / ''
// types (a '' type slugs to `_unknown`, which the retire pass supersedes as a
// missing type — the lane would reactivate it every run), and any group whose
// brand fan-out exceeds the hub threshold (ASN_MAX_BRAND_FANOUT): one ASN
// carrying > 150 brands' impersonations is a landlord, not an operator.

export const ASN_LANE_SQL = `
      SELECT asn_norm                                AS asn,
             threat_type,
             COUNT(DISTINCT campaign_id)             AS campaigns,
             COUNT(DISTINCT target_brand_id)         AS brands,
             COUNT(*)                                AS threats,
             GROUP_CONCAT(country_code)              AS country_list,
             GROUP_CONCAT(DISTINCT target_brand_id)  AS brand_ids,
             GROUP_CONCAT(DISTINCT hosting_provider_id) AS provider_ids,
             json_group_array(DISTINCT asn_raw)      AS raw_asns,
             MIN(first_seen)                         AS first_seen,
             MAX(first_seen)                         AS last_seen,
             SUM(CASE WHEN first_seen >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last_7d,
             SUM(CASE WHEN first_seen < datetime('now', '-7 days')
                       AND first_seen >= datetime('now', '-14 days') THEN 1 ELSE 0 END) AS prev_7d
        FROM (
          SELECT ${ASN_NORM_SQL} AS asn_norm, asn AS asn_raw, threat_type,
                 campaign_id, target_brand_id, country_code, hosting_provider_id, first_seen
            FROM threats
           WHERE status = 'active'
             AND asn IS NOT NULL
             AND threat_type IS NOT NULL
             AND threat_type != ''
             AND threat_type NOT IN (${IP_REP_SQL_LIST})
        )
       WHERE asn_norm IS NOT NULL
         AND asn_norm NOT IN (${SHARED_INFRA_ASNS_SQL_LIST})
       GROUP BY asn_norm, threat_type
      HAVING COUNT(*) >= 10 AND COUNT(DISTINCT target_brand_id) <= ?
       ORDER BY threats DESC
       LIMIT 100`;

/** An ASN group over this brand fan-out is not emitted (and an existing row is retired). */
export const ASN_MAX_BRAND_FANOUT = DEFAULT_HUB_FANOUT_THRESHOLD;

/** D1 caps bound parameters at 100 per statement; the stamp binds 2 + the variants. */
const ASN_STAMP_VARIANT_CHUNK = 90;

export interface AsnLaneCluster {
  clusterId: string;
  clusterName: string;
  asn: string;
  threatType: string;
  threats: number;
  brandIds: string[];
  confidence: number;
  last7d: number;
  prev7d: number;
  isPivoting: boolean;
  isAccelerating: boolean;
  pivotEmitted: boolean;
}

export interface AsnLaneResult extends LaneResult {
  pivotsDetected: number;
  accelerating: number;
  /** Per-cluster detail for the agent path's correlation outputs. */
  clusters: AsnLaneCluster[];
}

export async function runAsnLane(db: D1Database): Promise<AsnLaneResult> {
  const rows = (await db.prepare(ASN_LANE_SQL).bind(ASN_MAX_BRAND_FANOUT).all<{
    asn: string;
    threat_type: string;
    campaigns: number;
    brands: number;
    threats: number;
    country_list: string | null;
    brand_ids: string | null;
    provider_ids: string | null;
    raw_asns: string | null;
    first_seen: string | null;
    last_seen: string | null;
    last_7d: number;
    prev_7d: number;
  }>()).results ?? [];
  const out: AsnLaneResult = {
    clustersWritten: 0, analyzed: rows.length, writeErrors: 0,
    pivotsDetected: 0, accelerating: 0, clusters: [],
  };

  for (const row of rows) {
    const { countries, countryCounts } = tallyCountries(row.country_list);
    const isPivoting = row.prev_7d > 10 && row.last_7d < row.prev_7d * 0.2;
    const isAccelerating = row.last_7d > row.prev_7d * 1.5;
    const confidence = computeAsnClusterConfidence({
      threats: row.threats,
      campaigns: row.campaigns,
      brands: row.brands,
    });
    // Deterministic id from the natural key (normalised asn + threat_type).
    // Same format the pre-2026-09 random-UUID legacy rows are re-pointed to
    // (lib/cluster-retirement.ts legacyTargetClusterId).
    const clusterId = asnClusterId(row.asn, row.threat_type);
    const clusterName = generateClusterName({ asn: row.asn, threat_type: row.threat_type });
    const brandIds = splitList(row.brand_ids);

    try {
      await upsertCluster(db, {
        id: clusterId,
        name: clusterName,
        asns: [row.asn],
        countries,
        countryCounts,
        attackTypes: [row.threat_type],
        brandIds,
        providerIds: splitList(row.provider_ids),
        threatCount: row.threats,
        confidence,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        status: isPivoting ? "dormant" : "active",
        agentNotes: isPivoting ? "PIVOT DETECTED: activity dropped >80% in last 7 days"
          : isAccelerating ? "ACCELERATING: activity up >50% vs prior week"
          : null,
      }, true);
      out.clustersWritten++;

      // Stamp: mops up only threats no more-specific lane claimed. Matches
      // every raw spelling that normalised to this group key.
      const variants = parseJsonScalarArray(row.raw_asns);
      for (let i = 0; i < variants.length; i += ASN_STAMP_VARIANT_CHUNK) {
        const chunk = variants.slice(i, i + ASN_STAMP_VARIANT_CHUNK);
        await db.prepare(
          `UPDATE threats SET cluster_id = ?
            WHERE asn IN (${chunk.map(() => "?").join(", ")})
              AND threat_type = ? AND status = 'active' AND cluster_id IS NULL`,
        ).bind(clusterId, ...chunk, row.threat_type).run();
      }
    } catch {
      out.writeErrors++;
      continue;
    }

    // Dormancy pivot → Observer. The gate moved from `> 40` to the ASN
    // scale's ASN_PIVOT_MIN_CONFIDENCE now that ASN-only confidence is
    // capped at 40 (the old gate would never fire again).
    let pivotEmitted = false;
    if (isPivoting && confidence >= ASN_PIVOT_MIN_CONFIDENCE) {
      out.pivotsDetected++;
      try {
        await db.prepare(`
          INSERT INTO agent_events (id, event_type, source_agent, target_agent, payload_json, priority)
          VALUES (?, 'pivot_detected', 'nexus', 'observer', ?, 1)
        `).bind(
          crypto.randomUUID(),
          JSON.stringify(buildDormancyPivotPayload(clusterId, row.asn, clusterName)),
        ).run();
        pivotEmitted = true;
      } catch {
        out.writeErrors++;
      }
    }
    if (isAccelerating) out.accelerating++;

    out.clusters.push({
      clusterId, clusterName, asn: row.asn, threatType: row.threat_type,
      threats: row.threats, brandIds, confidence,
      last7d: row.last_7d, prev7d: row.prev_7d,
      isPivoting, isAccelerating, pivotEmitted,
    });
  }
  return out;
}

/** `cluster_asn_<asn>_<type>` — the ASN lane's deterministic id. */
export function asnClusterId(asn: string, threatType: string | null): string {
  return `cluster_asn_${slugifyKey(asn)}_${slugifyKey(threatType)}`;
}

// ─── Retire stale ASN / per-IP / subnet rows ──────────────────────────

export interface RetireResult {
  rowsScanned: number;
  markedSharedInfra: number;
  markedSuperseded: number;
}

/**
 * Decide whether an existing lane row should stop being an operation.
 * Pure — unit-tested. Returns the retired_reason to set (status is never
 * touched — lib/cluster-status.ts), or null to leave the row alone.
 *
 * Mirrors each lane's filter, so a row the lane would emit is never retired
 * (no retire / reactivate loop):
 *
 *   cluster_asn_*: superseded when its id is not the id the lane would now
 *     compute from its own (asn, type) — a row keyed on a malformed ASN
 *     string or a NULL / '' type, which the normalised lane can never
 *     refresh; shared_infra when its ASN is shared infrastructure (either
 *     set), its type is an IP-reputation type, or its brand fan-out exceeds
 *     ASN_MAX_BRAND_FANOUT.
 *   cluster_ip_*: shared_infra when its brand fan-out exceeds the hub
 *     threshold, its IP is a bogon / private address, or any of its ASNs is
 *     MULTI-TENANT. An IaaS ASN is NOT a reason: the per-IP lane keeps those.
 *   cluster_subnet_*: shared_infra when its brand fan-out exceeds the hub
 *     threshold, the /24 is bogon / private, or any of its ASNs is shared
 *     infrastructure (either set).
 */
export function decideLaneRowRetirement(row: {
  id: string;
  asns: string | null;
  attack_types: string | null;
  brand_fanout: number;
}): { retiredReason: ClusterRetiredReason; reason: string } | null {
  const fanoutRetire = (what: string): { retiredReason: ClusterRetiredReason; reason: string } => ({
    retiredReason: SHARED_INFRA_RETIRED_REASON,
    reason: `SHARED INFRA: ${what} serves ${row.brand_fanout} brands (> ${DEFAULT_HUB_FANOUT_THRESHOLD} hub threshold) — a landlord, not an operator.`,
  });
  if (row.id.startsWith("cluster_asn_")) {
    const asn = parseJsonAsnArray(row.asns)[0] ?? null;
    const type = parseJsonStringArray(row.attack_types)[0] ?? null;
    if (asn === null || type === null || asnClusterId(asn, type) !== row.id) {
      return {
        retiredReason: SUPERSEDED_RETIRED_REASON,
        reason: "SUPERSEDED: ASN cluster keyed on a malformed ASN or missing type; the normalised lane writes the canonical row.",
      };
    }
    if (SHARED_INFRA_ASNS.has(asn)) {
      return {
        retiredReason: SHARED_INFRA_RETIRED_REASON,
        reason: `SHARED INFRA: ASN-only evidence on ${asn} (shared infrastructure) is not operator evidence.`,
      };
    }
    if (IP_REPUTATION_THREAT_TYPES.includes(type)) {
      return {
        retiredReason: SHARED_INFRA_RETIRED_REASON,
        reason: `SHARED INFRA: ${type} sightings grouped by ASN are IP reputation, not an operation.`,
      };
    }
    if (row.brand_fanout > ASN_MAX_BRAND_FANOUT) return fanoutRetire(`ASN ${asn}`);
    return null;
  }
  if (row.id.startsWith("cluster_ip_")) {
    if (row.brand_fanout > DEFAULT_HUB_FANOUT_THRESHOLD) return fanoutRetire("IP");
    const ip = row.id.slice("cluster_ip_".length);
    if (isBogonIpv4(ip)) {
      return { retiredReason: SHARED_INFRA_RETIRED_REASON, reason: `SHARED INFRA: ${ip} is a bogon address (reserved / private range).` };
    }
    const shared = parseJsonAsnArray(row.asns).find((a) => MULTI_TENANT_ASNS.has(a));
    if (shared) {
      return {
        retiredReason: SHARED_INFRA_RETIRED_REASON,
        reason: `SHARED INFRA: IP on ${shared} (multi-tenant: one IP serves many unrelated sites).`,
      };
    }
    return null;
  }
  if (row.id.startsWith("cluster_subnet_")) {
    if (row.brand_fanout > DEFAULT_HUB_FANOUT_THRESHOLD) return fanoutRetire("/24");
    // Id is slugifyKey("a.b.c.") = "a_b_c" — rebuild a representative IP.
    const subnetIp = `${row.id.slice("cluster_subnet_".length).split("_").join(".")}.0`;
    if (isBogonIpv4(subnetIp)) {
      return { retiredReason: SHARED_INFRA_RETIRED_REASON, reason: `SHARED INFRA: ${subnetIp}/24 is a bogon / private range.` };
    }
    const shared = parseJsonAsnArray(row.asns).find((a) => SHARED_INFRA_ASNS.has(a));
    if (shared) {
      return {
        retiredReason: SHARED_INFRA_RETIRED_REASON,
        reason: `SHARED INFRA: /24 on ${shared} (shared infrastructure — a /24 there is many tenants).`,
      };
    }
  }
  return null;
}

/**
 * Retire existing ASN / per-IP / subnet rows that the reworked lanes no
 * longer emit (they would otherwise stay live forever with frozen counts and
 * keep reaching the Attributor, Observatory and Operations) by setting
 * retired_reason. `status` is never written here. Reads only the three id
 * ranges by PRIMARY KEY (`cluster_asn_*`, `cluster_ip_*`, `cluster_subnet_*`
 * — hundreds of rows), never the threats table. Idempotent: only rows with
 * retired_reason IS NULL are considered, so a rerun writes nothing. Threats still stamped to a retired
 * row are released by the bounded admin job (lib/cluster-retirement.ts), not
 * here, to keep the NEXUS run's write budget flat.
 */
export async function retireNonOperationalLaneClusters(db: D1Database): Promise<RetireResult> {
  const rows = (await db.prepare(
    `SELECT id, asns, attack_types,
            CASE WHEN json_valid(brand_ids) THEN json_array_length(brand_ids) ELSE 0 END AS brand_fanout
       FROM infrastructure_clusters
      WHERE ((id >= 'cluster_asn_' AND id < 'cluster_asn\`')
          OR (id >= 'cluster_ip_' AND id < 'cluster_ip\`')
          OR (id >= 'cluster_subnet_' AND id < 'cluster_subnet\`'))
        AND retired_reason IS NULL`,
  ).all<{ id: string; asns: string | null; attack_types: string | null; brand_fanout: number }>()).results ?? [];

  const result: RetireResult = { rowsScanned: rows.length, markedSharedInfra: 0, markedSuperseded: 0 };
  const stmts: D1PreparedStatement[] = [];
  for (const row of rows) {
    const decision = decideLaneRowRetirement(row);
    if (!decision) continue;
    stmts.push(db.prepare(
      `UPDATE infrastructure_clusters SET retired_reason = ?, agent_notes = ?
        WHERE id = ? AND retired_reason IS NULL`,
    ).bind(decision.retiredReason, decision.reason, row.id));
    if (decision.retiredReason === SUPERSEDED_RETIRED_REASON) result.markedSuperseded++;
    else result.markedSharedInfra++;
  }
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return result;
}

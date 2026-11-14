/**
 * DMARC source rollup — turns the NON-PASSING source IPs of one accepted
 * aggregate report into `dmarc_source_daily` rows (brand × UTC day × IP),
 * joined against what the platform already knows about each IP.
 *
 * Called by the receiver under ctx.waitUntil after the report is stored.
 * METADATA ONLY: never creates alerts, threats or triage decisions. The
 * class (`lib/dmarc-source-classify.ts`) is evidence for an analyst;
 * `spoof_candidate` is a candidate, not a finding.
 *
 * Per report (worst case, 200 failing IPs, all distinct ASNs):
 *   threats one-row-per-IP       3 statements (≤90 binds each)
 *   prior rollup ASN reuse       3
 *   ipinfo geo                   ≤50 HTTP lookups (batchGeoLookup caps 5
 *                                without IPINFO_TOKEN; monthly KV budget;
 *                                plus a per-day DMARC cap here)
 *   spamhaus_asn_drop            3
 *   hosting_providers by asn     3
 *   infrastructure_clusters PK   5 (≤400 candidate ids)
 *   dmarc_source_daily upserts   200 statements in 4 batches
 *   dmarc_report_records write-back  1
 * → 21 D1 calls, ≤221 statements. No GROUP BY over dmarc_report_records.
 */

import type { Env } from "../types";
import type { DmarcAggregateRecord } from "./dmarc-aggregate-xml";
import {
  DMARC_SOURCE_CLASS_RANK,
  explainDmarcSource,
  type DmarcRecordEvidence,
  type DmarcSourceClass,
  type DmarcSourceRule,
} from "./dmarc-source-classify";
import { asnKey } from "./shared-infra-asns";
import { batchGeoLookup, isPrivateIP } from "./geoip";
import { notRetiredClusterSql } from "./cluster-status";

export const DMARC_ROLLUP_LIMITS = {
  /** Failing source IPs rolled up per report (by failing volume). */
  maxIps: 200,
  /** IPs handed to batchGeoLookup per report. */
  maxGeoPerReport: 50,
  /** ipinfo lookups the DMARC rollup may spend per UTC day (all reports). */
  maxGeoPerDay: 1000,
  /** Binds per IN-list statement (D1 caps a statement at 100). */
  bindChunk: 90,
  /** Upsert statements per db.batch. */
  batchSize: 50,
  /** Reporter names kept per row. */
  maxReporters: 20,
} as const;

export interface DmarcRollupInput {
  brandId: string;
  /** 'YYYY-MM-DD' UTC report day. */
  date: string;
  reporterOrg: string;
  /** dmarc_reports.id of the stored report (for the records write-back). */
  reportRowId: number;
  /** Report range as ISO timestamps. */
  firstSeen: string;
  lastSeen: string;
  records: DmarcAggregateRecord[];
}

export interface DmarcRollupResult {
  ips: number;
  upserted: number;
  geoLookups: number;
  byClass: Record<DmarcSourceClass, number>;
}

/** policy_evaluated → evidence ('pass' | 'fail'). */
function aligned(r: string): "pass" | "fail" {
  return r === "pass" ? "pass" : "fail";
}

export function recordDmarcPassed(r: Pick<DmarcAggregateRecord, "dkim_result" | "spf_result">): boolean {
  return r.dkim_result === "pass" || r.spf_result === "pass";
}

/** Evidence for one record (asn resolved by the caller). */
export function recordEvidence(r: DmarcAggregateRecord, asn: string | null): DmarcRecordEvidence {
  const spf = r.spf_auth.find((s) => s.scope === "mfrom") ?? r.spf_auth[0] ?? null;
  return {
    headerFrom: r.header_from,
    dkimAligned: aligned(r.dkim_result),
    spfAligned: aligned(r.spf_result),
    dkimAuth: r.dkim_auth.map((d) => ({ domain: d.domain, result: d.result })),
    spfAuth: spf ? { domain: spf.domain, result: spf.result } : null,
    asn,
    overrideReasons: r.reasons,
  };
}

/** `cluster_ip_<ip>` exactly as the NEXUS per-IP lane builds it. */
export function clusterIdForIp(ip: string): string {
  return `cluster_ip_${ip.replace(/[^0-9a-f.:]/gi, "")}`;
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const ph = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** SQL rank of a class column — built from the classifier's own constant
 *  so the SQL merge agrees with mergeDmarcSourceClass. Keys are code
 *  literals, validated before interpolation. */
function classRankSql(col: string): string {
  const arms = Object.entries(DMARC_SOURCE_CLASS_RANK).map(([k, v]) => {
    if (!/^[a-z_]+$/.test(k) || !Number.isInteger(v)) throw new Error(`classRankSql: bad entry ${k}`);
    return `WHEN '${k}' THEN ${v}`;
  });
  return `(CASE ${col} ${arms.join(" ")} ELSE -1 END)`;
}

const RANK_NEW = classRankSql("excluded.source_class");
const RANK_OLD = classRankSql("dmarc_source_daily.source_class");

/** The upsert. Accumulates volume, merges the class by rank (ties keep
 *  the stored one — identical to mergeDmarcSourceClass), unions reporters,
 *  keeps first_seen / bumps last_seen, never blanks a resolved field. */
export const DMARC_SOURCE_DAILY_UPSERT_SQL = `INSERT INTO dmarc_source_daily
  (brand_id, date, source_ip, messages, fail_messages, source_class, source_rule,
   reporters, dkim_domain, envelope_from, asn, as_org, country_code,
   hosting_provider_id, cluster_id, asn_drop_listed, first_seen, last_seen)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(brand_id, date, source_ip) DO UPDATE SET
  messages      = dmarc_source_daily.messages + excluded.messages,
  fail_messages = dmarc_source_daily.fail_messages + excluded.fail_messages,
  source_class  = CASE WHEN ${RANK_NEW} > ${RANK_OLD} THEN excluded.source_class ELSE dmarc_source_daily.source_class END,
  source_rule   = CASE WHEN ${RANK_NEW} > ${RANK_OLD} THEN excluded.source_rule ELSE dmarc_source_daily.source_rule END,
  reporters     = (SELECT json_group_array(value) FROM (
                     SELECT value FROM json_each(COALESCE(dmarc_source_daily.reporters, '[]'))
                     UNION SELECT value FROM json_each(COALESCE(excluded.reporters, '[]'))
                     LIMIT ${DMARC_ROLLUP_LIMITS.maxReporters})),
  dkim_domain   = COALESCE(excluded.dkim_domain, dmarc_source_daily.dkim_domain),
  envelope_from = COALESCE(excluded.envelope_from, dmarc_source_daily.envelope_from),
  asn           = COALESCE(excluded.asn, dmarc_source_daily.asn),
  as_org        = COALESCE(excluded.as_org, dmarc_source_daily.as_org),
  country_code  = COALESCE(excluded.country_code, dmarc_source_daily.country_code),
  hosting_provider_id = COALESCE(excluded.hosting_provider_id, dmarc_source_daily.hosting_provider_id),
  cluster_id    = COALESCE(excluded.cluster_id, dmarc_source_daily.cluster_id),
  asn_drop_listed = MAX(dmarc_source_daily.asn_drop_listed, excluded.asn_drop_listed),
  first_seen    = MIN(dmarc_source_daily.first_seen, excluded.first_seen),
  last_seen     = MAX(dmarc_source_daily.last_seen, excluded.last_seen)`;

/**
 * One threats row per IP, chosen deterministically: the first entry of
 * idx_threats_ip_source_feed (ip_address, source_feed) — i.e. lowest
 * source_feed, then lowest rowid. That index's own order satisfies the
 * ORDER BY, so each IP costs one index seek and no sort, even for a hub IP
 * with thousands of rows. (idx_threats_ip from migration 0001 was dropped
 * by 0013's threats rebuild and is not pinnable.)
 */
export function threatsByIpSql(n: number): string {
  return `WITH v(ip) AS (VALUES ${Array.from({ length: n }, () => "(?)").join(", ")})
SELECT v.ip AS ip, t.asn AS asn, t.hosting_provider_id AS hosting_provider_id,
       t.cluster_id AS cluster_id, t.country_code AS country_code
FROM v JOIN threats t ON t.rowid = (
  SELECT t2.rowid FROM threats t2
  WHERE t2.ip_address = v.ip ORDER BY t2.source_feed, t2.rowid LIMIT 1)`;
}

interface IpAgg {
  ip: string;
  messages: number;
  fail: number;
  failing: DmarcAggregateRecord[];
  largestFail: DmarcAggregateRecord | null;
}

interface IpIntel {
  asn: string | null;
  asOrg: string | null;
  country: string | null;
  providerId: string | null;
  threatClusterId: string | null;
}

async function reserveGeoBudget(env: Env, date: string, want: number): Promise<number> {
  if (want <= 0) return 0;
  const key = `dmarc:geo_used:${date}`;
  try {
    const used = parseInt((await env.CACHE.get(key)) ?? "0", 10) || 0;
    const grant = Math.max(0, Math.min(want, DMARC_ROLLUP_LIMITS.maxGeoPerDay - used));
    if (grant > 0) await env.CACHE.put(key, String(used + grant), { expirationTtl: 2 * 86400 });
    return grant;
  } catch {
    return 0; // no KV → no paid lookups
  }
}

/** Roll one report's failing sources into dmarc_source_daily. */
export async function runDmarcSourceRollup(env: Env, input: DmarcRollupInput): Promise<DmarcRollupResult> {
  const db = env.DB;
  const byClass: Record<DmarcSourceClass, number> = { aligned_pass: 0, forwarder_likely: 0, unaligned_shared_esp: 0, spoof_candidate: 0 };

  // 1. Per-IP volume; keep the failing records for classification.
  const agg = new Map<string, IpAgg>();
  for (const r of input.records) {
    let a = agg.get(r.source_ip);
    if (!a) {
      a = { ip: r.source_ip, messages: 0, fail: 0, failing: [], largestFail: null };
      agg.set(r.source_ip, a);
    }
    a.messages += r.message_count;
    if (!recordDmarcPassed(r)) {
      a.fail += r.message_count;
      a.failing.push(r);
      if (!a.largestFail || r.message_count > a.largestFail.message_count) a.largestFail = r;
    }
  }
  const ips = [...agg.values()]
    .filter((a) => a.fail > 0)
    .sort((x, y) => y.fail - x.fail || (x.ip < y.ip ? -1 : 1))
    .slice(0, DMARC_ROLLUP_LIMITS.maxIps);
  if (ips.length === 0) return { ips: 0, upserted: 0, geoLookups: 0, byClass };

  const intel = new Map<string, IpIntel>();
  for (const a of ips) intel.set(a.ip, { asn: null, asOrg: null, country: null, providerId: null, threatClusterId: null });
  const ipList = ips.map((a) => a.ip);

  // 2. What the threats table knows (one row per IP, deterministic).
  for (const chunk of chunks(ipList, DMARC_ROLLUP_LIMITS.bindChunk)) {
    const rows = await db.prepare(threatsByIpSql(chunk.length)).bind(...chunk).all<{
      ip: string; asn: string | null; hosting_provider_id: string | null; cluster_id: string | null; country_code: string | null;
    }>();
    for (const r of rows.results ?? []) {
      const i = intel.get(r.ip);
      if (!i) continue;
      i.asn = asnKey(r.asn);
      i.providerId = r.hosting_provider_id;
      i.threatClusterId = r.cluster_id;
      i.country = r.country_code;
    }
  }

  // 3. Reuse an ASN this brand's rollup already resolved in the last 7 days.
  const since = new Date(Date.parse(`${input.date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const needAsn = ipList.filter((ip) => intel.get(ip)!.asn === null);
  for (const chunk of chunks(needAsn, DMARC_ROLLUP_LIMITS.bindChunk - 2)) {
    const rows = await db.prepare(
      `SELECT source_ip, asn, as_org, country_code FROM dmarc_source_daily
       WHERE brand_id = ? AND source_ip IN (${ph(chunk.length)}) AND date >= ? AND asn IS NOT NULL
       ORDER BY date DESC`,
    ).bind(input.brandId, ...chunk, since).all<{ source_ip: string; asn: string; as_org: string | null; country_code: string | null }>();
    for (const r of rows.results ?? []) {
      const i = intel.get(r.source_ip);
      if (!i || i.asn !== null) continue;
      i.asn = asnKey(r.asn);
      i.asOrg = r.as_org;
      i.country = i.country ?? r.country_code;
    }
  }

  // 4. ipinfo for what is still unknown — bounded per report and per day.
  let geoLookups = 0;
  const geoWanted = ipList
    .filter((ip) => intel.get(ip)!.asn === null && !ip.includes(":") && !isPrivateIP(ip))
    .slice(0, DMARC_ROLLUP_LIMITS.maxGeoPerReport);
  const grant = await reserveGeoBudget(env, input.date, geoWanted.length);
  if (grant > 0) {
    const { results, attempted } = await batchGeoLookup(geoWanted.slice(0, grant), env.CACHE, env.IPINFO_TOKEN);
    geoLookups = attempted.size;
    for (const [ip, g] of results) {
      const i = intel.get(ip);
      if (!i) continue;
      i.asn = asnKey(g.as);
      i.asOrg = g.org;
      i.country = i.country ?? g.countryCode;
    }
  }

  // 5. ASN-keyed reference data.
  const asns = [...new Set([...intel.values()].map((i) => i.asn).filter((a): a is string => a !== null))];
  const dropListed = new Set<string>();
  const providerByAsn = new Map<string, { id: string; name: string }>();
  for (const chunk of chunks(asns, DMARC_ROLLUP_LIMITS.bindChunk)) {
    const drop = await db.prepare(
      `SELECT asn FROM spamhaus_asn_drop WHERE asn IN (${ph(chunk.length)}) AND removed_at IS NULL`,
    ).bind(...chunk).all<{ asn: string }>();
    for (const r of drop.results ?? []) dropListed.add(r.asn);
    const prov = await db.prepare(
      `SELECT id, name, asn FROM hosting_providers WHERE asn IN (${ph(chunk.length)})`,
    ).bind(...chunk).all<{ id: string; name: string; asn: string }>();
    for (const r of prov.results ?? []) providerByAsn.set(r.asn, { id: r.id, name: r.name });
  }

  // 6. Live NEXUS clusters: the per-IP cluster by PK, else the threat's stamp.
  const clusterCandidates = new Set<string>();
  for (const ip of ipList) {
    clusterCandidates.add(clusterIdForIp(ip));
    const t = intel.get(ip)!.threatClusterId;
    if (t) clusterCandidates.add(t);
  }
  const liveClusters = new Set<string>();
  for (const chunk of chunks([...clusterCandidates], DMARC_ROLLUP_LIMITS.bindChunk)) {
    const rows = await db.prepare(
      `SELECT id FROM infrastructure_clusters WHERE id IN (${ph(chunk.length)}) AND ${notRetiredClusterSql()}`,
    ).bind(...chunk).all<{ id: string }>();
    for (const r of rows.results ?? []) liveClusters.add(r.id);
  }

  // 7. Classify + upsert.
  const reporters = JSON.stringify(input.reporterOrg ? [input.reporterOrg] : []);
  const stmts: D1PreparedStatement[] = [];
  for (const a of ips) {
    const i = intel.get(a.ip)!;
    let cls: DmarcSourceClass = "aligned_pass";
    let rule: DmarcSourceRule = "R1_dmarc_pass";
    let first = true;
    for (const r of a.failing) {
      const e = explainDmarcSource(recordEvidence(r, i.asn));
      // Same total order as mergeDmarcSourceClass; the rule follows the class.
      if (first || DMARC_SOURCE_CLASS_RANK[e.cls] > DMARC_SOURCE_CLASS_RANK[cls]) {
        cls = e.cls;
        rule = e.rule;
        first = false;
      }
    }
    byClass[cls] += 1;
    const provider = i.providerId ? null : i.asn ? providerByAsn.get(i.asn) ?? null : null;
    const ipCluster = clusterIdForIp(a.ip);
    const clusterId = liveClusters.has(ipCluster)
      ? ipCluster
      : i.threatClusterId && liveClusters.has(i.threatClusterId) ? i.threatClusterId : null;
    const big = a.largestFail;
    stmts.push(db.prepare(DMARC_SOURCE_DAILY_UPSERT_SQL).bind(
      input.brandId, input.date, a.ip, a.messages, a.fail, cls, rule, reporters,
      big?.dkim_auth[0]?.domain || null,
      big?.envelope_from || null,
      i.asn,
      i.asOrg ?? (i.asn ? providerByAsn.get(i.asn)?.name ?? null : null),
      i.country ? i.country.slice(0, 8) : null,
      i.providerId ?? provider?.id ?? null,
      clusterId,
      i.asn && dropListed.has(i.asn) ? 1 : 0,
      input.firstSeen, input.lastSeen,
    ));
  }
  for (const batch of chunks(stmts, DMARC_ROLLUP_LIMITS.batchSize)) await db.batch(batch);

  // 8. Write what we resolved back onto this report's records, so
  //    Cartographer's Phase 4 (country_code IS NULL) doesn't spend ipinfo
  //    on the same IPs again. One statement; json_each bind.
  const resolved = ips
    .map((a) => ({ ip: a.ip, ...intel.get(a.ip)! }))
    .filter((x) => x.asn !== null || x.country !== null)
    .map((x) => ({ ip: x.ip, asn: x.asn, org: x.asOrg, cc: x.country }));
  if (resolved.length > 0) {
    const pick = (field: string): string =>
      `(SELECT json_extract(j.value, '$.${field}') FROM json_each(?2) j WHERE json_extract(j.value, '$.ip') = dmarc_report_records.source_ip)`;
    await db.prepare(
      `UPDATE dmarc_report_records SET
         asn = COALESCE(asn, ${pick("asn")}),
         org = COALESCE(org, ${pick("org")}),
         country_code = COALESCE(country_code, ${pick("cc")})
       WHERE report_id = ?1 AND country_code IS NULL`,
    ).bind(input.reportRowId, JSON.stringify(resolved)).run();
  }

  return { ips: ips.length, upserted: stmts.length, geoLookups, byClass };
}

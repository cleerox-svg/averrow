/**
 * DMARC source rollup — turns the NON-PASSING source IPs of one stored
 * aggregate report into `dmarc_source_daily` rows (brand × UTC day × IP),
 * joined against what the platform already knows about each IP.
 *
 * METADATA ONLY: never creates alerts, threats or triage decisions. The
 * class (`lib/dmarc-source-classify.ts`) is evidence for an analyst;
 * `spoof_candidate` is a candidate, not a finding.
 *
 * Atomic and re-runnable (B4c): every dmarc_source_daily upsert AND the
 * report's `rolled_up_at` stamp go out in ONE db.batch, and each upsert is
 * guarded on `rolled_up_at IS NULL` for that report — so a report is
 * either fully rolled up or not at all, and a second run (retry, the
 * receiver's waitUntil racing the Navigator catch-up) changes nothing.
 * Reports whose rollup never landed are picked up by
 * runDmarcRollupCatchUp (Navigator, every tick, ≤3 per tick).
 *
 * ipinfo (B2): only for VERIFIED reports on the email path, never for a
 * reserved / private / documentation range, ≤50 per report, ≤150 per UTC
 * wall-clock day for all DMARC rollups, under a hard wall-clock cap; it
 * draws on the platform-wide ipinfo budget. The catch-up never calls it.
 * An IP nothing resolves keeps asn NULL (the classifier then cannot call
 * it shared infrastructure).
 *
 * Per report, worst case (200 failing IPs, all distinct ASNs): threats 3,
 * prior-rollup reuse 3, spamhaus 3, providers 3, clusters 5 reads, then one
 * batch of 40 five-row upserts + 1 stamp → 17 reads + 1 batch (41
 * statements). Nothing is written back to dmarc_report_records (S4).
 */

import type { Env } from "../types";
import { decodeRecordAuth, dmarcReportDay, dmarcReportEpochIso, type DmarcAggregateRecord } from "./dmarc-aggregate-xml";
import {
  DMARC_SOURCE_CLASS_RANK,
  explainDmarcSource,
  isBrandRelatedDomain,
  type DmarcRecordEvidence,
  type DmarcSourceClass,
  type DmarcSourceRule,
} from "./dmarc-source-classify";
import { asnKey } from "./shared-infra-asns";
import { batchGeoLookup, isPrivateIP } from "./geoip";
import { isBogonIpv4 } from "./nexus-threat-lanes";
import { notRetiredClusterSql } from "./cluster-status";
import { withD1Retry, D1_OVERLOAD_RETRY_BASE_MS } from "./d1-retry";

export const DMARC_ROLLUP_LIMITS = {
  /** Failing source IPs rolled up per report (by failing volume). */
  maxIps: 200,
  /** IPs looked up on ipinfo per report. */
  maxGeoPerReport: 50,
  /** ipinfo lookups all DMARC rollups may spend per UTC wall-clock day. */
  maxGeoPerDay: 150,
  /** Wall-clock budget for the ipinfo phase of one rollup. */
  geoWallClockMs: 8_000,
  /** IPs per batchGeoLookup call (the deadline is checked between calls). */
  geoChunk: 5,
  /** Binds per IN-list statement (D1 caps a statement at 100). */
  bindChunk: 90,
  /** Rows per multi-row upsert: 19 columns × 5 + 1 = 96 binds. */
  rowsPerUpsert: 5,
  /** Reporter names kept per row. */
  maxReporters: 20,
  /** Messages kept per IP per report. */
  maxIpMessages: 50_000_000,
} as const;

export interface DmarcRollupInput {
  reportRowId: number;
  brandId: string;
  /** 'YYYY-MM-DD' UTC report day. */
  date: string;
  reporterOrg: string;
  verified: boolean;
  /** Report range as clamped ISO timestamps. */
  firstSeen: string;
  lastSeen: string;
  records: DmarcAggregateRecord[];
}

export interface DmarcRollupResult {
  ips: number;
  /** True when this run's batch stamped rolled_up_at (false: already rolled up). */
  applied: boolean;
  geoLookups: number;
  byClass: Record<DmarcSourceClass, number>;
}

export function recordDmarcPassed(r: Pick<DmarcAggregateRecord, "dkim_result" | "spf_result">): boolean {
  return r.dkim_result === "pass" || r.spf_result === "pass";
}

/** policy_evaluated → evidence ('pass' | 'fail'). */
function aligned(r: string): "pass" | "fail" {
  return r === "pass" ? "pass" : "fail";
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

/** The DKIM d= worth storing (S6): a passing signature first, then a
 *  brand-related one, then the first. */
export function pickDkimDomain(r: Pick<DmarcAggregateRecord, "dkim_auth" | "header_from">): string | null {
  const sigs = r.dkim_auth;
  return (sigs.find((d) => d.result === "pass")
    ?? sigs.find((d) => r.header_from !== "" && isBrandRelatedDomain(d.domain, r.header_from))
    ?? sigs[0])?.domain ?? null;
}

/** `cluster_ip_<ip>` exactly as the NEXUS per-IP lane builds it. */
export function clusterIdForIp(ip: string): string {
  return `cluster_ip_${ip.replace(/[^0-9a-f.:]/gi, "")}`;
}

/**
 * Never worth an ipinfo lookup: private / CGNAT / loopback / link-local /
 * multicast (lib/geoip isPrivateIP, NEXUS isBogonIpv4) plus the
 * documentation and benchmarking ranges neither of those covers
 * (192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24). IPv6 is never sent
 * to ipinfo here (batchGeoLookup's private filter is IPv4-only).
 */
export function isReservedForGeo(ip: string): boolean {
  if (ip.includes(":")) return true;
  if (isPrivateIP(ip) || isBogonIpv4(ip)) return true;
  return ip.startsWith("192.0.2.") || ip.startsWith("198.51.100.") || ip.startsWith("203.0.113.")
    || ip.startsWith("198.18.") || ip.startsWith("198.19.");
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
const UPSERT_COLUMNS = 19;

/**
 * Multi-row upsert for `n` rows, guarded on the report not being rolled up
 * yet (last bind = report id). Accumulates volume, merges the class by
 * rank (ties keep the stored one — identical to mergeDmarcSourceClass),
 * unions reporters, keeps first_seen / bumps last_seen, never blanks a
 * resolved field.
 */
export function dmarcSourceDailyUpsertSql(n: number): string {
  const row = `(${ph(UPSERT_COLUMNS)})`;
  return `INSERT INTO dmarc_source_daily
  (brand_id, date, source_ip, messages, fail_messages, verified_fail_messages, source_class, source_rule,
   reporters, dkim_domain, envelope_from, asn, as_org, country_code,
   hosting_provider_id, cluster_id, asn_drop_listed, first_seen, last_seen)
SELECT * FROM (VALUES ${Array.from({ length: n }, () => row).join(", ")})
WHERE EXISTS (SELECT 1 FROM dmarc_reports WHERE id = ? AND rolled_up_at IS NULL)
ON CONFLICT(brand_id, date, source_ip) DO UPDATE SET
  messages      = dmarc_source_daily.messages + excluded.messages,
  fail_messages = dmarc_source_daily.fail_messages + excluded.fail_messages,
  verified_fail_messages = dmarc_source_daily.verified_fail_messages + excluded.verified_fail_messages,
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
}

export const DMARC_ROLLUP_STAMP_SQL =
  "UPDATE dmarc_reports SET rolled_up_at = datetime('now') WHERE id = ? AND rolled_up_at IS NULL";

/**
 * One threats row per IP, chosen deterministically: the first entry of
 * idx_threats_ip_source_feed (ip_address, source_feed) — lowest
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

/** Reserve up to `want` ipinfo lookups against today's (wall-clock UTC)
 *  DMARC allowance. KV error → 0 (no paid lookups). */
export async function reserveDmarcGeoBudget(env: Env, want: number, nowMs = Date.now()): Promise<number> {
  if (want <= 0) return 0;
  const key = `dmarc:geo_used:${new Date(nowMs).toISOString().slice(0, 10)}`;
  try {
    const used = parseInt((await env.CACHE.get(key)) ?? "0", 10) || 0;
    const grant = Math.max(0, Math.min(want, DMARC_ROLLUP_LIMITS.maxGeoPerDay - used));
    if (grant > 0) await env.CACHE.put(key, String(used + grant), { expirationTtl: 2 * 86400 });
    return grant;
  } catch {
    return 0;
  }
}

export interface DmarcRollupOptions {
  /** Allow ipinfo lookups (email path + verified report only). */
  geo: boolean;
  nowMs?: number;
}

/** Roll one stored report's failing sources into dmarc_source_daily. */
export async function runDmarcSourceRollup(env: Env, input: DmarcRollupInput, opts: DmarcRollupOptions): Promise<DmarcRollupResult> {
  const db = env.DB;
  const nowMs = opts.nowMs ?? Date.now();
  const byClass: Record<DmarcSourceClass, number> = { aligned_pass: 0, forwarder_likely: 0, unaligned_shared_esp: 0, spoof_candidate: 0 };

  // 1. Per-IP volume; keep the failing records for classification.
  const agg = new Map<string, IpAgg>();
  for (const r of input.records) {
    let a = agg.get(r.source_ip);
    if (!a) {
      a = { ip: r.source_ip, messages: 0, fail: 0, failing: [], largestFail: null };
      agg.set(r.source_ip, a);
    }
    a.messages = Math.min(a.messages + r.message_count, DMARC_ROLLUP_LIMITS.maxIpMessages);
    if (!recordDmarcPassed(r)) {
      a.fail = Math.min(a.fail + r.message_count, DMARC_ROLLUP_LIMITS.maxIpMessages);
      a.failing.push(r);
      if (!a.largestFail || r.message_count > a.largestFail.message_count) a.largestFail = r;
    }
  }
  const ips = [...agg.values()]
    .filter((a) => a.fail > 0)
    .sort((x, y) => y.fail - x.fail || (x.ip < y.ip ? -1 : 1))
    .slice(0, DMARC_ROLLUP_LIMITS.maxIps);

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

  // 4. ipinfo for what is still unknown — verified reports on the email
  //    path only; bounded per report, per wall-clock day, and in time.
  let geoLookups = 0;
  if (opts.geo && input.verified) {
    const wanted = ipList
      .filter((ip) => intel.get(ip)!.asn === null && !isReservedForGeo(ip))
      .slice(0, DMARC_ROLLUP_LIMITS.maxGeoPerReport);
    const grant = await reserveDmarcGeoBudget(env, wanted.length, nowMs);
    const deadline = Date.now() + DMARC_ROLLUP_LIMITS.geoWallClockMs;
    for (const chunk of chunks(wanted.slice(0, grant), DMARC_ROLLUP_LIMITS.geoChunk)) {
      if (Date.now() >= deadline) break;
      const { results, attempted } = await batchGeoLookup(chunk, env.CACHE, env.IPINFO_TOKEN);
      geoLookups += attempted.size;
      for (const [ip, g] of results) {
        const i = intel.get(ip);
        if (!i) continue;
        i.asn = asnKey(g.as);
        i.asOrg = g.org;
        i.country = i.country ?? g.countryCode;
      }
      if (attempted.size < chunk.length) break; // quota / rate limit hit
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

  // 7. Classify; build the rows.
  const reporters = JSON.stringify(input.reporterOrg ? [input.reporterOrg] : []);
  const rows: Array<Array<string | number | null>> = [];
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
    const ipCluster = clusterIdForIp(a.ip);
    const clusterId = liveClusters.has(ipCluster)
      ? ipCluster
      : i.threatClusterId && liveClusters.has(i.threatClusterId) ? i.threatClusterId : null;
    const big = a.largestFail;
    const provider = i.asn ? providerByAsn.get(i.asn) ?? null : null;
    rows.push([
      input.brandId, input.date, a.ip, a.messages, a.fail, input.verified ? a.fail : 0, cls, rule, reporters,
      big ? pickDkimDomain(big) : null,
      big?.envelope_from || null,
      i.asn,
      i.asOrg ?? provider?.name ?? null,
      i.country ? i.country.slice(0, 8) : null,
      i.providerId ?? provider?.id ?? null,
      clusterId,
      i.asn && dropListed.has(i.asn) ? 1 : 0,
      input.firstSeen, input.lastSeen,
    ]);
  }

  // 8. ONE batch: every upsert (guarded on rolled_up_at IS NULL) + the stamp.
  const stmts: D1PreparedStatement[] = chunks(rows, DMARC_ROLLUP_LIMITS.rowsPerUpsert).map((c) =>
    db.prepare(dmarcSourceDailyUpsertSql(c.length)).bind(...c.flat(), input.reportRowId));
  stmts.push(db.prepare(DMARC_ROLLUP_STAMP_SQL).bind(input.reportRowId));
  const results = await withD1Retry(() => db.batch(stmts), { overloadBaseMs: D1_OVERLOAD_RETRY_BASE_MS, label: "dmarc-rollup" });
  const applied = (results[results.length - 1]?.meta?.changes ?? 0) > 0;

  return { ips: ips.length, applied, geoLookups, byClass };
}

// ─── Catch-up (Navigator) ───────────────────────────────────────────────

export const DMARC_ROLLUP_CATCHUP_LIMIT = 3;
/** A report this fresh may still be rolling up under the email handler's
 *  waitUntil — leave it alone. */
export const DMARC_ROLLUP_CATCHUP_MIN_AGE = "-5 minutes";

/** Pending probe — served by the partial idx_dmarc_reports_rollup_pending. */
export const DMARC_ROLLUP_PENDING_SQL = `SELECT id FROM dmarc_reports
  WHERE processed = 1 AND rolled_up_at IS NULL AND received_at < datetime('now', ?)
  ORDER BY received_at LIMIT ?`;

function sqliteTsMs(ts: string | null): number {
  if (!ts) return Date.now();
  const ms = Date.parse(ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? ms : Date.now();
}

/** Re-run the rollup of one stored report from its dmarc_report_records
 *  (no ipinfo). Null when the report is gone or already rolled up. */
export async function rollupStoredDmarcReport(env: Env, reportId: number): Promise<DmarcRollupResult | null> {
  const db = env.DB;
  const rep = await db.prepare(
    `SELECT id, brand_id, reporter_org, date_begin, date_end, verified, received_at, rolled_up_at
     FROM dmarc_reports WHERE id = ?`,
  ).bind(reportId).first<{
    id: number; brand_id: string | null; reporter_org: string | null; date_begin: string | null; date_end: string | null;
    verified: number; received_at: string | null; rolled_up_at: string | null;
  }>();
  if (!rep || rep.rolled_up_at !== null || !rep.brand_id) return null;
  const recs = await db.prepare(
    `SELECT source_ip, count, disposition, dkim_result, spf_result, header_from, envelope_from, auth_json
     FROM dmarc_report_records WHERE report_id = ?`,
  ).bind(reportId).all<{
    source_ip: string; count: number | null; disposition: string | null; dkim_result: string | null; spf_result: string | null;
    header_from: string | null; envelope_from: string | null; auth_json: string | null;
  }>();
  const receivedMs = sqliteTsMs(rep.received_at);
  const begin = parseInt(rep.date_begin ?? "0", 10) || 0;
  const end = parseInt(rep.date_end ?? "0", 10) || 0;
  const records: DmarcAggregateRecord[] = (recs.results ?? []).map((r) => ({
    source_ip: r.source_ip,
    message_count: Math.max(0, r.count ?? 0),
    disposition: r.disposition ?? "",
    dkim_result: r.dkim_result ?? "",
    spf_result: r.spf_result ?? "",
    header_from: r.header_from ?? "",
    envelope_from: r.envelope_from ?? "",
    envelope_to: "",
    ...decodeRecordAuth(r.auth_json),
  }));
  return runDmarcSourceRollup(env, {
    reportRowId: rep.id,
    brandId: rep.brand_id,
    date: dmarcReportDay(begin, end, receivedMs),
    reporterOrg: rep.reporter_org ?? "",
    verified: rep.verified === 1,
    firstSeen: dmarcReportEpochIso(begin, receivedMs),
    lastSeen: dmarcReportEpochIso(end, receivedMs),
    records,
  }, { geo: false, nowMs: receivedMs });
}

export interface DmarcRollupCatchUpResult {
  pending: number;
  rolledUp: number;
  error: string | null;
}

/** Navigator, every tick: one indexed probe; ≤3 stranded reports rolled up. */
export async function runDmarcRollupCatchUp(env: Env, limit = DMARC_ROLLUP_CATCHUP_LIMIT): Promise<DmarcRollupCatchUpResult> {
  const out: DmarcRollupCatchUpResult = { pending: 0, rolledUp: 0, error: null };
  try {
    const rows = await env.DB.prepare(DMARC_ROLLUP_PENDING_SQL).bind(DMARC_ROLLUP_CATCHUP_MIN_AGE, limit).all<{ id: number }>();
    const ids = (rows.results ?? []).map((r) => r.id);
    out.pending = ids.length;
    for (const id of ids) {
      const r = await rollupStoredDmarcReport(env, id);
      if (r?.applied) out.rolledUp++;
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

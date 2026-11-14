/**
 * DMARC RUA intake gates — which brands may have aggregate reports stored,
 * the brand lookup for a report's policy domain, ingest rate caps, and the
 * drop counters diagnostics reads.
 *
 * Anyone can email forged aggregate XML to the RUA address, so a report is
 * stored ONLY when all of these hold (each failure is a counted drop):
 *   no_brand          the policy domain (or a parent) is a brand's
 *                     canonical_domain (indexed IN lookup);
 *   ineligible_brand  the brand is tier monitored / customer, its
 *                     canonical domain passes the platform's trusted-brand
 *                     rule (TRUSTED_BRAND_CANONICAL_SQL, lib/safeDomains.ts:
 *                     source not public_assess / self_service /
 *                     ai_attributed AND (tier customer OR source manual /
 *                     curated OR tranco_rank ≤ 20000)), and it is not / not
 *                     under a shared-hosting domain. Otherwise anyone could
 *                     create a brand for a domain they control (or the
 *                     analyst agent's NULL-source brand for a PHISHING
 *                     domain, promoted to `monitored` by migration 0156),
 *                     publish our rua and drive writes (appsec M1);
 *   unenrolled        the brand's CANONICAL domain's own `_dmarc` record
 *                     names our RUA address (scan or live DNS, re-verified
 *                     after ENROLLMENT_REVERIFY_DAYS);
 *   rate_limited      D1 counters (dmarc_rate_counters), keyed on
 *                     wall-clock UTC time and split by provenance so forged
 *                     (unverified) mail can't starve real reporters:
 *                     ≤ DMARC_BRAND_DAILY_CAP per brand per day and
 *                     ≤ DMARC_GLOBAL_HOURLY_CAP per hour, each per class.
 *                     A counter that can't be written DENIES.
 */

import type { Env } from "../types";
import { dohTxtLookupDetailed } from "./doh";
import { parseDmarcRecord } from "./dmarc-record";
import { isRuaAuthorizationRequired, ruaAuthorizationRecordName, ruaIncludesAverrow } from "./dmarc-rua";
import { TRUSTED_BRAND_CANONICAL_SQL, isUnderSharedHosting } from "./safeDomains";
import { withD1Retry } from "./d1-retry";

export const ENROLLMENT_REVERIFY_DAYS = 30;
export const SCAN_FRESH_DAYS = 7;
/** Live `_dmarc` verdict cache when the record names us. */
export const RUA_LIVE_POSITIVE_TTL_S = 6 * 3600;
/** Live verdict cache for a negative answer (record without our rua, or no
 *  record). Never cached: a resolver failure. */
export const RUA_LIVE_NEGATIVE_TTL_S = 30 * 60;
/** Report-authorization record cache (setup endpoint). */
export const RUA_AUTH_OK_TTL_S = 24 * 3600;
export const RUA_AUTH_MISSING_TTL_S = 3600;
/** Parent-domain candidates tried for a subdomain policy domain. */
const MAX_PARENT_CANDIDATES = 4;

/** Stored reports per brand per UTC day, per provenance class. */
export const DMARC_BRAND_DAILY_CAP = { verified: 50, unverified: 50 } as const;
/**
 * Stored reports per UTC hour, all brands, per provenance class. Sized so
 * the retention sweep keeps up (lib/dmarc-retention.ts): ≤ 4,800 verified
 * + 1,200 unverified reports a day.
 */
export const DMARC_GLOBAL_HOURLY_CAP = { verified: 200, unverified: 50 } as const;

export interface DmarcBrand {
  id: string;
  canonical_domain: string;
  tier: string | null;
  /** TRUSTED_BRAND_CANONICAL_SQL evaluated for the row (1 / 0). */
  trusted: number;
}

/** SELECT list for a `brands b` row as a DmarcBrand. */
export const DMARC_BRAND_COLUMNS_SQL =
  `b.id AS id, b.canonical_domain AS canonical_domain, b.tier AS tier, (${TRUSTED_BRAND_CANONICAL_SQL}) AS trusted`;

/** Lowercased, trailing dot and a leading `www.` removed. */
export function normalizePolicyDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

/**
 * The policy domain itself, then its parents (≥2 labels), most specific
 * first: `a.b.acme.example` → [a.b.acme.example, b.acme.example,
 * acme.example]. Bounded to 1 + MAX_PARENT_CANDIDATES names.
 */
export function brandDomainCandidates(policyDomain: string): string[] {
  const d = normalizePolicyDomain(policyDomain);
  if (!d) return [];
  const out = [d];
  const labels = d.split(".");
  for (let i = 1; i < labels.length - 1 && out.length <= MAX_PARENT_CANDIDATES; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

/**
 * Brand whose canonical_domain is the report's policy domain or the nearest
 * parent of it. One statement: `canonical_domain IN (…)` seeks the unique
 * idx_brands_domain once per candidate (≤5 binds). No `LOWER(name)` arm.
 */
export async function resolveDmarcBrand(db: D1Database, policyDomain: string): Promise<DmarcBrand | null> {
  const candidates = brandDomainCandidates(policyDomain);
  if (candidates.length === 0) return null;
  const rows = await db
    .prepare(`SELECT ${DMARC_BRAND_COLUMNS_SQL} FROM brands b WHERE b.canonical_domain IN (${candidates.map(() => "?").join(", ")})`)
    .bind(...candidates)
    .all<DmarcBrand>();
  let best: DmarcBrand | null = null;
  for (const r of rows.results ?? []) {
    if (!best || r.canonical_domain.length > best.canonical_domain.length) best = r;
  }
  return best;
}

/** May reports be stored for this brand at all? (B1a) */
export function isDmarcEligibleBrand(b: Pick<DmarcBrand, "canonical_domain" | "tier" | "trusted">): boolean {
  if (b.tier !== "monitored" && b.tier !== "customer") return false;
  if (b.trusted !== 1) return false;
  return !isUnderSharedHosting(b.canonical_domain);
}

export type RuaLiveState = "averrow" | "other_rua" | "no_rua" | "no_dmarc" | "lookup_failed";

/**
 * Live `_dmarc.<canonical domain>` check for one brand. KV-cached per brand
 * (`dmarc:rua_live:<brandId>`): 6h when the record names us, 30 min for a
 * negative answer, and NOT cached when the resolver failed (that state is
 * `lookup_failed`, never `no_dmarc`). `cacheNegative: false` (the setup
 * endpoint) reads the cache but never writes a negative. Never throws.
 */
export async function liveDmarcRuaState(
  env: Env,
  brand: Pick<DmarcBrand, "id" | "canonical_domain">,
  opts: { cacheNegative?: boolean } = {},
): Promise<RuaLiveState> {
  const key = `dmarc:rua_live:${brand.id}`;
  try {
    const cached = await env.CACHE.get(key);
    if (cached === "averrow" || cached === "other_rua" || cached === "no_rua" || cached === "no_dmarc") return cached;
  } catch {
    // KV miss / error — live lookup.
  }
  const domain = normalizePolicyDomain(brand.canonical_domain);
  // Short TTL for dohTxtLookup's own positive cache so a just-edited record
  // isn't hidden behind it for longer than ours.
  const { status, records } = await dohTxtLookupDetailed(env, `_dmarc.${domain}`, RUA_LIVE_NEGATIVE_TTL_S);
  if (status === "error") return "lookup_failed";
  let state: RuaLiveState = "no_dmarc";
  for (const txt of records) {
    const parsed = parseDmarcRecord(txt.trim());
    if (!parsed) continue;
    state = ruaIncludesAverrow(parsed.rua) ? "averrow" : parsed.rua ? "other_rua" : "no_rua";
    break;
  }
  if (state === "averrow" || opts.cacheNegative !== false) {
    try {
      await env.CACHE.put(key, state, { expirationTtl: state === "averrow" ? RUA_LIVE_POSITIVE_TTL_S : RUA_LIVE_NEGATIVE_TTL_S });
    } catch {
      // non-fatal
    }
  }
  return state;
}

export function sqliteTsAgeDays(ts: string | null | undefined, nowMs: number): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  // SQLite datetime('now') form 'YYYY-MM-DD HH:MM:SS' is UTC.
  const ms = Date.parse(ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? (nowMs - ms) / 86_400_000 : Number.POSITIVE_INFINITY;
}

export interface EnrollmentCheck {
  enrolled: boolean;
  via: "existing" | "scan" | "live_dns" | "existing_dns_unavailable" | null;
}

/**
 * Is `brand` enrolled? Only the brand's CANONICAL domain's own `_dmarc`
 * record counts — a subdomain's record is attacker-irrelevant evidence
 * when the subdomain is delegated. Upserts dmarc_enrollment on fresh
 * evidence. ≤1 enrollment PK read, ≤1 scan read (idx (brand_id,
 * scanned_at DESC), migration 0080), ≤1 DoH lookup, ≤1 upsert.
 */
export async function checkDmarcEnrollment(env: Env, brand: DmarcBrand, nowMs = Date.now()): Promise<EnrollmentCheck> {
  const db = env.DB;
  const existing = await db
    .prepare("SELECT rua_verified_at FROM dmarc_enrollment WHERE brand_id = ?")
    .bind(brand.id)
    .first<{ rua_verified_at: string }>();
  if (existing && sqliteTsAgeDays(existing.rua_verified_at, nowMs) <= ENROLLMENT_REVERIFY_DAYS) {
    return { enrolled: true, via: "existing" };
  }

  let via: "scan" | "live_dns" | null = null;
  const scan = await db
    .prepare("SELECT dmarc_rua, scanned_at FROM email_security_scans WHERE brand_id = ? ORDER BY scanned_at DESC LIMIT 1")
    .bind(brand.id)
    .first<{ dmarc_rua: string | null; scanned_at: string | null }>();
  if (scan && sqliteTsAgeDays(scan.scanned_at, nowMs) <= SCAN_FRESH_DAYS && ruaIncludesAverrow(scan.dmarc_rua)) {
    via = "scan";
  } else {
    const state = await liveDmarcRuaState(env, brand);
    // The resolver could not answer: keep trusting a lapsed enrollment for
    // this report rather than reading the failure as "unenrolled"; don't
    // refresh rua_verified_at.
    if (state === "lookup_failed") {
      return existing ? { enrolled: true, via: "existing_dns_unavailable" } : { enrolled: false, via: null };
    }
    if (state === "averrow") via = "live_dns";
  }

  if (!via) return { enrolled: false, via: null };

  await db
    .prepare(
      `INSERT INTO dmarc_enrollment (brand_id, domain, rua_verified_at, verified_via)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(brand_id) DO UPDATE SET
         domain = excluded.domain,
         rua_verified_at = excluded.rua_verified_at,
         verified_via = excluded.verified_via`,
    )
    .bind(brand.id, normalizePolicyDomain(brand.canonical_domain), via)
    .run();
  return { enrolled: true, via };
}

/**
 * Is the external-destination authorization record in place for `domain`
 * (RFC 7489 §7.1)? True without a lookup when the domain shares the auth
 * host's organizational domain. KV-cached (`dmarc:rua_auth:<name>`): 24h
 * when present, 1h when missing; a resolver failure is reported as
 * `ok: null` and not cached.
 */
export async function ruaAuthorizationRecordOk(env: Env, domain: string): Promise<{ required: boolean; ok: boolean | null; record_name: string }> {
  const record_name = ruaAuthorizationRecordName(domain);
  if (!isRuaAuthorizationRequired(domain)) return { required: false, ok: true, record_name };
  const key = `dmarc:rua_auth:${record_name}`;
  try {
    const cached = await env.CACHE.get(key);
    if (cached === "1" || cached === "0") return { required: true, ok: cached === "1", record_name };
  } catch {
    // live lookup
  }
  const { status, records } = await dohTxtLookupDetailed(env, record_name, RUA_AUTH_MISSING_TTL_S);
  if (status === "error") return { required: true, ok: null, record_name };
  const ok = records.some((r) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(r.trim()));
  try {
    await env.CACHE.put(key, ok ? "1" : "0", { expirationTtl: ok ? RUA_AUTH_OK_TTL_S : RUA_AUTH_MISSING_TTL_S });
  } catch {
    // non-fatal
  }
  return { required: true, ok, record_name };
}

// ─── Rate caps (B1b, review M1/M2) ──────────────────────────────────────

export interface RateDecision {
  allowed: boolean;
  /** Counter values after this attempt (null when the statement failed). */
  brandCount: number | null;
  globalCount: number | null;
}

/**
 * Brand counter: always incremented. Global counter: incremented only when
 * this attempt is still within the brand cap (the guard sees the brand
 * increment, same batch), so one flooded brand can't use up the global
 * hour for everyone else in its class.
 */
export const DMARC_RATE_BRAND_SQL = `INSERT INTO dmarc_rate_counters (bucket, period, n) VALUES (?, ?, 1)
  ON CONFLICT(bucket, period) DO UPDATE SET n = n + 1
  RETURNING n`;
export const DMARC_RATE_GLOBAL_SQL = `INSERT INTO dmarc_rate_counters (bucket, period, n)
  SELECT ?, ?, 1 WHERE (SELECT n FROM dmarc_rate_counters WHERE bucket = ? AND period = ?) <= ?
  ON CONFLICT(bucket, period) DO UPDATE SET n = n + 1
  RETURNING n`;

/**
 * Check-and-count one report against the per-brand daily and global hourly
 * caps of its provenance class, atomically in one D1 batch. Keyed on
 * WALL-CLOCK UTC time, never on the report's own dates. Fails CLOSED: if
 * the counter batch can't run (after withD1Retry's short default), or
 * returns no count, the report is denied — a D1 that can't take two tiny
 * upserts must not then take the ~200 statements of a stored report.
 */
export async function takeDmarcIngestSlot(env: Env, brandId: string, verified: boolean, nowMs = Date.now()): Promise<RateDecision> {
  const iso = new Date(nowMs).toISOString();
  const cls = verified ? "verified" : "unverified";
  const day = iso.slice(0, 10);
  const hour = iso.slice(0, 13);
  const brandBucket = `brand:${brandId}:${cls}`;
  const globalBucket = `global:${cls}`;
  try {
    const db = env.DB;
    const res = await withD1Retry(() => db.batch([
      db.prepare(DMARC_RATE_BRAND_SQL).bind(brandBucket, day),
      db.prepare(DMARC_RATE_GLOBAL_SQL).bind(globalBucket, hour, brandBucket, day, DMARC_BRAND_DAILY_CAP[cls]),
    ]));
    const n = (r: D1Result | undefined): number | null => {
      const v = (r?.results as Array<{ n: number }> | undefined)?.[0]?.n;
      return typeof v === "number" ? v : null;
    };
    const brandCount = n(res[0]);
    const globalCount = n(res[1]);
    const allowed = brandCount !== null && brandCount <= DMARC_BRAND_DAILY_CAP[cls]
      && globalCount !== null && globalCount <= DMARC_GLOBAL_HOURLY_CAP[cls];
    return { allowed, brandCount, globalCount };
  } catch (err) {
    console.error("[dmarc] rate counter failed — denying:", err instanceof Error ? err.message : String(err));
    return { allowed: false, brandCount: null, globalCount: null };
  }
}

// ─── Drop counters (diagnostics `dmarc_ingest`) ─────────────────────────

export const DMARC_DROP_REASONS = [
  "no_brand", "ineligible_brand", "unenrolled", "rate_limited", "duplicate", "unparseable", "out_of_window", "error",
] as const;
export type DmarcDropReason = (typeof DMARC_DROP_REASONS)[number];
export type DmarcDropCounts = Record<DmarcDropReason, number>;

function zeroDrops(): DmarcDropCounts {
  return { no_brand: 0, ineligible_brand: 0, unenrolled: 0, rate_limited: 0, duplicate: 0, unparseable: 0, out_of_window: 0, error: 0 };
}

/** `dmarc:drops:YYYY-MM-DDTHH` — one JSON counter object per UTC hour. */
export function dmarcDropKey(ms: number): string {
  return `dmarc:drops:${new Date(ms).toISOString().slice(0, 13)}`;
}

function parseDrops(raw: string | null): DmarcDropCounts {
  const out = zeroDrops();
  if (!raw) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") {
      for (const r of DMARC_DROP_REASONS) {
        const n = (v as Record<string, unknown>)[r];
        if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[r] = n;
      }
    }
  } catch {
    // corrupt bucket → zeros
  }
  return out;
}

/**
 * Count one dropped report. Best-effort read-modify-write on a KV bucket
 * (26h TTL): concurrent drops in the same hour can lose an increment, which
 * is fine for an operator gauge. Never throws.
 */
export async function recordDmarcDrop(env: Env, reason: DmarcDropReason, nowMs = Date.now()): Promise<void> {
  try {
    const key = dmarcDropKey(nowMs);
    const counts = parseDrops(await env.CACHE.get(key));
    counts[reason] += 1;
    await env.CACHE.put(key, JSON.stringify(counts), { expirationTtl: 26 * 3600 });
  } catch {
    // non-fatal
  }
}

/** Sum of the last 24 hourly buckets (current hour included). KV only. */
export async function readDmarcDrops24h(env: Env, nowMs = Date.now()): Promise<DmarcDropCounts> {
  const keys = Array.from({ length: 24 }, (_, i) => dmarcDropKey(nowMs - i * 3_600_000));
  const raws = await Promise.all(keys.map((k) => env.CACHE.get(k).catch(() => null)));
  const total = zeroDrops();
  for (const raw of raws) {
    const c = parseDrops(raw);
    for (const r of DMARC_DROP_REASONS) total[r] += c[r];
  }
  return total;
}

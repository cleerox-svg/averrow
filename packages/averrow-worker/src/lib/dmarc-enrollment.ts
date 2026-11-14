/**
 * DMARC RUA intake gates — which brands may have aggregate reports stored,
 * the brand lookup for a report's policy domain, ingest rate caps, and the
 * drop counters diagnostics reads.
 *
 * Anyone can email forged aggregate XML to the RUA address, so a report is
 * stored ONLY when all of these hold (each failure is a counted drop):
 *   no_brand          the policy domain (or a parent) is a brand's
 *                     canonical_domain (indexed IN lookup);
 *   ineligible_brand  the brand is tier monitored / customer, its `source`
 *                     is not one an anonymous user can create
 *                     (UNTRUSTED_BRAND_SOURCES — public_assess /
 *                     self_service / ai_attributed) and its canonical domain
 *                     is not / not under a shared-hosting domain. Otherwise
 *                     anyone could create a brand for a domain they control,
 *                     publish our rua and drive writes at will (appsec M1);
 *   unenrolled        the brand's CANONICAL domain's own `_dmarc` record
 *                     names our RUA address (scan or live DNS, re-verified
 *                     after ENROLLMENT_REVERIFY_DAYS);
 *   rate_limited      ≤ DMARC_BRAND_DAILY_CAP stored reports per brand per
 *                     UTC wall-clock day (separately for verified and
 *                     unverified reports, so forged mail can't starve real
 *                     reporters) and ≤ DMARC_GLOBAL_HOURLY_CAP per hour.
 */

import type { Env } from "../types";
import { dohTxtLookupDetailed } from "./doh";
import { parseDmarcRecord } from "./dmarc-record";
import { isRuaAuthorizationRequired, ruaAuthorizationRecordName, ruaIncludesAverrow } from "./dmarc-rua";
import { UNTRUSTED_BRAND_SOURCES, isUnderSharedHosting } from "./safeDomains";

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

/** Stored reports per brand per UTC day, per provenance (verified / not). */
export const DMARC_BRAND_DAILY_CAP = 50;
/** Stored reports per UTC hour, all brands. */
export const DMARC_GLOBAL_HOURLY_CAP = 500;

export interface DmarcBrand {
  id: string;
  canonical_domain: string;
  tier: string | null;
  source: string | null;
}

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
    .prepare(`SELECT id, canonical_domain, tier, source FROM brands WHERE canonical_domain IN (${candidates.map(() => "?").join(", ")})`)
    .bind(...candidates)
    .all<DmarcBrand>();
  let best: DmarcBrand | null = null;
  for (const r of rows.results ?? []) {
    if (!best || r.canonical_domain.length > best.canonical_domain.length) best = r;
  }
  return best;
}

const UNTRUSTED_SOURCES: ReadonlySet<string> = new Set(UNTRUSTED_BRAND_SOURCES);

/** May reports be stored for this brand at all? (B1a) */
export function isDmarcEligibleBrand(b: Pick<DmarcBrand, "canonical_domain" | "tier" | "source">): boolean {
  if (b.tier !== "monitored" && b.tier !== "customer") return false;
  if (UNTRUSTED_SOURCES.has(b.source ?? "")) return false;
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

// ─── Rate caps (B1b) ────────────────────────────────────────────────────

export interface RateDecision {
  allowed: boolean;
  /** KV could not be read/written: the report is allowed, but the caller
   *  skips the inline rollup and ipinfo (the Navigator catch-up rolls it
   *  up later, without ipinfo). */
  degraded: boolean;
}

function readCount(raw: string | null): number {
  const n = raw === null ? 0 : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Check-and-count one stored report against the per-brand daily and global
 * hourly caps. Keyed on WALL-CLOCK UTC time, never on the report's own
 * (attacker-chosen) dates. Best-effort read-modify-write: concurrent
 * reports can overshoot a cap by the concurrency, which is fine for an
 * abuse bound. KV error → allowed + degraded (documented trade-off:
 * failing closed would drop real reports while KV is down; failing open
 * with the full pipeline would remove the bound, so the degraded path
 * skips the expensive parts).
 */
export async function takeDmarcIngestSlot(env: Env, brandId: string, verified: boolean, nowMs = Date.now()): Promise<RateDecision> {
  const iso = new Date(nowMs).toISOString();
  const brandKey = `dmarc:rate:brand:${brandId}:${iso.slice(0, 10)}:${verified ? "v" : "u"}`;
  const globalKey = `dmarc:rate:global:${iso.slice(0, 13)}`;
  try {
    const [b, g] = await Promise.all([env.CACHE.get(brandKey), env.CACHE.get(globalKey)]);
    const brandCount = readCount(b);
    const globalCount = readCount(g);
    if (brandCount >= DMARC_BRAND_DAILY_CAP || globalCount >= DMARC_GLOBAL_HOURLY_CAP) {
      return { allowed: false, degraded: false };
    }
    await Promise.all([
      env.CACHE.put(brandKey, String(brandCount + 1), { expirationTtl: 2 * 86400 }),
      env.CACHE.put(globalKey, String(globalCount + 1), { expirationTtl: 2 * 3600 }),
    ]);
    return { allowed: true, degraded: false };
  } catch {
    return { allowed: true, degraded: true };
  }
}

// ─── Drop counters (diagnostics `dmarc_ingest`) ─────────────────────────

export const DMARC_DROP_REASONS = [
  "no_brand", "ineligible_brand", "unenrolled", "rate_limited", "duplicate", "unparseable", "error",
] as const;
export type DmarcDropReason = (typeof DMARC_DROP_REASONS)[number];
export type DmarcDropCounts = Record<DmarcDropReason, number>;

function zeroDrops(): DmarcDropCounts {
  return { no_brand: 0, ineligible_brand: 0, unenrolled: 0, rate_limited: 0, duplicate: 0, unparseable: 0, error: 0 };
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

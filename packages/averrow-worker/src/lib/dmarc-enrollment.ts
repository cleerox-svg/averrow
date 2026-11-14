/**
 * DMARC RUA enrollment — which brands have asked for their aggregate
 * reports to come to Averrow, and the brand lookup for a report's policy
 * domain.
 *
 * Anyone can email forged aggregate XML to the RUA address. A report is
 * therefore stored (and can notify a tenant) ONLY for a brand that is
 * enrolled: its own published `_dmarc` record names one of our RUA
 * addresses. Forgery for an enrolled brand is still possible (aggregate
 * reports are unauthenticated by design), which is why everything derived
 * from them is metadata and the tenant notification carries no reporter
 * text.
 *
 * Enrollment evidence, cheapest first:
 *   1. a dmarc_enrollment row verified within ENROLLMENT_REVERIFY_DAYS;
 *   2. the brand's latest email_security_scans.dmarc_rua, if scanned within
 *      SCAN_FRESH_DAYS ('scan');
 *   3. one live DoH TXT lookup of `_dmarc.<policy domain>` (falling back to
 *      the brand's canonical domain when the policy domain publishes no
 *      DMARC record), KV-cached ('live_dns').
 * Unenrolled and unmatched reports are dropped and counted
 * (recordDmarcDrop → diagnostics `dmarc_ingest`).
 */

import type { Env } from "../types";
import { dohTxtLookup } from "./doh";
import { parseDmarcRecord } from "./dmarc-record";
import { isRuaAuthorizationRequired, ruaAuthorizationRecordName, ruaIncludesAverrow } from "./dmarc-rua";

export const ENROLLMENT_REVERIFY_DAYS = 30;
export const SCAN_FRESH_DAYS = 7;
/** Live `_dmarc` verdict cache: a record exists (ours or not). */
export const RUA_LIVE_TTL_S = 6 * 3600;
/**
 * Live verdict cache when the lookup came back empty. dohTxtLookup returns
 * [] for NXDOMAIN AND for a resolver failure; a 6h negative on a failure
 * would drop a newly enrolled brand's first reports, so empty is cached
 * for 30 min only.
 */
export const RUA_LIVE_EMPTY_TTL_S = 30 * 60;
/** Report-authorization record cache (setup endpoint). */
export const RUA_AUTH_OK_TTL_S = 24 * 3600;
export const RUA_AUTH_MISSING_TTL_S = 3600;
/** Parent-domain candidates tried for a subdomain policy domain. */
const MAX_PARENT_CANDIDATES = 4;

export interface DmarcBrand {
  id: string;
  canonical_domain: string;
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
 * Brand whose canonical_domain is the report's policy domain or the
 * nearest parent of it. One indexed statement: `canonical_domain IN (…)`
 * seeks the unique idx_brands_domain (BINARY) once per candidate (≤5
 * binds). Canonical domains are stored lowercase. No `LOWER(name)` arm —
 * that read every brand row per report.
 */
export async function resolveDmarcBrand(db: D1Database, policyDomain: string): Promise<DmarcBrand | null> {
  const candidates = brandDomainCandidates(policyDomain);
  if (candidates.length === 0) return null;
  const rows = await db
    .prepare(`SELECT id, canonical_domain FROM brands WHERE canonical_domain IN (${candidates.map(() => "?").join(", ")})`)
    .bind(...candidates)
    .all<DmarcBrand>();
  let best: DmarcBrand | null = null;
  for (const r of rows.results ?? []) {
    if (!best || r.canonical_domain.length > best.canonical_domain.length) best = r;
  }
  return best;
}

export type RuaLiveState = "averrow" | "other_rua" | "no_rua" | "no_dmarc";

/**
 * Live `_dmarc.<domain>` check, KV-cached (`dmarc:rua_live:<domain>`),
 * negative results included. Never throws.
 */
export async function liveDmarcRuaState(env: Env, domain: string): Promise<RuaLiveState> {
  const d = normalizePolicyDomain(domain);
  const key = `dmarc:rua_live:${d}`;
  try {
    const cached = await env.CACHE.get(key);
    if (cached === "averrow" || cached === "other_rua" || cached === "no_rua" || cached === "no_dmarc") return cached;
  } catch {
    // KV miss / error — live lookup.
  }
  let state: RuaLiveState = "no_dmarc";
  const records = await dohTxtLookup(env, `_dmarc.${d}`, RUA_LIVE_TTL_S);
  for (const txt of records) {
    const parsed = parseDmarcRecord(txt.trim());
    if (!parsed) continue;
    state = ruaIncludesAverrow(parsed.rua) ? "averrow" : parsed.rua ? "other_rua" : "no_rua";
    break;
  }
  try {
    await env.CACHE.put(key, state, { expirationTtl: records.length > 0 ? RUA_LIVE_TTL_S : RUA_LIVE_EMPTY_TTL_S });
  } catch {
    // non-fatal
  }
  return state;
}

function ageDays(ts: string | null | undefined, nowMs: number): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  // SQLite datetime('now') form 'YYYY-MM-DD HH:MM:SS' is UTC.
  const ms = Date.parse(ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`);
  return Number.isFinite(ms) ? (nowMs - ms) / 86_400_000 : Number.POSITIVE_INFINITY;
}

export interface EnrollmentCheck {
  enrolled: boolean;
  via: "existing" | "scan" | "live_dns" | null;
}

/**
 * Is `brand` enrolled for reports on `policyDomain`? Upserts
 * dmarc_enrollment when fresh evidence is found. Reads: ≤1 enrollment PK
 * read, ≤1 scan read (idx on (brand_id, scanned_at DESC), migration 0080),
 * ≤2 DoH lookups (KV-cached), ≤1 upsert.
 */
export async function checkDmarcEnrollment(
  env: Env,
  brand: DmarcBrand,
  policyDomain: string,
  nowMs = Date.now(),
): Promise<EnrollmentCheck> {
  const db = env.DB;
  const existing = await db
    .prepare("SELECT rua_verified_at FROM dmarc_enrollment WHERE brand_id = ?")
    .bind(brand.id)
    .first<{ rua_verified_at: string }>();
  if (existing && ageDays(existing.rua_verified_at, nowMs) <= ENROLLMENT_REVERIFY_DAYS) {
    return { enrolled: true, via: "existing" };
  }

  let via: "scan" | "live_dns" | null = null;
  const scan = await db
    .prepare("SELECT dmarc_rua, scanned_at FROM email_security_scans WHERE brand_id = ? ORDER BY scanned_at DESC LIMIT 1")
    .bind(brand.id)
    .first<{ dmarc_rua: string | null; scanned_at: string | null }>();
  if (scan && ageDays(scan.scanned_at, nowMs) <= SCAN_FRESH_DAYS && ruaIncludesAverrow(scan.dmarc_rua)) {
    via = "scan";
  } else {
    const policy = normalizePolicyDomain(policyDomain);
    let state = await liveDmarcRuaState(env, policy);
    // RFC 7489 policy discovery: a subdomain without its own record uses
    // the organizational domain's — the brand's canonical domain here.
    if (state === "no_dmarc" && policy !== brand.canonical_domain) {
      state = await liveDmarcRuaState(env, brand.canonical_domain);
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
    .bind(brand.id, brand.canonical_domain, via)
    .run();
  return { enrolled: true, via };
}

/**
 * Is the external-destination authorization record in place for `domain`
 * (RFC 7489 §7.1)? True without a lookup when the domain shares the auth
 * host's organizational domain. KV-cached (`dmarc:rua_auth:<domain>`): 24h
 * when present, 1h when missing so a fix shows up the same hour.
 */
export async function ruaAuthorizationRecordOk(env: Env, domain: string): Promise<{ required: boolean; ok: boolean; record_name: string }> {
  const record_name = ruaAuthorizationRecordName(domain);
  if (!isRuaAuthorizationRequired(domain)) return { required: false, ok: true, record_name };
  const key = `dmarc:rua_auth:${record_name}`;
  try {
    const cached = await env.CACHE.get(key);
    if (cached === "1" || cached === "0") return { required: true, ok: cached === "1", record_name };
  } catch {
    // live lookup
  }
  const records = await dohTxtLookup(env, record_name, RUA_AUTH_OK_TTL_S);
  const ok = records.some((r) => /^v\s*=\s*DMARC1\s*(;|$)/i.test(r.trim()));
  try {
    await env.CACHE.put(key, ok ? "1" : "0", { expirationTtl: ok ? RUA_AUTH_OK_TTL_S : RUA_AUTH_MISSING_TTL_S });
  } catch {
    // non-fatal
  }
  return { required: true, ok, record_name };
}

// ─── Drop counters (diagnostics `dmarc_ingest`) ─────────────────────────

export type DmarcDropReason = "no_brand" | "unenrolled" | "duplicate" | "unparseable";
const DROP_REASONS: readonly DmarcDropReason[] = ["no_brand", "unenrolled", "duplicate", "unparseable"];
export type DmarcDropCounts = Record<DmarcDropReason, number>;

/** `dmarc:drops:YYYY-MM-DDTHH` — one JSON counter object per UTC hour. */
export function dmarcDropKey(ms: number): string {
  return `dmarc:drops:${new Date(ms).toISOString().slice(0, 13)}`;
}

function parseDrops(raw: string | null): DmarcDropCounts {
  const out: DmarcDropCounts = { no_brand: 0, unenrolled: 0, duplicate: 0, unparseable: 0 };
  if (!raw) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") {
      for (const r of DROP_REASONS) {
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
  const total: DmarcDropCounts = { no_brand: 0, unenrolled: 0, duplicate: 0, unparseable: 0 };
  for (const raw of raws) {
    const c = parseDrops(raw);
    for (const r of DROP_REASONS) total[r] += c[r];
  }
  return total;
}

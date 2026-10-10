// Averrow — Admin backfill: IdP-impersonation tagging
// POST /api/admin/backfills/idp-impersonation?limit=500 (requireAdmin) and its
// AVERROW_INTERNAL_SECRET mirror POST /api/internal/backfills/idp-impersonation
// — both call runIdpImpersonationBackfill with their own BackfillActor.
// (docs/IDP_IMPERSONATION_PLAN_2026-10.md, task T2)
//
// Bounded, resumable, idempotent. Walks `threats` (technique NULL or already
// IdP-family) and `lookalike_domains` by rowid from a KV cursor, classifies
// in JS (lib/idp-impersonation.ts — the single rule set), and writes only
// rows whose stored value differs. Re-running after `done: true` is a no-op
// until new rows arrive past the cursor.

import { json } from "../../lib/cors";
import { audit } from "../../lib/audit";
import type { Env } from "../../types";
import type { AuthContext } from "../../middleware/auth";
import { IDP_FAMILY_TECHNIQUES } from "../../lib/idp-impersonation";
import { tagThreat, loadBrandTokens, idpTagUpdateStmt, lookalikeIdpLure } from "../../lib/idp-tagging";
import { generateIdpLurePermutations } from "../../lib/dnstwist";
import { MONITORED_BRAND_PREDICATE_SQL } from "../../lib/monitored-brands";
import { storeLookalikePermutations } from "../../scanners/lookalike-domains";

export const IDP_BACKFILL_THREAT_CURSOR_KEY = "backfill:idp:cursor";
export const IDP_BACKFILL_LOOKALIKE_CURSOR_KEY = "backfill:idp:lookalike_cursor";
export const IDP_BACKFILL_DEFAULT_LIMIT = 500;
export const IDP_BACKFILL_MAX_LIMIT = 1000;
/** Statements per env.DB.batch (each UPDATE binds ≤ 7 params, well under D1's 100). */
const UPDATE_BATCH = 50;

export interface IdpBackfillPassResult {
  scanned: number;
  tagged: number;
  cursor: number;
  done: boolean;
}

export interface IdpBackfillResult extends IdpBackfillPassResult {
  lookalikes: IdpBackfillPassResult;
}

export function parseIdpBackfillLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return IDP_BACKFILL_DEFAULT_LIMIT;
  return Math.min(n, IDP_BACKFILL_MAX_LIMIT);
}

async function readCursor(env: Env, key: string): Promise<number> {
  const raw = await env.CACHE.get(key);
  const n = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function runBatches(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += UPDATE_BATCH) {
    await env.DB.batch(stmts.slice(i, i + UPDATE_BATCH));
  }
}

const FAMILY_PLACEHOLDERS = IDP_FAMILY_TECHNIQUES.map(() => "?").join(", ");

interface ThreatScanRow {
  rid: number;
  id: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  technique: string | null;
  impersonated_idp: string | null;
  target_brand_id: string | null;
}

export async function backfillThreatIdpTags(env: Env, limit: number): Promise<IdpBackfillPassResult> {
  const cursor = await readCursor(env, IDP_BACKFILL_THREAT_CURSOR_KEY);
  const res = await env.DB.prepare(
    `SELECT rowid AS rid, id, malicious_domain, malicious_url, technique, impersonated_idp, target_brand_id
       FROM threats
      WHERE rowid > ?
        AND (technique IS NULL OR technique IN (${FAMILY_PLACEHOLDERS}))
      ORDER BY rowid
      LIMIT ?`,
  ).bind(cursor, ...IDP_FAMILY_TECHNIQUES, limit).all<ThreatScanRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return { scanned: 0, tagged: 0, cursor, done: true };

  // Brand tokens only for rows that don't classify on their own and have a
  // brand — the weak-lure path (acme-helpdesk.com). Chunked + cached.
  const needTokens = rows.filter((r) => r.target_brand_id && !tagThreat(r).impersonated_idp);
  const tokens = needTokens.length > 0
    ? await loadBrandTokens(env.DB, needTokens.map((r) => r.target_brand_id as string))
    : new Map<string, string[]>();

  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const tag = tagThreat(r, r.target_brand_id ? tokens.get(r.target_brand_id) : undefined);
    if (!tag.impersonated_idp) continue;
    if (tag.technique === r.technique && tag.impersonated_idp === r.impersonated_idp) continue;
    // The UPDATE re-checks the technique guard so a concurrent writer that
    // set a non-family technique is never overwritten.
    stmts.push(idpTagUpdateStmt(env.DB, r.id, tag));
  }
  await runBatches(env, stmts);

  const next = rows[rows.length - 1]!.rid;
  await env.CACHE.put(IDP_BACKFILL_THREAT_CURSOR_KEY, String(next));
  return { scanned: rows.length, tagged: stmts.length, cursor: next, done: rows.length < limit };
}

interface LookalikeScanRow {
  rid: number;
  id: string;
  domain: string;
  idp_lure: string | null;
  canonical_domain: string | null;
}

export async function backfillLookalikeIdpLures(env: Env, limit: number): Promise<IdpBackfillPassResult> {
  const cursor = await readCursor(env, IDP_BACKFILL_LOOKALIKE_CURSOR_KEY);
  const res = await env.DB.prepare(
    `SELECT ld.rowid AS rid, ld.id, ld.domain, ld.idp_lure, b.canonical_domain
       FROM lookalike_domains ld
       LEFT JOIN brands b ON b.id = ld.brand_id
      WHERE ld.rowid > ?
      ORDER BY ld.rowid
      LIMIT ?`,
  ).bind(cursor, limit).all<LookalikeScanRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return { scanned: 0, tagged: 0, cursor, done: true };

  // Same rule as the seeder and the top-up (lib/idp-tagging.ts lookalikeIdpLure).
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const lure = lookalikeIdpLure(r.domain, r.canonical_domain);
    if (!lure || lure === r.idp_lure) continue;
    stmts.push(env.DB.prepare("UPDATE lookalike_domains SET idp_lure = ? WHERE id = ?").bind(lure, r.id));
  }
  await runBatches(env, stmts);

  const next = rows[rows.length - 1]!.rid;
  await env.CACHE.put(IDP_BACKFILL_LOOKALIKE_CURSOR_KEY, String(next));
  return { scanned: rows.length, tagged: stmts.length, cursor: next, done: rows.length < limit };
}

/** `?reset=1` — clear cursors instead of running a pass. */
function isReset(url: URL): boolean {
  const v = url.searchParams.get("reset");
  return v === "1" || v === "true";
}

/**
 * Who triggered a backfill. `userId` goes to `audit_log.user_id` (NULL for a
 * service caller); `label` goes to `details.actor` so admin- and
 * internal-triggered runs are distinguishable — same convention as the
 * brand-link cleanup (`"user:<id>"` vs `"internal"`, lib/brand-link-cleanup.ts).
 */
export interface BackfillActor {
  userId: string | null;
  label: string;
}

/**
 * The AVERROW_INTERNAL_SECRET caller (POST /api/internal/backfills/*). The
 * secret is shared by every internal tool (MCP server, scripts, Claude Code),
 * so the label names the grant, not a specific client it cannot prove.
 */
export const INTERNAL_BACKFILL_ACTOR: BackfillActor = { userId: null, label: "internal" };

export function adminBackfillActor(ctx: AuthContext): BackfillActor {
  return { userId: ctx.userId, label: `user:${ctx.userId}` };
}

/**
 * Shared backfill envelope: optional cursor reset, then AUDIT FIRST
 * (an attempt row exists before any data write), run, then a completion row
 * (success / failure). `audit()` never throws, so an audit-store outage can
 * never turn a pass whose rows already changed into a 500.
 */
async function runAuditedBackfill<T>(
  request: Request,
  env: Env,
  actor: BackfillActor,
  opts: { action: string; resourceType: string; cursorKeys: string[]; params: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const base = { userId: actor.userId, resourceType: opts.resourceType, request };
  try {
    if (isReset(url)) {
      await audit(env, {
        ...base, action: `${opts.action}_reset`,
        details: { actor: actor.label, cursor_keys: opts.cursorKeys },
      });
      await Promise.all(opts.cursorKeys.map((k) => env.CACHE.delete(k)));
      return json({ success: true, data: { reset: true, cursors_cleared: opts.cursorKeys } }, 200, origin);
    }
    await audit(env, {
      ...base, action: `${opts.action}_started`,
      details: { actor: actor.label, ...opts.params },
    });
    let data: T;
    try {
      data = await run();
    } catch (err) {
      await audit(env, {
        ...base, action: opts.action, outcome: "failure",
        details: { actor: actor.label, ...opts.params, error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
    await audit(env, {
      ...base, action: opts.action,
      details: { actor: actor.label, ...opts.params, result: data },
    });
    return json({ success: true, data }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

/** POST /api/admin/backfills/idp-impersonation (requireAdmin). */
export async function handleBackfillIdpImpersonation(
  request: Request,
  env: Env,
  ctx: AuthContext,
): Promise<Response> {
  return runIdpImpersonationBackfill(request, env, adminBackfillActor(ctx));
}

/**
 * Core of the IdP-impersonation backfill, shared by the admin route and
 * POST /api/internal/backfills/idp-impersonation (AVERROW_INTERNAL_SECRET).
 * `?limit=` (default 500, cap 1000), `?reset=1` clears both cursors.
 */
export async function runIdpImpersonationBackfill(
  request: Request,
  env: Env,
  actor: BackfillActor,
): Promise<Response> {
  const limit = parseIdpBackfillLimit(new URL(request.url).searchParams.get("limit"));
  return runAuditedBackfill<IdpBackfillResult>(request, env, actor, {
    action: "backfill_idp_impersonation",
    resourceType: "threats",
    cursorKeys: [IDP_BACKFILL_THREAT_CURSOR_KEY, IDP_BACKFILL_LOOKALIKE_CURSOR_KEY],
    params: { limit },
  }, async () => {
    const threats = await backfillThreatIdpTags(env, limit);
    const lookalikes = await backfillLookalikeIdpLures(env, limit);
    return { ...threats, done: threats.done && lookalikes.done, lookalikes };
  });
}

// ─── Lure top-up for already-seeded brands ──────────────────────────
// POST /api/admin/backfills/idp-lure-topup?brands=50
//
// The seeder (seedLookalikesForOrgBrands) is one-shot per brand, so brands
// seeded before the IdP lures existed never get them. This walks monitored
// brands (MONITORED_BRAND_PREDICATE_SQL) that ALREADY have lookalike rows —
// un-seeded brands are left to the seeder, whose NOT EXISTS gate would skip
// them forever if we planted lures first — by brands.rowid from a KV cursor,
// and stores only the ≤7 IdP lure permutations through the seeder's own
// insert path (storeLookalikePermutations: trusted official domains benign +
// parked, idp_lure stamped, INSERT OR IGNORE on (brand_id, domain)).
// Idempotent: re-running inserts nothing for brands already topped up.

export const IDP_LURE_TOPUP_CURSOR_KEY = "backfill:idp:lure_topup_cursor";
export const IDP_LURE_TOPUP_DEFAULT_BRANDS = 50;
export const IDP_LURE_TOPUP_MAX_BRANDS = 200;

export interface IdpLureTopupResult {
  brands_scanned: number;
  inserted: number;
  cursor: number;
  done: boolean;
}

export function parseIdpLureTopupBrands(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return IDP_LURE_TOPUP_DEFAULT_BRANDS;
  return Math.min(n, IDP_LURE_TOPUP_MAX_BRANDS);
}

export async function topUpIdpLures(env: Env, brandLimit: number): Promise<IdpLureTopupResult> {
  const cursor = await readCursor(env, IDP_LURE_TOPUP_CURSOR_KEY);
  const res = await env.DB.prepare(
    `SELECT b.rowid AS rid, b.id AS brand_id, b.canonical_domain AS domain
       FROM brands b
      WHERE b.rowid > ?
        AND b.canonical_domain IS NOT NULL
        AND ${MONITORED_BRAND_PREDICATE_SQL}
        AND EXISTS (SELECT 1 FROM lookalike_domains ld WHERE ld.brand_id = b.id)
      ORDER BY b.rowid
      LIMIT ?`,
  ).bind(cursor, brandLimit).all<{ rid: number; brand_id: string; domain: string }>();
  const rows = res.results ?? [];
  if (rows.length === 0) return { brands_scanned: 0, inserted: 0, cursor, done: true };

  let inserted = 0;
  for (const b of rows) {
    const lures = generateIdpLurePermutations(b.domain);
    if (lures.length === 0) continue;
    inserted += (await storeLookalikePermutations(env, b.brand_id, b.domain, lures)).inserted;
  }

  const next = rows[rows.length - 1]!.rid;
  await env.CACHE.put(IDP_LURE_TOPUP_CURSOR_KEY, String(next));
  return { brands_scanned: rows.length, inserted, cursor: next, done: rows.length < brandLimit };
}

/** POST /api/admin/backfills/idp-lure-topup (requireAdmin). */
export async function handleIdpLureTopup(
  request: Request,
  env: Env,
  ctx: AuthContext,
): Promise<Response> {
  return runIdpLureTopupBackfill(request, env, adminBackfillActor(ctx));
}

/**
 * Core of the IdP lure top-up, shared by the admin route and
 * POST /api/internal/backfills/idp-lure-topup (AVERROW_INTERNAL_SECRET).
 * `?brands=` (default 50, cap 200), `?reset=1` clears the brand cursor.
 */
export async function runIdpLureTopupBackfill(
  request: Request,
  env: Env,
  actor: BackfillActor,
): Promise<Response> {
  const brands = parseIdpLureTopupBrands(new URL(request.url).searchParams.get("brands"));
  return runAuditedBackfill<IdpLureTopupResult>(request, env, actor, {
    action: "backfill_idp_lure_topup",
    resourceType: "lookalike_domains",
    cursorKeys: [IDP_LURE_TOPUP_CURSOR_KEY],
    params: { brands },
  }, () => topUpIdpLures(env, brands));
}

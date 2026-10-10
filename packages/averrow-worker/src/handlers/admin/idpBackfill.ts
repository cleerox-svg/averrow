// Averrow — Admin backfill: IdP-impersonation tagging
// POST /api/admin/backfills/idp-impersonation?limit=500
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
import { classifyIdpImpersonation, IDP_FAMILY_TECHNIQUES } from "../../lib/idp-impersonation";
import { tagThreat, loadBrandTokens } from "../../lib/idp-tagging";

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
    // Re-check the technique guard in the UPDATE so a concurrent writer that
    // set a non-family technique is never overwritten.
    stmts.push(env.DB.prepare(
      `UPDATE threats SET technique = ?, impersonated_idp = ?
        WHERE id = ? AND (technique IS NULL OR technique IN (${FAMILY_PLACEHOLDERS}))`,
    ).bind(tag.technique, tag.impersonated_idp, r.id, ...IDP_FAMILY_TECHNIQUES));
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
  brand_id: string;
  idp_lure: string | null;
}

export async function backfillLookalikeIdpLures(env: Env, limit: number): Promise<IdpBackfillPassResult> {
  const cursor = await readCursor(env, IDP_BACKFILL_LOOKALIKE_CURSOR_KEY);
  const res = await env.DB.prepare(
    `SELECT rowid AS rid, id, domain, brand_id, idp_lure
       FROM lookalike_domains
      WHERE rowid > ?
      ORDER BY rowid
      LIMIT ?`,
  ).bind(cursor, limit).all<LookalikeScanRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return { scanned: 0, tagged: 0, cursor, done: true };

  const tokens = await loadBrandTokens(env.DB, rows.map((r) => r.brand_id));
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const lure = classifyIdpImpersonation({ host: r.domain, brandTokens: tokens.get(r.brand_id) })?.idp ?? null;
    if (!lure || lure === r.idp_lure) continue;
    stmts.push(env.DB.prepare("UPDATE lookalike_domains SET idp_lure = ? WHERE id = ?").bind(lure, r.id));
  }
  await runBatches(env, stmts);

  const next = rows[rows.length - 1]!.rid;
  await env.CACHE.put(IDP_BACKFILL_LOOKALIKE_CURSOR_KEY, String(next));
  return { scanned: rows.length, tagged: stmts.length, cursor: next, done: rows.length < limit };
}

export async function handleBackfillIdpImpersonation(
  request: Request,
  env: Env,
  ctx: AuthContext,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const limit = parseIdpBackfillLimit(new URL(request.url).searchParams.get("limit"));
    const threats = await backfillThreatIdpTags(env, limit);
    const lookalikes = await backfillLookalikeIdpLures(env, limit);
    const data: IdpBackfillResult = { ...threats, done: threats.done && lookalikes.done, lookalikes };

    await audit(env, {
      action: "backfill_idp_impersonation",
      userId: ctx.userId,
      resourceType: "threats",
      details: { limit, threats, lookalikes },
      request,
    });
    return json({ success: true, data }, 200, origin);
  } catch {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

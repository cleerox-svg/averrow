// Averrow — one-off backfill: re-attribute IdP-family threats credited to an
// IdP VENDOR brand (Okta / OneLogin / Auth0 / Microsoft / Duo / Ping).
// POST /api/internal/backfills/idp-reattribution (AVERROW_INTERNAL_SECRET).
//
// Before the attribution fix (lib/brandDetect.ts idpLureParts + the
// IdP-tenant suffixes), `withpersona.okta-linksso.com` was credited to Okta
// because the lure token "okta" won as a clean token match. Owner decision
// (docs/IDP_IMPERSONATION_PLAN_2026-10.md, "Attribution — dual signal"):
// credit the TARGETED brand; the abused IdP lives in threats.impersonated_idp
// (this job never touches technique / impersonated_idp).
//
// Scope (bounded): threats whose technique is idp_lookalike / idp_tenant_abuse
// (device-code rows are excluded — no host lure, brand set by detectors),
// linked to a brand whose canonical_domain is in IDP_VENDOR_CANONICAL_DOMAINS,
// and whose host literally contains that brand's name (the lure-token credit
// the old matcher made; an AI- or page-context link is left alone).
// Per row: keep (current matcher still credits the vendor — e.g. the
// vendor-only okta-login-secure.com, or a leftover that is the same vendor's
// product: microsoftonline-outlook.live; or the host is the vendor's OWN
// infrastructure — reason vendor_official_domain), relink (matcher picks the
// targeted brand by a whole-token leftover match), or clear (nothing matches).
// Rows from brand-scoped generators (typosquat_scanner,
// numbered_variant_scan — permutations OF the vendor's own domain) are kept.
//
// Writes reuse brand_link_cleanup_log (migration 0271) in the same atomic
// (log, guarded UPDATE) pairs as lib/brand-link-cleanup.ts, under run_id
// `idp-reattribution` by default — so `POST /api/internal/brand-links/cleanup
// ?mode=undo&run_id=idp-reattribution&confirm=undo-brand-link-cleanup`
// reverts it. brands.threat_count / active_threat_count drift is NOT bumped
// here: the cube-healer's brand-count reconciler fixes it every 6h, or run
// `.../brand-links/cleanup?mode=reconcile` once after apply.

import type { Env } from "../../types";
import {
  fuzzyMatchBrandDetailed,
  loadBrands,
  normalizeBrand,
  type BrandMatchMethod,
  type BrandRow,
} from "../../lib/brandDetect";
import {
  IDP_TECHNIQUE,
  IDP_VENDOR_CANONICAL_DOMAINS,
  isIdpVendorOfficialHost,
} from "../../lib/idp-impersonation";
import { clampCursor } from "../../lib/brand-link-cleanup";

export const IDP_REATTRIBUTION_CONFIRM = "apply-idp-reattribution";
export const IDP_REATTRIBUTION_DEFAULT_LIMIT = 500;
export const IDP_REATTRIBUTION_MAX_LIMIT = 1000;
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const PAIRS_PER_BATCH = 50;

/** Brand-scoped generators whose link IS the generated-from brand. */
const PROTECTED_FEEDS: ReadonlySet<string> = new Set(["typosquat_scanner", "numbered_variant_scan"]);

export interface ReattributionRow {
  rid: number;
  id: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  ioc_value: string | null;
  source_feed: string | null;
  target_brand_id: string;
  brand_match_method: string | null;
  brand_name: string;
  brand_canonical: string | null;
  brand_tier: string | null;
  /** 1 when the threat already has a live brand_link_cleanup_log row. */
  logged?: number;
}

export type ReattributionAction = "keep" | "relink" | "clear";
export interface ReattributionDecision {
  action: ReattributionAction;
  newBrandId: string | null;
  method: BrandMatchMethod | null;
  /** Why a row was kept without re-matching. */
  keptBecause?: "still_matches" | "protected_feed" | "not_lure_credit" | "vendor_official_domain";
}

function haystacksOf(r: ReattributionRow): string[] {
  return [r.malicious_domain, r.malicious_url, r.ioc_value].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

/**
 * Pure per-row decision. `rematch` runs the full catalog matcher — it must
 * be catalog-aware: on an IdP-lure host the vendor is credited only when
 * the remainder matches NO brand (matchBrandToHost alone cannot know that).
 */
export function decideReattribution(
  row: ReattributionRow,
  rematch: (haystacks: string[]) => { brandId: string; method: BrandMatchMethod; vendorCredit?: true } | null,
): ReattributionDecision {
  const haystacks = haystacksOf(row);
  if (row.source_feed && PROTECTED_FEEDS.has(row.source_feed)) {
    return { action: "keep", newBrandId: null, method: null, keptBecause: "protected_feed" };
  }
  // The vendor's own infrastructure (*.partner.microsoftonline.cn — Azure
  // China; login.okta.com) is never re-attributed or cleared, whatever a
  // feed called it.
  if (haystacks.some((h) => isIdpVendorOfficialHost(h))) {
    return { action: "keep", newBrandId: null, method: null, keptBecause: "vendor_official_domain" };
  }
  const norm = normalizeBrand(row.brand_name);
  if (!norm || !haystacks.some((h) => h.toLowerCase().replace(/[^a-z0-9]/g, "").includes(norm))) {
    return { action: "keep", newBrandId: null, method: null, keptBecause: "not_lure_credit" };
  }
  const hit = rematch(haystacks);
  // Matcher credits the IdP vendor (no other brand evidence, or only the
  // vendor's own products: microsoftonline-outlook.live): keep the existing
  // vendor link rather than hop between duplicate vendor brand rows.
  if (hit && (hit.brandId === row.target_brand_id || hit.vendorCredit)) {
    return { action: "keep", newBrandId: null, method: hit.method, keptBecause: "still_matches" };
  }
  if (hit) {
    return { action: "relink", newBrandId: hit.brandId, method: hit.method };
  }
  return { action: "clear", newBrandId: null, method: null };
}

export interface ReattributionResult {
  mode: "dry_run" | "apply";
  run_id: string;
  scanned: number;
  keep: number;
  relink: number;
  clear: number;
  kept_by_reason: Record<string, number>;
  removed_by_brand: Record<string, number>;
  added_by_brand: Record<string, number>;
  /** dry_run: up to 25 sample decisions for operator review. */
  samples: Array<{ id: string; host: string | null; from: string; to: string | null; action: ReattributionAction }>;
  changed: number;
  /** Would change, but the threat already has a live brand_link_cleanup_log
   *  row (an earlier cleanup/run) — left untouched so every applied change
   *  stays undoable. */
  skipped_logged: number;
  next_cursor: number;
  done: boolean;
}

function bump(m: Record<string, number>, k: string): void {
  m[k] = (m[k] ?? 0) + 1;
}

export async function runIdpReattribution(
  env: Env,
  opts: { apply: boolean; cursor: number; limit: number; runId: string },
): Promise<ReattributionResult> {
  const vendorPh = IDP_VENDOR_CANONICAL_DOMAINS.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT t.rowid AS rid, t.id, t.malicious_domain, t.malicious_url, t.ioc_value, t.source_feed,
            t.target_brand_id, t.brand_match_method,
            b.name AS brand_name, b.canonical_domain AS brand_canonical, b.tier AS brand_tier,
            EXISTS (SELECT 1 FROM brand_link_cleanup_log l
                     WHERE l.threat_id = t.id AND l.undone_at IS NULL) AS logged
       FROM threats t
       JOIN brands b ON b.id = t.target_brand_id
      WHERE t.rowid > ?
        AND t.technique IN (?, ?)
        AND b.canonical_domain IN (${vendorPh})
      ORDER BY t.rowid
      LIMIT ?`,
  ).bind(
    opts.cursor, IDP_TECHNIQUE.idp_lookalike, IDP_TECHNIQUE.idp_tenant,
    ...IDP_VENDOR_CANONICAL_DOMAINS, opts.limit,
  ).all<ReattributionRow>();
  const list = rows.results ?? [];

  const result: ReattributionResult = {
    mode: opts.apply ? "apply" : "dry_run", run_id: opts.runId,
    scanned: list.length, keep: 0, relink: 0, clear: 0,
    kept_by_reason: {}, removed_by_brand: {}, added_by_brand: {}, samples: [],
    changed: 0, skipped_logged: 0, next_cursor: list.at(-1)?.rid ?? opts.cursor, done: list.length < opts.limit,
  };

  let catalog: BrandRow[] | null = null;
  const changes: Array<{ row: ReattributionRow; d: ReattributionDecision }> = [];
  for (const row of list) {
    let d = decideReattribution(row, () => null);
    if (d.action !== "keep") {
      catalog ??= await loadBrands(env.DB);
      const cat = catalog;
      d = decideReattribution(row, (h) => fuzzyMatchBrandDetailed(h, cat));
    }
    if (d.action !== "keep" && row.logged) {
      result.skipped_logged++;
      continue;
    }
    if (d.action === "keep") {
      result.keep++;
      bump(result.kept_by_reason, d.keptBecause ?? "unknown");
      continue;
    }
    result[d.action]++;
    bump(result.removed_by_brand, row.target_brand_id);
    if (d.newBrandId) bump(result.added_by_brand, d.newBrandId);
    if (result.samples.length < 25) {
      result.samples.push({
        id: row.id, host: row.malicious_domain ?? row.malicious_url,
        from: row.target_brand_id, to: d.newBrandId, action: d.action,
      });
    }
    changes.push({ row, d });
  }

  if (!opts.apply) return result;

  // Same (log, guarded UPDATE) pairing as lib/brand-link-cleanup.ts: one D1
  // batch = one transaction; the log row exists iff the UPDATE applied.
  for (let i = 0; i < changes.length; i += PAIRS_PER_BATCH) {
    const stmts: D1PreparedStatement[] = [];
    for (const { row, d } of changes.slice(i, i + PAIRS_PER_BATCH)) {
      stmts.push(env.DB.prepare(
        `INSERT INTO brand_link_cleanup_log
           (threat_id, old_brand_id, old_method, new_brand_id, new_method, action, reason, run_id, actor)
         SELECT ?, ?, ?, ?, ?, ?, 'idp_lure_credit', ?, 'internal'
          WHERE EXISTS (SELECT 1 FROM threats WHERE id = ? AND target_brand_id = ?)
         ON CONFLICT(threat_id) DO UPDATE SET
           old_brand_id = excluded.old_brand_id, old_method = excluded.old_method,
           new_brand_id = excluded.new_brand_id, new_method = excluded.new_method,
           action = excluded.action, reason = excluded.reason, run_id = excluded.run_id,
           actor = excluded.actor, created_at = datetime('now'), undone_at = NULL
         WHERE brand_link_cleanup_log.undone_at IS NOT NULL`,
      ).bind(
        row.id, row.target_brand_id, row.brand_match_method, d.newBrandId, d.method, d.action,
        opts.runId, row.id, row.target_brand_id,
      ));
      // Applies only if the log row just written is OURS: a concurrent or
      // earlier live entry (other run/reason) is never overwritten by the
      // INSERT above, so this UPDATE then matches 0 rows — no unlogged change.
      stmts.push(env.DB.prepare(
        `UPDATE threats SET target_brand_id = ?, brand_match_method = ?
          WHERE id = ? AND target_brand_id = ?
            AND EXISTS (SELECT 1 FROM brand_link_cleanup_log
                         WHERE threat_id = ? AND undone_at IS NULL AND run_id = ?
                           AND reason = 'idp_lure_credit' AND old_brand_id = ?)`,
      ).bind(d.newBrandId, d.method, row.id, row.target_brand_id, row.id, opts.runId, row.target_brand_id));
    }
    const res = await env.DB.batch(stmts);
    for (let j = 1; j < res.length; j += 2) result.changed += res[j]?.meta?.changes ?? 0;
  }
  // Raced with a concurrent log writer between scan and apply.
  result.skipped_logged += changes.length - result.changed;

  const { audit } = await import("../../lib/audit");
  await audit(env, {
    action: "backfill_idp_reattribution",
    userId: null,
    resourceType: "brand_link_cleanup",
    resourceId: opts.runId,
    details: {
      actor: "internal", cursor: opts.cursor, next_cursor: result.next_cursor,
      scanned: result.scanned, relink: result.relink, clear: result.clear, changed: result.changed,
      skipped_logged: result.skipped_logged,
    },
  });
  return result;
}

/**
 * POST /api/internal/backfills/idp-reattribution
 *   ?cursor=0&limit=500[&apply=1&confirm=apply-idp-reattribution][&run_id=idp-reattribution]
 * dry_run unless apply=1 + confirm. Loop on next_cursor until done.
 */
export async function handleIdpReattribution(url: URL, env: Env): Promise<Response> {
  const apply = url.searchParams.get("apply") === "1";
  if (apply && url.searchParams.get("confirm") !== IDP_REATTRIBUTION_CONFIRM) {
    return Response.json({ success: false, error: "apply requires the confirm parameter" }, { status: 400 });
  }
  const runId = url.searchParams.get("run_id") ?? "idp-reattribution";
  if (!RUN_ID_RE.test(runId)) {
    return Response.json({ success: false, error: "run_id must match [A-Za-z0-9_.:-]{1,64}" }, { status: 400 });
  }
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, IDP_REATTRIBUTION_MAX_LIMIT)
    : IDP_REATTRIBUTION_DEFAULT_LIMIT;
  try {
    const data = await runIdpReattribution(env, {
      apply, limit, runId, cursor: clampCursor(Number(url.searchParams.get("cursor") ?? "0")),
    });
    return Response.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

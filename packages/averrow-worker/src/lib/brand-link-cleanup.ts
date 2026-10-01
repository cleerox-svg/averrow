/**
 * Brand-link cleanup — re-validate existing threats.target_brand_id links
 * against the current brand matcher (lib/brandDetect.ts, PR #1727).
 *
 * Audit 2026-10-01: ~900K threats carried a brand link and an estimated
 * ~75% were wrong — generic-word brands ("Data" 164K, "Login" 88K),
 * JSON IOC blobs / hashes / IPs matched as free text, TLD labels
 * ("*.club" → Club). The matcher fix stops NEW wrong links; this job
 * repairs the existing ones.
 *
 * Per linked threat:
 *   keep    — the current brand still matches under the new rules
 *             (stamps brand_match_method when it was NULL)
 *   relink  — it doesn't, but the new matcher picks a different brand
 *             ("paypal-login.github.io": GitHub → PayPal)
 *   clear   — nothing matches; target_brand_id → NULL
 *
 * Every relink/clear is logged to brand_link_cleanup_log (migration 0271)
 * with the original brand, so the run is reversible. dry_run writes
 * nothing. apply requires an explicit confirm token. Batched by rowid
 * keyset (cursor) so callers loop until `done` — see
 * scripts/brand-link-cleanup.sh. When an apply run finishes, the brand
 * counters are reconciled (lib/brand-count-reconciler.ts).
 *
 * Caveat: links made by the Analyst's Haiku inference carry no
 * brand_match_method and are indistinguishable from fuzzy links, so they
 * are re-validated like any other; a cleared threat re-enters the
 * Analyst / backfill queues (target_brand_id IS NULL).
 */

import type { Env } from "../types";
import {
  fuzzyMatchBrandDetailed,
  isGenericBrand,
  isMatchableInput,
  loadBrands,
  matchBrandToHost,
  normalizeBrand,
  type BrandMatchMethod,
  type BrandRow,
} from "./brandDetect";

export type CleanupMode = "dry_run" | "apply";
export type CleanupAction = "keep" | "relink" | "clear";
export type CleanupReason = "non_hostname" | "generic_brand" | "missing_brand" | "no_rule_match";

/** Token the caller must pass to run in apply mode. */
export const APPLY_CONFIRM_TOKEN = "apply-brand-link-cleanup";

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 2000;

export interface LinkRow {
  rid: number;
  id: string;
  malicious_domain: string | null;
  malicious_url: string | null;
  ioc_value: string | null;
  target_brand_id: string;
  brand_match_method: string | null;
  brand_name: string | null;
  brand_canonical: string | null;
}

export interface LinkDecision {
  action: CleanupAction;
  /** keep: validated method; relink: new match's method. */
  method: BrandMatchMethod | null;
  newBrandId: string | null;
  reason: CleanupReason | null;
}

function haystacksOf(row: LinkRow): string[] {
  return [row.malicious_domain, row.malicious_url, row.ioc_value].filter(
    (v): v is string => v != null && v.length > 0,
  );
}

/**
 * Pure decision for one existing link. `rematch` is only called when the
 * current link fails validation (it needs the full brand catalog).
 */
export function decideLink(
  row: LinkRow,
  rematch: (haystacks: string[]) => { brandId: string; method: BrandMatchMethod } | null,
): LinkDecision {
  const haystacks = haystacksOf(row);

  if (row.brand_name !== null) {
    const current: BrandRow = {
      id: row.target_brand_id,
      name: row.brand_name,
      canonical_domain: row.brand_canonical ?? "",
    };
    for (const h of haystacks) {
      const method = matchBrandToHost(h, current);
      if (method) return { action: "keep", method, newBrandId: null, reason: null };
    }
  }

  let reason: CleanupReason;
  if (!haystacks.some(isMatchableInput)) reason = "non_hostname";
  else if (row.brand_name === null) reason = "missing_brand";
  else if (isGenericBrand(normalizeBrand(row.brand_name))) reason = "generic_brand";
  else reason = "no_rule_match";

  // Non-hostname inputs can't match anything — skip the catalog scan.
  const hit = reason === "non_hostname" ? null : rematch(haystacks);
  if (hit && hit.brandId !== row.target_brand_id) {
    return { action: "relink", method: hit.method, newBrandId: hit.brandId, reason };
  }
  return { action: "clear", method: null, newBrandId: null, reason };
}

export interface CleanupBatchResult {
  mode: CleanupMode;
  scanned: number;
  keep: number;
  relink: number;
  clear: number;
  keep_by_method: Record<string, number>;
  by_reason: Record<string, number>;
  /** Links removed (relinked away or cleared) per original brand. */
  removed_by_brand: Record<string, number>;
  /** Links gained per brand via relink. */
  added_by_brand: Record<string, number>;
  /** 'threat'-sourced alerts whose threat would lose/change its brand. */
  alerts_affected: number;
  written: number;
  next_cursor: number;
  done: boolean;
  reconciled?: { brandsChecked: number; drifted: number; fixed: number };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

/** D1 caps bound parameters per statement at 100. */
const IN_CHUNK = 90;
const WRITE_CHUNK = 100;

export async function runBrandLinkCleanup(
  env: Env,
  opts: { mode: CleanupMode; cursor: number; limit: number },
): Promise<CleanupBatchResult> {
  const { mode, cursor, limit } = opts;

  const rows = await env.DB.prepare(
    `SELECT t.rowid AS rid, t.id, t.malicious_domain, t.malicious_url, t.ioc_value,
            t.target_brand_id, t.brand_match_method,
            b.name AS brand_name, b.canonical_domain AS brand_canonical
       FROM threats t
       LEFT JOIN brands b ON b.id = t.target_brand_id
      WHERE t.rowid > ? AND t.target_brand_id IS NOT NULL
      ORDER BY t.rowid
      LIMIT ?`,
  ).bind(cursor, limit).all<LinkRow>();

  const result: CleanupBatchResult = {
    mode, scanned: rows.results.length, keep: 0, relink: 0, clear: 0,
    keep_by_method: {}, by_reason: {}, removed_by_brand: {}, added_by_brand: {},
    alerts_affected: 0, written: 0,
    next_cursor: rows.results.at(-1)?.rid ?? cursor,
    done: rows.results.length < limit,
  };

  // The catalog (100K+ rows) is loaded only if some link needs a re-match.
  let catalog: BrandRow[] | null = null;
  const rematchCatalog = (haystacks: string[]) => {
    if (!catalog) throw new Error("catalog not loaded");
    return fuzzyMatchBrandDetailed(haystacks, catalog);
  };

  const decisions: Array<{ row: LinkRow; d: LinkDecision }> = [];
  for (const row of rows.results) {
    let d = decideLink(row, () => null);
    if (d.action === "clear" && d.reason !== "non_hostname") {
      catalog ??= await loadBrands(env.DB);
      d = decideLink(row, rematchCatalog);
    }
    decisions.push({ row, d });

    if (d.action === "keep") {
      result.keep++;
      if (d.method) bump(result.keep_by_method, d.method);
      continue;
    }
    result[d.action]++;
    if (d.reason) bump(result.by_reason, d.reason);
    bump(result.removed_by_brand, row.target_brand_id);
    if (d.newBrandId) bump(result.added_by_brand, d.newBrandId);
  }

  const changedIds = decisions.filter((x) => x.d.action !== "keep").map((x) => x.row.id);
  for (let i = 0; i < changedIds.length; i += IN_CHUNK) {
    const chunk = changedIds.slice(i, i + IN_CHUNK);
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM alerts
        WHERE source_type = 'threat' AND source_id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(...chunk).first<{ n: number }>();
    result.alerts_affected += r?.n ?? 0;
  }

  if (mode === "apply") {
    const stmts: D1PreparedStatement[] = [];
    for (const { row, d } of decisions) {
      if (d.action === "keep") {
        if (row.brand_match_method === null && d.method) {
          stmts.push(env.DB.prepare(
            "UPDATE threats SET brand_match_method = ? WHERE id = ? AND brand_match_method IS NULL",
          ).bind(d.method, row.id));
        }
        continue;
      }
      // Log first (INSERT OR IGNORE keeps the ORIGINAL brand on re-runs),
      // then change the link only if nothing else moved it meanwhile.
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO brand_link_cleanup_log
           (threat_id, old_brand_id, new_brand_id, action, reason, new_method)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(row.id, row.target_brand_id, d.newBrandId, d.action, d.reason ?? "no_rule_match", d.method));
      stmts.push(env.DB.prepare(
        "UPDATE threats SET target_brand_id = ?, brand_match_method = ? WHERE id = ? AND target_brand_id = ?",
      ).bind(d.newBrandId, d.method, row.id, row.target_brand_id));
    }
    for (let i = 0; i < stmts.length; i += WRITE_CHUNK) {
      await env.DB.batch(stmts.slice(i, i + WRITE_CHUNK));
    }
    result.written = stmts.length;

    if (result.done) {
      const { reconcileBrandThreatCounts } = await import("./brand-count-reconciler");
      result.reconciled = await reconcileBrandThreatCounts(env);
    }
  }

  return result;
}

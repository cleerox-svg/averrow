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
 * Modes (each batched by rowid keyset — loop on next_cursor until done;
 * scripts/brand-link-cleanup.sh):
 *   dry_run   — decide + report, writes nothing (default)
 *   apply     — confirm token required. Each relink/clear logs the
 *               original brand + method to brand_link_cleanup_log
 *               (migration 0271) in the SAME atomic batch as the
 *               UPDATE guarded on the old brand, and only if that UPDATE
 *               will apply — so the log never records a change that
 *               didn't happen.
 *   undo      — confirm token required. Restores logged links only where
 *               the threat still holds the cleanup's value (later links
 *               are never overwritten); stamps undone_at.
 *   reconcile — one explicit brand-counter recompute
 *               (lib/brand-count-reconciler.ts); run once after apply/undo.
 * After apply/undo, threat_cube_brand / threat_cube_arcs older than the
 * cube-healer's 30-day window still carry the old attribution — rebuild
 * full history with scripts/cube-backfill.sh.
 *
 * SCOPE — only undo what the old buggy matcher made. A link that fails
 * the new rules is still KEPT (`kept_protected`) when:
 *   - its source_feed is a brand-scoped detector that sets the brand at
 *     insert (AUTHORITATIVE_FEEDS: typosquat/variant scans, CT, NRD, …), or
 *   - the pre-#1727 fuzzy matcher would not have produced it
 *     (legacyFuzzyMatched) — so the Analyst's Haiku inference, which also
 *     reads URL paths and page context, made it. First production dry-run
 *     batch: notifyhubss.net → Apple, serdtfngbfv3.pages.dev → Amazon.
 * Only a dangling brand id is cleared unconditionally.
 */

import type { Env } from "../types";
import {
  fuzzyMatchBrandDetailed,
  isGenericBrand,
  isMatchableInput,
  loadBrands,
  matchBrandToHost,
  normalizeBrand,
  levenshtein,
  stripObfuscation,
  type BrandMatchMethod,
  type BrandRow,
} from "./brandDetect";

export type CleanupMode = "dry_run" | "apply" | "undo" | "reconcile";
export type CleanupAction = "keep" | "relink" | "clear";
export type CleanupReason = "non_hostname" | "generic_brand" | "missing_brand" | "no_rule_match";

/** Tokens the caller must pass for the writing modes (accident guard, not auth). */
export const APPLY_CONFIRM_TOKEN = "apply-brand-link-cleanup";
export const UNDO_CONFIRM_TOKEN = "undo-brand-link-cleanup";

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
  brand_tier?: string | null;
  source_feed: string | null;
}

/**
 * Why a link that fails the new rules is still kept:
 *   authoritative_source — written by a brand-scoped detector that sets
 *     target_brand_id at insert because the domain was found AS a
 *     lookalike of that brand (typosquat/variant scans, CT, NRD, …).
 *   not_legacy_match — the pre-#1727 fuzzy matcher would NOT have produced
 *     this link, so something else did (the Analyst's Haiku inference,
 *     which also reads URL paths / page context). Not ours to undo.
 */
export type ProtectedReason = "authoritative_source" | "not_legacy_match";

/** source_feed values whose brand link is set at insert by a brand-scoped detector. */
export const AUTHORITATIVE_FEEDS: ReadonlySet<string> = new Set([
  "typosquat_scanner",     // feeds/typosquat_scanner.ts
  "numbered_variant_scan", // agents/analyst.ts
  "ct_logs",               // feeds/certstream.ts
  "nrd_hagezi",            // feeds/nrd_hagezi.ts
  "spam_trap",             // spam-trap.ts
  "abuse_mailbox",         // lib/abuse-mailbox-iocs.ts
]);

const LEGACY_GENERIC = new Set(["www", "one", "bit", "dns", "app", "web", "api", "cdn", "dev", "net", "goo"]);

/**
 * Would the PRE-#1727 matcher have linked these inputs to this brand?
 * Pairwise replica of its strategies 2–4 (raw substring incl. TLD and URL
 * path, filler-stripped substring, edit distance <= 2 on segments) plus the
 * Analyst keyword pre-match (alphanumeric-normalized substring). The
 * cleanup only undoes links this reproduces — i.e. links the buggy rules
 * made — and leaves AI- or detector-made links alone.
 */
export function legacyFuzzyMatched(haystacks: string[], brandName: string): boolean {
  const name = normalizeBrand(brandName);
  if (name.length < 4 || /^\d+$/.test(name) || LEGACY_GENERIC.has(name)) return false;
  for (const raw of haystacks) {
    const lower = raw.toLowerCase();
    if (lower.includes(name)) return true;
    if (stripObfuscation(lower).includes(name)) return true;
    if (lower.replace(/[^a-z0-9]/g, "").includes(name)) return true;
    if (name.length >= 5) {
      for (const seg of lower.split(/[.\-/]+/)) {
        if (seg.length < 3 || Math.abs(seg.length - name.length) > 2) continue;
        if (levenshtein(seg, name) <= 2) return true;
      }
    }
  }
  return false;
}

export interface LinkDecision {
  action: CleanupAction;
  /** keep: validated method; relink: new match's method. */
  method: BrandMatchMethod | null;
  newBrandId: string | null;
  reason: CleanupReason | null;
  /** Set on a `keep` that failed the new rules but is out of the cleanup's scope. */
  protectedBy?: ProtectedReason;
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
      tier: row.brand_tier,
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

  // Scope: only undo links the old buggy rules made. A dangling brand id
  // is always cleared.
  if (reason !== "missing_brand" && row.brand_name !== null) {
    if (row.source_feed && AUTHORITATIVE_FEEDS.has(row.source_feed)) {
      return { action: "keep", method: null, newBrandId: null, reason, protectedBy: "authoritative_source" };
    }
    if (!legacyFuzzyMatched(haystacks, row.brand_name)) {
      return { action: "keep", method: null, newBrandId: null, reason, protectedBy: "not_legacy_match" };
    }
  }

  // Non-hostname inputs can't match anything — skip the catalog scan.
  const hit = reason === "non_hostname" ? null : rematch(haystacks);
  if (hit && hit.brandId !== row.target_brand_id) {
    return { action: "relink", method: hit.method, newBrandId: hit.brandId, reason };
  }
  return { action: "clear", method: null, newBrandId: null, reason };
}

export interface CleanupBatchResult {
  mode: CleanupMode;
  run_id: string;
  scanned: number;
  keep: number;
  relink: number;
  clear: number;
  keep_by_method: Record<string, number>;
  /** Links that fail the new rules but are out of scope, by ProtectedReason. */
  kept_protected: Record<string, number>;
  by_reason: Record<string, number>;
  /** Links removed (relinked away or cleared) per original brand. */
  removed_by_brand: Record<string, number>;
  /** Links gained per brand via relink. */
  added_by_brand: Record<string, number>;
  /** 'threat'-sourced alerts whose threat would lose/change its brand. */
  alerts_affected: number;
  /** Threat rows actually changed (apply: relinked/cleared; undo: restored). */
  changed: number;
  /** undo: logged links skipped because the threat moved on since. */
  skipped: number;
  next_cursor: number;
  done: boolean;
  reconciled?: { brandsChecked: number; drifted: number; fixed: number };
}

export interface CleanupOptions {
  mode: CleanupMode;
  cursor: number;
  limit: number;
  /** Groups one cleanup run in the log (undo can target it). */
  runId: string;
  /** Who ran it: "internal" or "user:<id>". */
  actor: string;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

export function clampCursor(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(raw));
}

/** Pairs per D1 batch — each pair is (log, update); 100 statements. */
const PAIRS_PER_BATCH = 50;

function emptyResult(opts: CleanupOptions): CleanupBatchResult {
  return {
    mode: opts.mode, run_id: opts.runId, scanned: 0, keep: 0, relink: 0, clear: 0,
    keep_by_method: {}, kept_protected: {}, by_reason: {}, removed_by_brand: {}, added_by_brand: {},
    alerts_affected: 0, changed: 0, skipped: 0, next_cursor: opts.cursor, done: true,
  };
}

/** Sum `meta.changes` over the UPDATE statements at the given batch positions. */
function changesAt(results: unknown[], every: number, offset: number): number {
  let n = 0;
  for (let i = offset; i < results.length; i += every) {
    const r = results[i] as { meta?: { changes?: number } } | undefined;
    n += r?.meta?.changes ?? 0;
  }
  return n;
}

export async function runBrandLinkCleanup(env: Env, opts: CleanupOptions): Promise<CleanupBatchResult> {
  if (opts.mode === "reconcile") {
    const { reconcileBrandThreatCounts } = await import("./brand-count-reconciler");
    return { ...emptyResult(opts), reconciled: await reconcileBrandThreatCounts(env) };
  }
  if (opts.mode === "undo") return runUndo(env, opts);
  return runValidate(env, opts);
}

async function runValidate(env: Env, opts: CleanupOptions): Promise<CleanupBatchResult> {
  const { mode, cursor, limit } = opts;

  const rows = await env.DB.prepare(
    `SELECT t.rowid AS rid, t.id, t.malicious_domain, t.malicious_url, t.ioc_value,
            t.target_brand_id, t.brand_match_method,
            b.name AS brand_name, b.canonical_domain AS brand_canonical, b.tier AS brand_tier, t.source_feed
       FROM threats t
       LEFT JOIN brands b ON b.id = t.target_brand_id
      WHERE t.rowid > ? AND t.target_brand_id IS NOT NULL
      ORDER BY t.rowid
      LIMIT ?`,
  ).bind(cursor, limit).all<LinkRow>();

  const result: CleanupBatchResult = {
    ...emptyResult(opts),
    scanned: rows.results.length,
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
      if (d.protectedBy) bump(result.kept_protected, d.protectedBy);
      continue;
    }
    result[d.action]++;
    if (d.reason) bump(result.by_reason, d.reason);
    bump(result.removed_by_brand, row.target_brand_id);
    if (d.newBrandId) bump(result.added_by_brand, d.newBrandId);
  }

  const changes = decisions.filter((x) => x.d.action !== "keep");
  if (changes.length > 0) {
    // One indexed query per batch (idx_alerts_source, migration 0271).
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM alerts
        WHERE source_type = 'threat' AND source_id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(changes.map((x) => x.row.id))).first<{ n: number }>();
    result.alerts_affected = r?.n ?? 0;
  }

  if (mode !== "apply") return result;

  // Method stamps on kept links — independent, no log needed.
  const stamps = decisions
    .filter(({ row, d }) => d.action === "keep" && row.brand_match_method === null && d.method)
    .map(({ row, d }) => env.DB.prepare(
      "UPDATE threats SET brand_match_method = ? WHERE id = ? AND brand_match_method IS NULL",
    ).bind(d.method, row.id));
  for (let i = 0; i < stamps.length; i += PAIRS_PER_BATCH * 2) {
    await env.DB.batch(stamps.slice(i, i + PAIRS_PER_BATCH * 2));
  }

  // (log, update) pairs. A D1 batch is one transaction, and the log
  // INSERT's EXISTS uses the same guard as the UPDATE right after it, so
  // a log row exists iff the link was actually changed. ON CONFLICT
  // overwrites only an UNDONE entry — a live entry keeps its original.
  for (let i = 0; i < changes.length; i += PAIRS_PER_BATCH) {
    const stmts: D1PreparedStatement[] = [];
    for (const { row, d } of changes.slice(i, i + PAIRS_PER_BATCH)) {
      stmts.push(env.DB.prepare(
        `INSERT INTO brand_link_cleanup_log
           (threat_id, old_brand_id, old_method, new_brand_id, new_method, action, reason, run_id, actor)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM threats WHERE id = ? AND target_brand_id = ?)
         ON CONFLICT(threat_id) DO UPDATE SET
           old_brand_id = excluded.old_brand_id, old_method = excluded.old_method,
           new_brand_id = excluded.new_brand_id, new_method = excluded.new_method,
           action = excluded.action, reason = excluded.reason, run_id = excluded.run_id,
           actor = excluded.actor, created_at = datetime('now'), undone_at = NULL
         WHERE brand_link_cleanup_log.undone_at IS NOT NULL`,
      ).bind(
        row.id, row.target_brand_id, row.brand_match_method, d.newBrandId, d.method,
        d.action, d.reason ?? "no_rule_match", opts.runId, opts.actor,
        row.id, row.target_brand_id,
      ));
      stmts.push(env.DB.prepare(
        "UPDATE threats SET target_brand_id = ?, brand_match_method = ? WHERE id = ? AND target_brand_id = ?",
      ).bind(d.newBrandId, d.method, row.id, row.target_brand_id));
    }
    result.changed += changesAt(await env.DB.batch(stmts), 2, 1);
  }

  await auditBatch(env, opts, result);
  return result;
}

interface LogRow {
  rid: number;
  threat_id: string;
  old_brand_id: string;
  old_method: string | null;
  new_brand_id: string | null;
}

async function runUndo(env: Env, opts: CleanupOptions): Promise<CleanupBatchResult> {
  const rows = await env.DB.prepare(
    `SELECT rowid AS rid, threat_id, old_brand_id, old_method, new_brand_id
       FROM brand_link_cleanup_log
      WHERE rowid > ? AND undone_at IS NULL AND run_id = ?
      ORDER BY rowid
      LIMIT ?`,
  ).bind(opts.cursor, opts.runId, opts.limit).all<LogRow>();

  const result: CleanupBatchResult = {
    ...emptyResult(opts),
    scanned: rows.results.length,
    next_cursor: rows.results.at(-1)?.rid ?? opts.cursor,
    done: rows.results.length < opts.limit,
  };

  // (mark, restore) pairs in one transaction, both guarded on the threat
  // still holding the cleanup's value — a link set after the cleanup is
  // never overwritten and its log row stays live (counted as skipped).
  for (let i = 0; i < rows.results.length; i += PAIRS_PER_BATCH) {
    const stmts: D1PreparedStatement[] = [];
    for (const l of rows.results.slice(i, i + PAIRS_PER_BATCH)) {
      stmts.push(env.DB.prepare(
        `UPDATE brand_link_cleanup_log SET undone_at = datetime('now')
          WHERE threat_id = ? AND EXISTS (SELECT 1 FROM threats WHERE id = ? AND target_brand_id IS ?)`,
      ).bind(l.threat_id, l.threat_id, l.new_brand_id));
      stmts.push(env.DB.prepare(
        "UPDATE threats SET target_brand_id = ?, brand_match_method = ? WHERE id = ? AND target_brand_id IS ?",
      ).bind(l.old_brand_id, l.old_method, l.threat_id, l.new_brand_id));
    }
    result.changed += changesAt(await env.DB.batch(stmts), 2, 1);
  }
  result.skipped = result.scanned - result.changed;

  await auditBatch(env, opts, result);
  return result;
}

async function auditBatch(env: Env, opts: CleanupOptions, r: CleanupBatchResult): Promise<void> {
  const { audit } = await import("./audit");
  await audit(env, {
    action: `brand_links.cleanup.${opts.mode}`,
    userId: opts.actor.startsWith("user:") ? opts.actor.slice(5) : null,
    resourceType: "brand_link_cleanup",
    resourceId: opts.runId,
    details: {
      actor: opts.actor, cursor: opts.cursor, next_cursor: r.next_cursor,
      scanned: r.scanned, relink: r.relink, clear: r.clear, changed: r.changed, skipped: r.skipped,
    },
  });
}

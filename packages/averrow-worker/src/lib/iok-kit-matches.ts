// Averrow — phishing-kit (IOK) matches for page captures.
//
// Glue between the page_capture pipeline (lib/page-capture.ts) and the pure
// IOK evaluator (lib/iok-engine.ts): evaluates the vendored ruleset
// (src/data/iok/rules.json — "Rules: IOK by phish.report (ODbL)", see
// src/data/iok/SOURCE.md) over ONE stored capture's evidence and records the
// matches in `page_capture_kit_matches` (migration 0333), plus which ruleset
// commit evaluated the capture on `page_captures.kit_ruleset_commit`.
//
// CONTEXT ONLY. Nothing here creates an alert, touches severity / triage, or
// is read by a tenant route. The only reader is the staff detection detail
// (handlers/identityDetections.ts → `loadKitMatching`).

//
// The ruleset is passed in (lib/iok-ruleset.ts loads the vendored JSON), so
// importing this module for the read model does not load the rules.

import {
  buildIokEvidence, evaluateIokRules, IOK_FIELDS, IOK_MAX_MATCHES,
  type IokEvalStatus, type IokEvaluation, type IokEvidenceInput, type IokField, type IokRuleSet,
} from "./iok-engine";

/** Optional wall-clock cap per capture (honoured where time advances; the
 *  deterministic work budget in lib/iok-engine.ts is the binding limit). */
export const KIT_MATCH_TIME_BUDGET_MS = 1_500;

export interface KitMatchResult {
  status: IokEvalStatus;
  matched: number;
  evaluated: number;
  skipped: number;
  budget_exhausted: boolean;
  work: number;
  regex_rejected: number;
}

function d1Ts(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Delete the kit-match rows of up to 90 captures (D1's 100-bind cap). Used
 *  before a re-evaluation and by the capture expiry sweep. */
export function deleteKitMatchesStmt(db: D1Database, captureIds: string[]): D1PreparedStatement {
  const ids = captureIds.slice(0, 90);
  return db.prepare(
    `DELETE FROM page_capture_kit_matches WHERE capture_id IN (${ids.map(() => "?").join(", ")})`,
  ).bind(...ids);
}

/** Evaluate + persist for one capture. The capture row must already be
 *  finalized (captured | blocked). ONE batch: delete the capture's previous
 *  match rows (so a re-run under a refreshed ruleset leaves no stale match),
 *  insert the new set (≤ IOK_MAX_MATCHES, 7 binds each), stamp the capture
 *  with the ruleset commit, time and status. The status is always stamped —
 *  `partial` (budget ran out) and `truncated` (input clipped) say so, and
 *  never read as a clean "checked, no match". */
export async function recordKitMatches(
  db: D1Database,
  captureId: string,
  input: IokEvidenceInput,
  ruleset: IokRuleSet,
  now: Date = new Date(),
): Promise<KitMatchResult> {
  const evaluation: IokEvaluation = evaluateIokRules(ruleset, buildIokEvidence(input), {
    timeBudgetMs: KIT_MATCH_TIME_BUDGET_MS,
    now: () => Date.now(),
  });
  const ts = d1Ts(now);
  const commit = ruleset.source.commit;
  const stmts: D1PreparedStatement[] = [deleteKitMatchesStmt(db, [captureId])];
  for (const m of evaluation.matches.slice(0, IOK_MAX_MATCHES)) {
    stmts.push(db.prepare(
      `INSERT INTO page_capture_kit_matches
         (capture_id, rule_id, rule_title, rule_tags_json, approx_fields_json, ruleset_commit, matched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(capture_id, rule_id) DO UPDATE SET
         rule_title = excluded.rule_title,
         rule_tags_json = excluded.rule_tags_json,
         approx_fields_json = excluded.approx_fields_json,
         ruleset_commit = excluded.ruleset_commit,
         matched_at = excluded.matched_at`,
    ).bind(captureId, m.rule_id, m.title, JSON.stringify(m.tags), JSON.stringify(m.approximate_fields), commit, ts));
  }
  stmts.push(
    db.prepare(`UPDATE page_captures SET kit_ruleset_commit = ?, kit_evaluated_at = ?, kit_eval_status = ? WHERE id = ?`)
      .bind(commit, ts, evaluation.status, captureId),
  );
  await db.batch(stmts);
  return {
    status: evaluation.status,
    matched: evaluation.matches.length,
    evaluated: evaluation.evaluated,
    skipped: evaluation.skipped,
    budget_exhausted: evaluation.budget_exhausted,
    work: evaluation.work,
    regex_rejected: evaluation.regex_rejected,
  };
}

// ─── Staff read model ────────────────────────────────────────────────

export interface KitMatchView {
  rule_id: string;
  title: string;
  tags: string[];
  /** Non-exact evidence fields the rule reads; [] = exact fields only. */
  approximate_fields: IokField[];
  ruleset_commit: string;
  matched_at: string;
}

/** `captures[].kit_matching` on the staff detection detail. */
export interface KitMatchingView {
  /** IOK commit that evaluated this capture; null = not evaluated. */
  ruleset_commit: string | null;
  evaluated_at: string | null;
  /** complete | truncated (input clipped — "no match" is not conclusive) |
   *  partial (budget ended the run; only some rules ran) | null (not
   *  evaluated). */
  status: IokEvalStatus | null;
  matches: KitMatchView[];
  attribution: string;
}

export const KIT_MATCH_ATTRIBUTION = "Rules: IOK by phish.report (ODbL)";

function iso(v: string | null): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
}

const EVAL_STATUSES: readonly string[] = ["complete", "truncated", "partial"];
function evalStatus(v: string | null): IokEvalStatus | null {
  return v !== null && EVAL_STATUSES.includes(v) ? (v as IokEvalStatus) : null;
}

function parseFields(raw: string | null): IokField[] {
  return parseTags(raw).filter((f): f is IokField => (IOK_FIELDS as readonly string[]).includes(f));
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Matches for up to `captureIds.length` (≤ 5 on the detail) captures: one
 * PK-range read (`capture_id IN (…)` on the (capture_id, rule_id) PK).
 * Returns capture_id → matches.
 */
export async function loadKitMatches(db: Pick<D1Database, "prepare">, captureIds: string[]): Promise<Map<string, KitMatchView[]>> {
  const out = new Map<string, KitMatchView[]>();
  const ids = [...new Set(captureIds)].slice(0, 90);
  if (ids.length === 0) return out;
  const res = await db.prepare(
    `SELECT capture_id, rule_id, rule_title, rule_tags_json, approx_fields_json, ruleset_commit, matched_at
       FROM page_capture_kit_matches
      WHERE capture_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY capture_id, rule_id`,
  ).bind(...ids).all<{
    capture_id: string; rule_id: string; rule_title: string; rule_tags_json: string | null;
    approx_fields_json: string | null; ruleset_commit: string; matched_at: string;
  }>();
  for (const r of res.results ?? []) {
    const list = out.get(r.capture_id) ?? [];
    list.push({
      rule_id: r.rule_id,
      title: r.rule_title,
      tags: parseTags(r.rule_tags_json),
      approximate_fields: parseFields(r.approx_fields_json),
      ruleset_commit: r.ruleset_commit,
      matched_at: iso(r.matched_at) ?? r.matched_at,
    });
    out.set(r.capture_id, list);
  }
  return out;
}

export function toKitMatchingView(
  row: { kit_ruleset_commit: string | null; kit_evaluated_at: string | null; kit_eval_status: string | null },
  matches: KitMatchView[] | undefined,
): KitMatchingView {
  return {
    ruleset_commit: row.kit_ruleset_commit,
    evaluated_at: iso(row.kit_evaluated_at),
    status: row.kit_ruleset_commit ? evalStatus(row.kit_eval_status) : null,
    matches: matches ?? [],
    attribution: KIT_MATCH_ATTRIBUTION,
  };
}

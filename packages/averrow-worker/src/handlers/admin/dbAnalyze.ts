// Averrow — Internal: refresh planner statistics for one allowlisted index
// POST /api/internal/db/analyze?table=lookalike_domains|threats
// (AVERROW_INTERNAL_SECRET, inline check + the blanket internal-POST guard
// in index.ts).
//
// D1 never auto-runs ANALYZE, so a freshly created index has no
// sqlite_stat1 row until something analyzes it (cube_healer runs a weekly
// `ANALYZE threats` + `ANALYZE brands`; nothing periodic covers
// lookalike_domains). This endpoint closes that gap for the indexes the
// IdP-impersonation work added (migration 0288) without a migration.
//
// Why index-scoped and not `ANALYZE <table>`: a table-scoped ANALYZE walks
// EVERY index on the table, and D1 bills each row it walks as a read —
// on `threats` (dozens of indexes) that is the whole table times the index
// count (migration 0197 measured ~1M reads for one pass). SQLite's
// `ANALYZE <index-name>` refreshes the stat row for that one index only, so
// the cost is a single walk of that index. The partial
// idx_lookalike_idp_lure_live holds only registered, non-benign IdP-lure
// rows (a handful); idx_threats_technique_created is one full-table index
// walk — still a fraction of a table ANALYZE. The other indexes' stats are
// untouched (they keep whatever the last table ANALYZE wrote).
//
// The SQL is a fixed string per allowlisted key — the `table` query value is
// only ever used as a lookup key, never interpolated into SQL.

import { audit } from "../../lib/audit";
import type { Env } from "../../types";

export const ANALYZE_TARGETS = {
  lookalike_domains: { index: "idx_lookalike_idp_lure_live", sql: "ANALYZE idx_lookalike_idp_lure_live" },
  threats: { index: "idx_threats_technique_created", sql: "ANALYZE idx_threats_technique_created" },
} as const;

export type AnalyzeTable = keyof typeof ANALYZE_TARGETS;

export const ANALYZE_TABLES = Object.keys(ANALYZE_TARGETS) as AnalyzeTable[];

export function isAnalyzeTable(v: string | null): v is AnalyzeTable {
  return v !== null && Object.prototype.hasOwnProperty.call(ANALYZE_TARGETS, v);
}

/** Recorded as `details.actor` (audit_log.user_id NULL) — same label as the internal backfills. */
const INTERNAL_ACTOR = "internal";

export async function handleInternalDbAnalyze(request: Request, env: Env): Promise<Response> {
  const table = new URL(request.url).searchParams.get("table");
  if (!isAnalyzeTable(table)) {
    return Response.json(
      { success: false, error: `table must be one of ${ANALYZE_TABLES.join(", ")}` },
      { status: 400 },
    );
  }
  const target = ANALYZE_TARGETS[table];
  const base = { action: "db_analyze", userId: null, resourceType: table, resourceId: target.index, request };
  const started = Date.now();
  try {
    const res = await env.DB.prepare(target.sql).run();
    const data = {
      table,
      index: target.index,
      statement: target.sql,
      duration_ms: Date.now() - started,
      rows_read: res.meta?.rows_read ?? null,
      rows_written: res.meta?.rows_written ?? null,
    };
    await audit(env, { ...base, details: { actor: INTERNAL_ACTOR, ...data } });
    return Response.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit(env, {
      ...base, outcome: "failure",
      details: { actor: INTERNAL_ACTOR, table, index: target.index, error: message },
    });
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

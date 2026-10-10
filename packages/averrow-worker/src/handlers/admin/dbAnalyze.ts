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
// rows (a handful); idx_threats_technique_created is a full (non-partial)
// index, so its walk reads every threats row once — still far cheaper than
// a table ANALYZE, which reads every row once PER index. The other indexes'
// stats are untouched (they keep whatever the last table ANALYZE wrote).
//
// Cooldown: at most one successful ANALYZE per table per hour (KV
// `analyze:cooldown:<table>`, set only on success). A call inside the window
// returns 429 without touching D1.
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

export const ANALYZE_COOLDOWN_S = 3600;

export function analyzeCooldownKey(table: AnalyzeTable): string {
  return `analyze:cooldown:${table}`;
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
  const cooldownKey = analyzeCooldownKey(table);
  const now = Date.now();
  const until = Number.parseInt((await env.CACHE.get(cooldownKey)) ?? "", 10);
  if (Number.isFinite(until) && until > now) {
    return Response.json(
      { success: false, error: "cooldown", retry_after_s: Math.ceil((until - now) / 1000) },
      { status: 429 },
    );
  }
  const base = { action: "db_analyze", userId: null, resourceType: table, resourceId: target.index, request };
  const started = now;
  try {
    const res = await env.DB.prepare(target.sql).run();
    // Best-effort: a KV write failure must not report a completed ANALYZE as failed.
    await env.CACHE.put(cooldownKey, String(Date.now() + ANALYZE_COOLDOWN_S * 1000), {
      expirationTtl: ANALYZE_COOLDOWN_S,
    }).catch(() => undefined);
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
    return Response.json({ success: false, error: "An internal error occurred" }, { status: 500 });
  }
}

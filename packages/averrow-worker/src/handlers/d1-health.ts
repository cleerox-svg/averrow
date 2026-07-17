// Averrow — D1 Health Handler
//
// Focused database-level diagnostic. Designed for programmatic
// consumption (MCP tool, ops scripts) when investigating storage
// growth, query slowness, or schema drift. All queries are read-only.
//
// What's queryable from a Worker context:
//   - Page size + page count → database size in bytes
//   - sqlite_master → table / index counts and shapes
//   - Per-table row counts (capped at top N — full enumeration is
//     bounded but the per-table COUNTs are the heaviest reads)
//   - PRAGMA foreign_keys → enforcement state (we relied on this
//     for migration 0112's defer trick)
//   - PRAGMA foreign_key_check → broken FK count, GATED behind a
//     query param because it's an O(rows × FKs) scan
//   - d1_migrations → applied migration count + latest name
//   - Sample query latencies via meta.duration on canonical queries
//
// What requires CF API access (NOT in this endpoint):
//   - Replica lag, billing tier, throttle status — surfaced by
//     platform-diagnostics's d1_metrics_24h block from PR #834

import { json } from "../lib/cors";
import type { Env } from "../types";

interface TableRow {
  name: string;
  rows: number;
}

/** GET /api/admin/d1-health    (JWT super-admin auth)
 *  GET /api/internal/d1-health  (AVERROW_INTERNAL_SECRET auth)
 *
 *  Query params:
 *    check_fk=true — run PRAGMA foreign_key_check (slow, O(rows × FKs))
 */
export async function handleD1Health(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  const checkFk = url.searchParams.get("check_fk") === "true";
  const topNTables = Math.min(50, parseInt(url.searchParams.get("top_n") ?? "20", 10));

  try {
    // ─── Page geometry → database size ────────────────────────────
    // D1 restricts some PRAGMAs (returns SQLITE_AUTH). Wrap each in its
    // own try so one disallowed PRAGMA doesn't take the whole endpoint
    // down — non-fatal, just returns null for that field.
    const safeFirst = async <T>(sql: string): Promise<T | null> => {
      try {
        return await env.DB.prepare(sql).first<T>();
      } catch {
        return null;
      }
    };

    const [pageSize, pageCount, schemaVersion, fkPragma] = await Promise.all([
      safeFirst<{ page_size: number }>("PRAGMA page_size"),
      safeFirst<{ page_count: number }>("PRAGMA page_count"),
      safeFirst<{ schema_version: number }>("PRAGMA schema_version"),
      safeFirst<{ foreign_keys: number }>("PRAGMA foreign_keys"),
    ]);

    const sizeBytes = pageSize?.page_size && pageCount?.page_count
      ? pageSize.page_size * pageCount.page_count
      : null;

    // ─── Table + index inventory ──────────────────────────────────
    const [tables, indexes, partialIndexes] = await Promise.all([
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
      ).all<{ name: string }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
      ).first<{ n: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql LIKE '%WHERE%'"
      ).first<{ n: number }>(),
    ]);

    // ─── Per-table row counts (parallel, capped) ─────────────────
    // Each COUNT scans a table; on the largest tables (threats ~200K rows)
    // this is still cheap (a few ms). Cap at top_n results to bound the
    // diagnostic's overall cost.
    const tableNames = tables.results.map((r) => r.name);
    const countPromises = tableNames.map(async (name) => {
      try {
        const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>();
        return { name, rows: row?.n ?? 0 } as TableRow;
      } catch {
        // A table we can't COUNT on (permissions / virtual / FTS) — skip
        return null;
      }
    });
    const tableRows = (await Promise.all(countPromises)).filter((r): r is TableRow => r != null);
    tableRows.sort((a, b) => b.rows - a.rows);
    const topTables = tableRows.slice(0, topNTables);
    const totalRows = tableRows.reduce((s, t) => s + t.rows, 0);

    // ─── Migrations ───────────────────────────────────────────────
    const [migrationCount, latestMigration] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first<{ n: number }>(),
      env.DB.prepare(
        "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1"
      ).first<{ name: string }>(),
    ]);

    // ─── Sample query latency ─────────────────────────────────────
    // Three canonical queries — small, indexed lookups that should be
    // sub-10ms in steady state. Watching their timings drift over time
    // surfaces query planner regressions.
    const benchStart = Date.now();
    const benchA = Date.now();
    await env.DB.prepare("SELECT 1 AS n").first();
    const trivialMs = Date.now() - benchA;

    const benchB = Date.now();
    await env.DB.prepare("SELECT COUNT(*) AS n FROM brands").first();
    const brandsCountMs = Date.now() - benchB;

    const benchC = Date.now();
    await env.DB.prepare(
      "SELECT id FROM threats WHERE status='active' ORDER BY created_at DESC LIMIT 10"
    ).all();
    const threatsRecentMs = Date.now() - benchC;

    const totalBenchMs = Date.now() - benchStart;

    // ─── FK violations (optional, gated) ─────────────────────────
    let fkCheck: {
      enabled: boolean | null;
      checked: boolean;
      violations: number;
      sample: Array<{ table: string; rowid: number; parent: string; fkid: number }>;
    } = {
      enabled: fkPragma != null ? (fkPragma.foreign_keys ?? 0) === 1 : null,
      checked: false,
      violations: 0,
      sample: [],
    };

    if (checkFk) {
      try {
        const fkRows = await env.DB.prepare("PRAGMA foreign_key_check").all<{
          table: string;
          rowid: number;
          parent: string;
          fkid: number;
        }>();
        fkCheck = {
          enabled: fkCheck.enabled,
          checked: true,
          violations: fkRows.results.length,
          sample: fkRows.results.slice(0, 10),
        };
      } catch (err) {
        // Non-fatal — FK check is best-effort
        fkCheck = {
          enabled: fkCheck.enabled,
          checked: false,
          violations: 0,
          sample: [],
        };
        // Don't surface internals — silently skip
        void err;
      }
    }

    return json({
      success: true,
      data: {
        _meta: {
          generated_at: new Date().toISOString(),
          endpoint_version: 1,
        },
        database: {
          // Some fields may be null when D1 restricts the PRAGMA — that's
          // expected, not an error.
          size_bytes: sizeBytes,
          size_mb: sizeBytes != null ? Math.round((sizeBytes / 1024 / 1024) * 10) / 10 : null,
          page_size_bytes: pageSize?.page_size ?? null,
          page_count: pageCount?.page_count ?? null,
          schema_version: schemaVersion?.schema_version ?? null,
          fk_enforcement_on: fkPragma != null ? (fkPragma.foreign_keys ?? 0) === 1 : null,
        },
        inventory: {
          table_count: tableRows.length,
          index_count: indexes?.n ?? 0,
          partial_index_count: partialIndexes?.n ?? 0,
          total_rows: totalRows,
          top_tables_by_rows: topTables,
        },
        migrations: {
          applied_count: migrationCount?.n ?? 0,
          latest: latestMigration?.name ?? null,
        },
        fk_check: {
          ...fkCheck,
          enabled: fkCheck.enabled ?? false,
        },
        query_latency: {
          trivial_select_1_ms: trivialMs,
          brands_count_ms: brandsCountMs,
          threats_recent_10_ms: threatsRecentMs,
          total_bench_ms: totalBenchMs,
        },
      },
    }, 200, origin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ success: false, error: message }, 500, origin);
  }
}

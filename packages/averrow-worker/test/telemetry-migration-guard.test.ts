/**
 * Migrations after the telemetry cut-over (Track B1c).
 *
 * Once `db_route:telemetry` flips, the telemetry tables (agent_runs,
 * agent_configs, agent_events, agent_activity_log, agent_approvals,
 * agent_outputs, feed_*, budget_*) are written on TELEMETRY_DB. A core migration (migrations/) that
 * INSERTs, UPDATEs, DELETEs or ALTERs one of them — a seed row, a backfill,
 * a new index — would then change only core: the live copy on telemetry
 * never sees it (e.g. a new agent's agent_approvals grandfather row would
 * leave the agent blocked by the approval gate).
 *
 * Rule (CLAUDE.md §8): every core migration numbered above
 * CORE_MIGRATION_BASELINE that touches a telemetry table ships with a
 * migrations-telemetry/NNNN_*.sql that applies the same change and names
 * the core file it mirrors (`mirrors migrations/<core file name>`).
 * Migrations up to the baseline predate the cut-over and are covered by
 * migrations-telemetry/0001_init.sql (schema) and the cut-over copy
 * (POST /api/internal/telemetry/copy-config, /backfill).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Highest core migration when the guard landed (2026-11-22). Never raise it to dodge the rule. */
const CORE_MIGRATION_BASELINE = 337;

/** Every table that lives on TELEMETRY_DB: wave 1 + agent_outputs (wave 2, agents family). */
const TELEMETRY_TABLES = [
  "agent_runs", "agent_configs", "agent_events", "agent_activity_log", "agent_approvals",
  "feed_configs", "feed_status", "feed_pull_history", "budget_ledger", "budget_config", "agent_budget_rollups",
  "agent_outputs",
];

const CORE_DIR = resolve(__dirname, "..", "migrations");
const TEL_DIR = resolve(__dirname, "..", "migrations-telemetry");

const strip = (sql: string): string => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

/** Telemetry tables a migration writes or alters (DML + DDL). */
function telemetryTablesTouched(sql: string): string[] {
  const text = strip(sql);
  const hit = new Set<string>();
  for (const t of TELEMETRY_TABLES) {
    const re = new RegExp(
      `\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM|ALTER\\s+TABLE|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+\\w+\\s+ON|REPLACE\\s+INTO)\\s+${t}\\b`,
      "i",
    );
    if (re.test(text)) hit.add(t);
  }
  return [...hit];
}

function migrationNumber(file: string): number {
  return Number(file.slice(0, 4));
}

describe("telemetry migration guard", () => {
  const core = readdirSync(CORE_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const telemetryTexts = readdirSync(TEL_DIR).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(resolve(TEL_DIR, f), "utf8"));

  it("every new core migration touching a telemetry table has a migrations-telemetry mirror", () => {
    const missing: string[] = [];
    for (const file of core) {
      if (migrationNumber(file) <= CORE_MIGRATION_BASELINE) continue;
      const touched = telemetryTablesTouched(readFileSync(resolve(CORE_DIR, file), "utf8"));
      if (touched.length === 0) continue;
      const mirrored = telemetryTexts.some((t) => t.includes(`mirrors migrations/${file}`));
      if (!mirrored) missing.push(`${file} touches ${touched.join(", ")}`);
    }
    expect(missing, "add migrations-telemetry/NNNN_*.sql applying the same change, with a `-- mirrors migrations/<file>` line (CLAUDE.md §8)").toEqual([]);
  });

  it("the baseline is the highest core migration at the time the guard landed or later", () => {
    const max = Math.max(...core.map(migrationNumber));
    expect(max).toBeGreaterThanOrEqual(CORE_MIGRATION_BASELINE);
  });

  it("detects DML and DDL on telemetry tables (self-test)", () => {
    expect(telemetryTablesTouched("INSERT OR IGNORE INTO agent_approvals (agent_id) VALUES ('x');")).toEqual(["agent_approvals"]);
    expect(telemetryTablesTouched("UPDATE agent_configs SET enabled = 0;")).toEqual(["agent_configs"]);
    expect(telemetryTablesTouched("CREATE INDEX IF NOT EXISTS idx_x ON agent_runs(agent_id);")).toEqual(["agent_runs"]);
    expect(telemetryTablesTouched("ALTER TABLE feed_status ADD COLUMN x TEXT;")).toEqual(["feed_status"]);
    expect(telemetryTablesTouched("-- UPDATE agent_runs in a comment\nSELECT 1 FROM agent_runs;")).toEqual([]);
    expect(telemetryTablesTouched("UPDATE threats SET x = (SELECT 1 FROM agent_runs);")).toEqual([]);
    expect(telemetryTablesTouched("UPDATE agent_outputs SET agent_id = 'b' WHERE agent_id = 'a';")).toEqual(["agent_outputs"]);
  });
});

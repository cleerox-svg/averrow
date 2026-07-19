// S2.3 T1 — admin takedown list scope splitting.
//
// handleAdminListTakedowns splits the single admin queue into two
// purpose-scoped Ops surfaces via the `scope` param:
//   authorized (default) → tr.org_id IS NOT NULL (SOC execution view)
//   prospect             → tr.org_id IS NULL      (sales/pitch lane)
//   all                  → no org clause
// buildWhereClause is equality-only and cannot emit IS NULL, so the
// scope is a dedicated static SQL fragment. These tests assert the
// scope→SQL mapping, that brand_id narrows both the list and the
// scoped status_counts, and that status_counts carries the active
// scope (not the other list filters).

import { describe, it, expect } from "vitest";
import { handleAdminListTakedowns } from "../src/handlers/takedowns";
import type { Env } from "../src/types";

interface CapturedPrepare {
  sql: string;
  binds: unknown[];
}

// Classify each prepared statement so tests can assert on the right one.
function kindOf(sql: string): "list" | "count" | "status_counts" | "other" {
  if (sql.includes("GROUP BY status")) return "status_counts";
  if (sql.includes("COUNT(*) AS total")) return "count";
  if (sql.includes("evidence_count")) return "list";
  return "other";
}

function makeDb(captured: CapturedPrepare[]) {
  function prepare(sql: string) {
    return {
      bind: (...binds: unknown[]) => {
        captured.push({ sql, binds });
        return {
          all: async () => ({ results: [] }),
          first: async () => ({ total: 0 }),
        };
      },
    };
  }
  return { prepare } as unknown as Env["DB"];
}

function makeEnv(captured: CapturedPrepare[]): Env {
  return { DB: makeDb(captured) } as unknown as Env;
}

async function runList(query: string): Promise<{ captured: CapturedPrepare[]; body: Record<string, unknown> }> {
  const captured: CapturedPrepare[] = [];
  const env = makeEnv(captured);
  const req = new Request(`https://ops.local/api/admin/takedowns${query}`);
  const res = await handleAdminListTakedowns(req, env);
  const body = (await res.json()) as Record<string, unknown>;
  return { captured, body };
}

function byKind(captured: CapturedPrepare[], kind: ReturnType<typeof kindOf>): CapturedPrepare {
  const hit = captured.find((c) => kindOf(c.sql) === kind);
  if (!hit) throw new Error(`no prepared statement of kind ${kind}`);
  return hit;
}

describe("handleAdminListTakedowns — scope splitting", () => {
  it("defaults to authorized: org_id IS NOT NULL on list + count + status_counts", async () => {
    const { captured, body } = await runList("");

    expect(byKind(captured, "list").sql).toContain("tr.org_id IS NOT NULL");
    expect(byKind(captured, "list").sql).not.toContain("tr.org_id IS NULL AND"); // no IS NULL variant
    expect(byKind(captured, "count").sql).toContain("tr.org_id IS NOT NULL");
    expect(byKind(captured, "status_counts").sql).toContain("tr.org_id IS NOT NULL");
    expect(body.scope).toBe("authorized");
  });

  it("scope=prospect: org_id IS NULL on list + count + status_counts", async () => {
    const { captured, body } = await runList("?scope=prospect");

    const listSql = byKind(captured, "list").sql;
    expect(listSql).toContain("tr.org_id IS NULL");
    expect(listSql).not.toContain("tr.org_id IS NOT NULL");
    expect(byKind(captured, "count").sql).toContain("tr.org_id IS NULL");
    expect(byKind(captured, "status_counts").sql).toContain("tr.org_id IS NULL");
    expect(body.scope).toBe("prospect");
  });

  it("scope=all: no org clause anywhere, status_counts is unscoped 1=1", async () => {
    const { captured, body } = await runList("?scope=all");

    const listSql = byKind(captured, "list").sql;
    expect(listSql).not.toContain("tr.org_id IS NULL");
    expect(listSql).not.toContain("tr.org_id IS NOT NULL");

    const scSql = byKind(captured, "status_counts").sql;
    expect(scSql).not.toContain("tr.org_id IS NULL");
    expect(scSql).not.toContain("tr.org_id IS NOT NULL");
    expect(scSql).toContain("WHERE 1=1");
    expect(byKind(captured, "status_counts").binds).toEqual([]);
    expect(body.scope).toBe("all");
  });

  it("unknown scope falls back to authorized", async () => {
    const { captured, body } = await runList("?scope=bogus");
    expect(byKind(captured, "list").sql).toContain("tr.org_id IS NOT NULL");
    expect(body.scope).toBe("authorized");
  });

  it("brand_id narrows the list (equality binding) and the scoped status_counts", async () => {
    const { captured } = await runList("?scope=all&brand_id=brand-42");

    const list = byKind(captured, "list");
    expect(list.sql).toContain("tr.brand_id = ?");
    expect(list.binds).toContain("brand-42");

    const sc = byKind(captured, "status_counts");
    expect(sc.sql).toContain("tr.brand_id = ?");
    expect(sc.binds).toEqual(["brand-42"]);
  });

  it("status_counts carries scope + brand_id only, not the other list filters", async () => {
    // status/severity/target_type must NOT collapse the per-status breakdown.
    const { captured } = await runList("?scope=authorized&brand_id=b1&status=submitted&severity=critical&target_type=domain");

    const sc = byKind(captured, "status_counts");
    expect(sc.sql).toContain("tr.org_id IS NOT NULL");
    expect(sc.sql).toContain("tr.brand_id = ?");
    // scoped counts ignore status/severity/target_type
    expect(sc.sql).not.toContain("tr.status = ?");
    expect(sc.sql).not.toContain("tr.severity = ?");
    expect(sc.sql).not.toContain("tr.target_type = ?");
    expect(sc.binds).toEqual(["b1"]);

    // but the list query DOES apply all of them
    const list = byKind(captured, "list");
    expect(list.sql).toContain("tr.status = ?");
    expect(list.sql).toContain("tr.severity = ?");
    expect(list.sql).toContain("tr.target_type = ?");
    expect(list.binds).toEqual(expect.arrayContaining(["submitted", "critical", "domain", "b1"]));
  });
});

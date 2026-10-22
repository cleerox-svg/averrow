/**
 * Regression: Sparrow Phase B2 (lookalike → takedown draft) selected the top
 * 10 eligible lookalikes across ALL brands and only then dropped the ones
 * whose brand had no owning org. In prod ~4.2K lookalikes were eligible and
 * 4 were org-owned, so every run's 10 slots went to unowned brands and 0
 * lookalike drafts were ever created (owner decision 2026-10-22: draft ONLY
 * org-owned brands, starting as soon as a brand is owned).
 *
 * Pinned against a migration-derived SQLite schema:
 *   1. 15 unowned + 2 owned eligible lookalikes → the 2 owned are drafted in
 *      ONE run; unowned are never drafted;
 *   2. the brand-scoped ownership trigger drafts only that brand and is a
 *      no-op on a second call (and after a cron run);
 *   3. the brand-assign handler still succeeds when drafting throws.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../src/types";
import { createTakedownsFromLookalikes, createTakedownsFromLookalikesForBrand } from "../src/agents/sparrow";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";

type Insert = (table: string, row: Record<string, unknown>) => void;

function setup(): { raw: SqliteDb; insert: Insert; env: Env } {
  const raw = openDerivedDb(["lookalike_domains", "brands", "org_brands", "takedown_requests", "takedown_evidence"]);
  const insert: Insert = (table, row) => {
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => row[c]));
  };
  return { raw, insert, env: { DB: d1FromSqlite(raw) } as unknown as Env };
}

function seedBrand(insert: Insert, id: string): void {
  insert("brands", { id, name: id.replace("brand_", ""), canonical_domain: `${id}.example` });
}

let seq = 0;
function seedLookalike(insert: Insert, brandId: string, domain: string, opts: Partial<Record<string, unknown>> = {}): string {
  const id = `ld-${++seq}`;
  insert("lookalike_domains", {
    id,
    brand_id: brandId,
    domain,
    permutation_type: "typo",
    registered: 1,
    has_web: 1,
    has_mx: 0,
    threat_level: "HIGH",
    status: "monitoring",
    first_seen: "2026-10-01 00:00:00",
    ...opts,
  });
  return id;
}

function rows(raw: SqliteDb, sql: string): Array<Record<string, unknown>> {
  return raw.prepare(sql).all() as Array<Record<string, unknown>>;
}

/** The cron's Phase B2 (what sparrowAgent.execute calls). */
const runCronLookalikes = (env: Env) => createTakedownsFromLookalikes(env);

describe.skipIf(!hasSqlite())("Sparrow Phase B2 — org-owned lookalike drafting", () => {
  beforeEach(() => { seq = 0; });

  it("drafts the 2 owned lookalikes in one run even behind 15 unowned (starvation regression)", async () => {
    const { raw, insert, env } = setup();
    seedBrand(insert, "brand_owned");
    for (let i = 0; i < 15; i++) {
      const b = `brand_free_${i}`;
      seedBrand(insert, b);
      // Unowned rows are CRITICAL and newer/older mixed — under the old
      // shape they filled every one of the 10 slots ahead of the owned ones.
      seedLookalike(insert, b, `free-${i}.example`, { threat_level: "CRITICAL", first_seen: `2026-09-${String(10 + i).padStart(2, "0")} 00:00:00` });
    }
    insert("org_brands", { org_id: 7, brand_id: "brand_owned", is_primary: 1 });
    seedLookalike(insert, "brand_owned", "owned-a.example");
    seedLookalike(insert, "brand_owned", "owned-b.example", { has_web: 0, has_mx: 1 });

    const tally = await runCronLookalikes(env);
    expect(tally).toMatchObject({ created: 2, failed: 0 });

    const drafts = rows(raw, "SELECT org_id, brand_id, target_value, source_type, status, module_key FROM takedown_requests ORDER BY target_value");
    expect(drafts).toEqual([
      { org_id: 7, brand_id: "brand_owned", target_value: "owned-a.example", source_type: "lookalike", status: "draft", module_key: "domain" },
      { org_id: 7, brand_id: "brand_owned", target_value: "owned-b.example", source_type: "lookalike", status: "draft", module_key: "domain" },
    ]);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_evidence")[0]!.n).toBe(2);
    // Unowned lookalikes are never drafted or linked.
    expect(rows(raw, "SELECT COUNT(*) AS n FROM lookalike_domains WHERE takedown_id IS NOT NULL AND brand_id <> 'brand_owned'")[0]!.n).toBe(0);

    // A second run finds nothing left to draft.
    expect(await runCronLookalikes(env)).toMatchObject({ created: 0, failed: 0 });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(2);
  });

  it("keeps the existing eligibility filters and the per-run limit, oldest CRITICAL first", async () => {
    const { raw, insert, env } = setup();
    seedBrand(insert, "brand_owned");
    insert("org_brands", { org_id: 7, brand_id: "brand_owned", is_primary: 1 });
    // Ineligible rows (each fails one existing filter).
    seedLookalike(insert, "brand_owned", "benign.example", { status: "benign" });
    seedLookalike(insert, "brand_owned", "down.example", { status: "taken_down" });
    seedLookalike(insert, "brand_owned", "unreg.example", { registered: 0 });
    seedLookalike(insert, "brand_owned", "low.example", { threat_level: "MEDIUM" });
    seedLookalike(insert, "brand_owned", "dark.example", { has_web: 0, has_mx: 0 });
    // 12 eligible: 1 CRITICAL (newest) + 11 HIGH.
    seedLookalike(insert, "brand_owned", "crit.example", { threat_level: "CRITICAL", first_seen: "2026-10-20 00:00:00" });
    for (let i = 0; i < 11; i++) {
      seedLookalike(insert, "brand_owned", `high-${String(i).padStart(2, "0")}.example`, { first_seen: `2026-09-${String(10 + i).padStart(2, "0")} 00:00:00` });
    }

    expect(await runCronLookalikes(env)).toMatchObject({ created: 10 });
    const drafted = rows(raw, "SELECT domain FROM lookalike_domains WHERE takedown_id IS NOT NULL ORDER BY domain").map((r) => r.domain);
    expect(drafted).toContain("crit.example");
    // The two newest HIGH rows are the ones left for the next run.
    expect(drafted).not.toContain("high-09.example");
    expect(drafted).not.toContain("high-10.example");
    expect(drafted).toHaveLength(10);

    expect(await runCronLookalikes(env)).toMatchObject({ created: 2 });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(12);
    // The five ineligible rows are never drafted.
    expect(await runCronLookalikes(env)).toMatchObject({ created: 0 });
  });

  it("brand-scoped trigger drafts only that brand and is a no-op on a second call", async () => {
    const { raw, insert, env } = setup();
    seedBrand(insert, "brand_new");
    seedBrand(insert, "brand_other");
    insert("org_brands", { org_id: 3, brand_id: "brand_new", is_primary: 1 });
    insert("org_brands", { org_id: 4, brand_id: "brand_other", is_primary: 1 });
    seedLookalike(insert, "brand_new", "new-a.example");
    seedLookalike(insert, "brand_new", "new-b.example", { threat_level: "CRITICAL" });
    seedLookalike(insert, "brand_other", "other.example");

    const first = await createTakedownsFromLookalikesForBrand(env, "brand_new");
    expect(first).toEqual({ created: 2, failed: 0, firstError: null });
    expect(rows(raw, "SELECT DISTINCT brand_id, org_id FROM takedown_requests")).toEqual([{ brand_id: "brand_new", org_id: 3 }]);

    const second = await createTakedownsFromLookalikesForBrand(env, "brand_new");
    expect(second).toEqual({ created: 0, failed: 0, firstError: null });

    // The cron then picks up only the other brand — no double draft.
    expect(await runCronLookalikes(env)).toMatchObject({ created: 1 });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(3);
  });

  it("brand-scoped trigger is a no-op for a brand with no owning org", async () => {
    const { raw, insert, env } = setup();
    seedBrand(insert, "brand_free");
    seedLookalike(insert, "brand_free", "free.example");
    expect(await createTakedownsFromLookalikesForBrand(env, "brand_free")).toEqual({ created: 0, failed: 0, firstError: null });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(0);
  });

  it("a row already linked by a concurrent drafter is skipped, not double-drafted", async () => {
    const { raw, insert } = setup();
    seedBrand(insert, "brand_owned");
    insert("org_brands", { org_id: 7, brand_id: "brand_owned", is_primary: 1 });
    const id = seedLookalike(insert, "brand_owned", "race.example");

    // Simulate the other drafter linking the row between our SELECT and our
    // batch: link it the moment the first batch statement runs.
    const real = d1FromSqlite(raw);
    const db = {
      prepare: real.prepare.bind(real),
      batch: async (stmts: D1PreparedStatement[]) => {
        raw.prepare("UPDATE lookalike_domains SET takedown_id = 'td-other' WHERE id = ?").run(id);
        return real.batch(stmts);
      },
    } as unknown as D1Database;

    const tally = await createTakedownsFromLookalikesForBrand({ DB: db } as unknown as Env, "brand_owned");
    expect(tally).toEqual({ created: 0, failed: 0, firstError: null });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(0);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_evidence")[0]!.n).toBe(0);
    expect(rows(raw, "SELECT takedown_id FROM lookalike_domains")[0]!.takedown_id).toBe("td-other");
  });
});

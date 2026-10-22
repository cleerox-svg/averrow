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
 *
 * PR #1862 appsec review (a customer org admin can claim any catalog brand):
 *   4. ownership is the EARLIEST claim — a later claimant with is_primary=1
 *      does not take the brand over; the hook called with the later org
 *      drafts nothing, the cron drafts into the original owner;
 *   5. Phase G re-checks org_brands(org_id, brand_id) before submitting and
 *      leaves a takedown in draft once its org no longer holds the brand.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Env } from "../src/types";

const dispatchSubmission = vi.fn(async () => ({
  result: {
    outcome: "queued" as const,
    submitter_kind: "email_draft",
    submitter_target: "abuse@registrar.example",
    request_summary: "draft",
  },
  submission_id: "sub-1",
}));
vi.mock("../src/lib/takedown-submitters", () => ({ dispatchSubmission }));
vi.mock("../src/lib/notifications", () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock("../src/lib/org-events", () => ({ emitOrgEvent: vi.fn(async () => undefined) }));

import {
  createTakedownsFromLookalikes, createTakedownsFromLookalikesForBrand, resolveOwningOrgId, runPhaseGAutoSubmit,
} from "../src/agents/sparrow";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";

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

    const first = await createTakedownsFromLookalikesForBrand(env, "brand_new", 3);
    expect(first).toEqual({ created: 2, failed: 0, firstError: null });
    expect(rows(raw, "SELECT DISTINCT brand_id, org_id FROM takedown_requests")).toEqual([{ brand_id: "brand_new", org_id: 3 }]);

    const second = await createTakedownsFromLookalikesForBrand(env, "brand_new", 3);
    expect(second).toEqual({ created: 0, failed: 0, firstError: null });

    // The cron then picks up only the other brand — no double draft.
    expect(await runCronLookalikes(env)).toMatchObject({ created: 1 });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(3);
  });

  it("brand-scoped trigger is a no-op for a brand with no owning org", async () => {
    const { raw, insert, env } = setup();
    seedBrand(insert, "brand_free");
    seedLookalike(insert, "brand_free", "free.example");
    expect(await createTakedownsFromLookalikesForBrand(env, "brand_free", 1)).toEqual({ created: 0, failed: 0, firstError: null });
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

    const tally = await createTakedownsFromLookalikesForBrand({ DB: db } as unknown as Env, "brand_owned", 7);
    expect(tally).toEqual({ created: 0, failed: 0, firstError: null });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(0);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_evidence")[0]!.n).toBe(0);
    expect(rows(raw, "SELECT takedown_id FROM lookalike_domains")[0]!.takedown_id).toBe("td-other");
  });
});

describe.skipIf(!hasSqlite())("ownership = earliest claim (a later is_primary claim can't take a brand over)", () => {
  beforeEach(() => { seq = 0; });

  /** Org 7 claims first (is_primary 0); org 8 claims the same brand later with is_primary 1. */
  function contested(sameSecond: boolean): ReturnType<typeof setup> {
    const s = setup();
    seedBrand(s.insert, "brand_acme");
    s.insert("org_brands", {
      org_id: 7, brand_id: "brand_acme", is_primary: 0,
      ...(sameSecond ? { created_at: "2026-10-22 10:00:00" } : { created_at: "2026-10-01 10:00:00" }),
    });
    s.insert("org_brands", { org_id: 8, brand_id: "brand_acme", is_primary: 1, created_at: "2026-10-22 10:00:00" });
    seedLookalike(s.insert, "brand_acme", "acme-login.example");
    seedLookalike(s.insert, "brand_acme", "acme-pay.example", { threat_level: "CRITICAL" });
    return s;
  }

  for (const sameSecond of [false, true]) {
    const label = sameSecond ? "same-second claims (id tie-break)" : "earlier created_at";
    it(`resolution stays with the original owner — ${label}`, async () => {
      const { env } = contested(sameSecond);
      expect(await resolveOwningOrgId(env, "brand_acme")).toBe(7);
    });

    it(`the hook called with the later claimant drafts nothing; the cron drafts into the owner — ${label}`, async () => {
      const { raw, env } = contested(sameSecond);

      expect(await createTakedownsFromLookalikesForBrand(env, "brand_acme", 8)).toEqual({ created: 0, failed: 0, firstError: null });
      expect(rows(raw, "SELECT COUNT(*) AS n FROM takedown_requests")[0]!.n).toBe(0);
      expect(rows(raw, "SELECT COUNT(*) AS n FROM lookalike_domains WHERE takedown_id IS NOT NULL")[0]!.n).toBe(0);

      expect(await runCronLookalikes(env)).toMatchObject({ created: 2, failed: 0 });
      expect(rows(raw, "SELECT DISTINCT org_id FROM takedown_requests")).toEqual([{ org_id: 7 }]);
    });
  }

  it("the hook called with the owner drafts into the owner", async () => {
    const { raw, env } = contested(false);
    expect(await createTakedownsFromLookalikesForBrand(env, "brand_acme", 7)).toEqual({ created: 2, failed: 0, firstError: null });
    expect(rows(raw, "SELECT DISTINCT org_id FROM takedown_requests")).toEqual([{ org_id: 7 }]);
  });

  it("ownership passes to the next claimant only once the original claim is removed", async () => {
    const { raw, env } = contested(false);
    raw.prepare("DELETE FROM org_brands WHERE org_id = 7").run();
    expect(await resolveOwningOrgId(env, "brand_acme")).toBe(8);
  });
});

describe.skipIf(!hasSqlite())("Phase G re-checks the brand claim before submitting", () => {
  function phaseGSetup(): { raw: SqliteDb; env: Env } {
    const raw = openDerivedDb([
      "takedown_requests", "takedown_submissions", "takedown_authorizations", "takedown_providers",
      "org_brands", "org_modules", "org_members", "users",
    ]);
    const scope = {
      modules: ["domain"], max_takedowns_per_month: null, escalation: "manual_only",
      auto_followup_breached_sla_hours: null, mode: "auto",
      semi_auto_rules: { auto_severities: [], auto_target_types: [], auto_provider_types: [] },
    };
    raw.exec(`
      INSERT INTO org_brands (org_id, brand_id) VALUES (42, 'b_owned');
      INSERT INTO org_brands (org_id, brand_id) VALUES (42, 'b_released');
      INSERT INTO org_modules (org_id, module_key, status) VALUES (42, 'domain', 'active');
      INSERT INTO takedown_providers (provider_name, provider_type, abuse_email, auto_submit_enabled)
        VALUES ('GoDaddy', 'registrar', 'abuse@registrar.example', 1);
    `);
    raw.prepare(
      `INSERT INTO takedown_authorizations (id, org_id, agreement_version, status, signed_at, signed_by_user_id, scope_json)
       VALUES ('auth1', 42, 'v1', 'active', datetime('now'), 't_cust', ?)`,
    ).run(JSON.stringify(scope));
    const td = raw.prepare(
      `INSERT INTO takedown_requests (id, org_id, brand_id, target_type, target_value, evidence_summary,
         provider_name, module_key, status, severity)
       VALUES (?, 42, ?, 'domain', ?, 'phish', 'GoDaddy', 'domain', 'draft', 'CRITICAL')`,
    );
    td.run("td_owned", "b_owned", "owned.example");
    td.run("td_released", "b_released", "released.example");
    return { raw, env: { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env };
  }

  const dispatchedIds = () =>
    dispatchSubmission.mock.calls.map((c) => (c as unknown as [unknown, { id: string }])[1].id);
  const statusOf = (raw: SqliteDb, id: string) =>
    (raw.prepare("SELECT status FROM takedown_requests WHERE id = ?").get(id) as { status: string }).status;

  beforeEach(() => { dispatchSubmission.mockClear(); });

  it("submits while the org holds the brand, skips (leaves draft) once the claim is gone", async () => {
    const { raw, env } = phaseGSetup();
    raw.prepare("DELETE FROM org_brands WHERE brand_id = 'b_released'").run();

    const res = await runPhaseGAutoSubmit(env);
    expect(res).toEqual({ submitted: 1, skipped: 1, skipped_brand_not_owned: 1 });
    expect(dispatchedIds()).toEqual(["td_owned"]);
    expect(statusOf(raw, "td_owned")).toBe("submitted");
    expect(statusOf(raw, "td_released")).toBe("draft");
  });

  it("a takedown whose brand is held only by a DIFFERENT org is skipped", async () => {
    const { raw, env } = phaseGSetup();
    raw.prepare("UPDATE org_brands SET org_id = 43 WHERE brand_id = 'b_released'").run();

    const res = await runPhaseGAutoSubmit(env);
    expect(res.skipped_brand_not_owned).toBe(1);
    expect(dispatchedIds()).toEqual(["td_owned"]);
    expect(statusOf(raw, "td_released")).toBe("draft");
  });

  it("the claim UPDATE repeats the check: a claim removed after selection → no send, row stays draft", async () => {
    const { raw, env } = phaseGSetup();
    raw.prepare("DELETE FROM takedown_requests WHERE id = 'td_released'").run();
    // Remove the org's brand claim right after the candidate SELECT.
    const real = env.DB;
    const racedEnv = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          const stmt = real.prepare(sql);
          if (!sql.includes("FROM takedown_requests tr")) return stmt;
          return {
            bind: (...b: unknown[]) => {
              const bound = stmt.bind(...b);
              return {
                all: async () => {
                  const out = await bound.all();
                  raw.prepare("DELETE FROM org_brands WHERE brand_id = 'b_owned'").run();
                  return out;
                },
              };
            },
          };
        },
        batch: real.batch.bind(real),
      } as unknown as D1Database,
    } as Env;

    const res = await runPhaseGAutoSubmit(racedEnv);
    expect(res.submitted).toBe(0);
    expect(dispatchSubmission).not.toHaveBeenCalled();
    expect(statusOf(raw, "td_owned")).toBe("draft");
  });
});

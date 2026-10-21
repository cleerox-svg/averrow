/**
 * Regression: Sparrow auto-paused on 2026-06-30 after three consecutive runs
 * failed with `NOT NULL constraint failed: takedown_requests.brand_id`.
 * Phase B3 (abuse-mailbox → takedown) selected messages with no brand_id and
 * inserted a draft carrying that NULL; the throw escaped the agent.
 *
 * Pinned here against a migration-derived SQLite schema (so the real
 * NOT NULL constraint is enforced):
 *   1. a brandless abuse-report candidate is skipped at selection — no
 *      insert, no failure, left unstamped for a later brand attribution;
 *   2. a per-candidate write failure is caught and counted, never thrown,
 *      and the other candidates in the run still draft.
 */
import { describe, it, expect } from "vitest";
import type { Env } from "../src/types";
import { createTakedownsFromAbuseReports } from "../src/agents/sparrow";
import { hasSqlite, openDerivedDb, d1FromSqlite, type SqliteDb } from "./sqlite-d1-harness";

const ORG = 2;

function setup(): { raw: SqliteDb; insert: (table: string, row: Record<string, unknown>) => void } {
  const raw = openDerivedDb(["abuse_inbox_messages", "threats", "takedown_requests", "takedown_evidence"]);
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .run(...cols.map((c) => row[c]));
  };
  return { raw, insert };
}

function seedMessage(
  insert: (table: string, row: Record<string, unknown>) => void,
  id: string,
  brandId: string | null,
  threatIds: string[],
): void {
  insert("abuse_inbox_messages", {
    id,
    org_id: ORG,
    brand_id: brandId,
    classification: "phishing",
    severity: "HIGH",
    classified_by: "ai",
    promoted_threat_ids: JSON.stringify(threatIds),
    received_at: "2026-05-19 18:33:44",
  });
}

function seedThreat(insert: (table: string, row: Record<string, unknown>) => void, id: string, domain: string): void {
  insert("threats", {
    id,
    threat_type: "phishing",
    malicious_domain: domain,
    malicious_url: `https://${domain}/login`,
    source_feed: "abuse_mailbox",
    status: "active",
  });
}

function rows(raw: SqliteDb, sql: string): Array<Record<string, unknown>> {
  return raw.prepare(sql).all() as Array<Record<string, unknown>>;
}

describe.skipIf(!hasSqlite())("Sparrow Phase B3 — brandless abuse-report candidates", () => {
  it("the derived schema enforces prod's takedown_requests.brand_id NOT NULL", () => {
    const { insert } = setup();
    expect(() =>
      insert("takedown_requests", {
        id: "td-null", org_id: ORG, brand_id: null, target_type: "url", target_value: "x.example",
        evidence_summary: "x", status: "draft",
      }),
    ).toThrow(/NOT NULL constraint failed: takedown_requests\.brand_id/);
  });

  it("skips a brandless message (no insert, no failure) and drafts the branded one", async () => {
    const { raw, insert } = setup();
    // Mirrors prod message 573ae8ad…: org-bound, confirmed phishing, no brand.
    seedThreat(insert, "thr-brandless", "brandless-phish.example");
    seedMessage(insert, "msg-brandless", null, ["thr-brandless"]);
    seedThreat(insert, "thr-branded", "branded-phish.example");
    seedMessage(insert, "msg-branded", "brand_acme", ["thr-branded"]);

    const env = { DB: d1FromSqlite(raw) } as unknown as Env;
    const tally = await createTakedownsFromAbuseReports(env);

    expect(tally).toEqual({ created: 1, failed: 0, firstError: null });

    const drafts = rows(raw, "SELECT brand_id, target_value, source_type, source_id FROM takedown_requests");
    expect(drafts).toEqual([
      { brand_id: "brand_acme", target_value: "branded-phish.example", source_type: "abuse_report", source_id: "msg-branded" },
    ]);
    expect(rows(raw, "SELECT takedown_id FROM takedown_evidence")).toHaveLength(1);

    // Brandless message is left unstamped so a later brand attribution can
    // still draft it; the branded one is stamped as processed.
    const stamps = rows(raw, "SELECT id, takedown_drafted_at FROM abuse_inbox_messages ORDER BY id");
    expect(stamps.find((m) => m.id === "msg-brandless")?.takedown_drafted_at).toBeNull();
    expect(stamps.find((m) => m.id === "msg-branded")?.takedown_drafted_at).not.toBeNull();
  });

  it("catches and counts a per-candidate write failure instead of throwing", async () => {
    const { raw, insert } = setup();
    seedThreat(insert, "thr-bad", "bad.example");
    seedThreat(insert, "thr-good", "good.example");
    seedMessage(insert, "msg-mixed", "brand_acme", ["thr-bad", "thr-good"]);
    seedThreat(insert, "thr-other", "other.example");
    seedMessage(insert, "msg-other", "brand_acme", ["thr-other"]);

    // Fail the takedown_requests INSERT for one domain only.
    const real = d1FromSqlite(raw);
    const db = {
      prepare: (sql: string) => {
        const stmt = real.prepare(sql);
        if (!sql.includes("INSERT INTO takedown_requests")) return stmt;
        return {
          ...stmt,
          bind: (...args: unknown[]) => {
            if (args.includes("bad.example")) {
              const boom = { run: async () => { throw new Error("D1_ERROR: simulated write failure"); } };
              return boom as unknown as D1PreparedStatement;
            }
            return stmt.bind(...args);
          },
        } as unknown as D1PreparedStatement;
      },
      batch: real.batch.bind(real),
    } as unknown as D1Database;

    const tally = await createTakedownsFromAbuseReports({ DB: db } as unknown as Env);

    expect(tally.created).toBe(2);
    expect(tally.failed).toBe(1);
    expect(tally.firstError).toMatch(/abuse_report msg-mixed\/thr-bad: D1_ERROR: simulated write failure/);

    const targets = rows(raw, "SELECT target_value FROM takedown_requests ORDER BY target_value").map((r) => r.target_value);
    expect(targets).toEqual(["good.example", "other.example"]);

    // The message with a failed draft stays unstamped so the failure retries;
    // the fully-handled message is stamped.
    const stamps = rows(raw, "SELECT id, takedown_drafted_at FROM abuse_inbox_messages");
    expect(stamps.find((m) => m.id === "msg-mixed")?.takedown_drafted_at).toBeNull();
    expect(stamps.find((m) => m.id === "msg-other")?.takedown_drafted_at).not.toBeNull();
  });

  it("every Sparrow takedown creator returns a DraftTally and catches per candidate", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/agents/sparrow.ts"), "utf-8");
    const creators = [
      "createTakedownsFromMaliciousUrls",
      "createTakedownsFromLookalikes",
      "createTakedownsFromAbuseReports",
      "createTakedownsFromImpersonations",
      "createTakedownsFromAppStoreImpersonations",
      "createTakedownsFromDarkWebMentions",
    ];
    for (const fn of creators) {
      expect(src, fn).toMatch(new RegExp(`async function ${fn}\\(env: Env\\): Promise<DraftTally>`));
    }
    // One recordDraftFailure per single-loop creator, two in B3 (per threat + per message).
    expect((src.match(/recordDraftFailure\(tally,/g) ?? []).length).toBeGreaterThanOrEqual(creators.length + 1);
  });
});

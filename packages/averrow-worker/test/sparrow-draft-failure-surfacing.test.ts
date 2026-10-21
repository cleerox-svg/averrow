/**
 * Sparrow — caught takedown-draft failures must surface on the run, and each
 * draft must be written atomically with its evidence.
 *
 * The six draft creators catch per-candidate write failures into a DraftTally
 * (so one bad row can't fail the run — the 2026-06-30 auto-pause). That alone
 * hid a total outage: if every INSERT failed the run still finalized
 * 'success', the circuit breaker never counted it and nothing showed it.
 *
 * What we pin (migration-derived SQLite schema, D1 batch emulated atomically):
 *   1. every candidate fails, none drafted → execute() throws (agent_runs
 *      'failed' + breaker), carrying the first error;
 *   2. some fail → AgentResult.degraded is set ('partial', completed_at set);
 *   3. social / app-store / dark-web: an evidence INSERT failure rolls back
 *      the draft, so the source row stays eligible (their dedup is
 *      `id NOT IN (SELECT source_id FROM takedown_requests …)`);
 *   4. an abuse message with >100 promoted threat ids drafts every one under a
 *      DB that enforces D1's 100-bind cap.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Env } from "../src/types";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";

// Phases outside the unit under test: no network, no AI.
vi.mock("../src/lib/url-scanner", () => ({
  scanUnprocessedCaptures: vi.fn(async () => ({ captures_processed: 0, urls_scanned: 0, malicious_found: 0 })),
}));
vi.mock("../src/lib/evidence-assembler", () => ({ assembleEvidence: vi.fn(async () => undefined) }));
vi.mock("../src/lib/provider-resolver", () => ({
  resolveProvider: vi.fn(async () => { throw new Error("provider resolution disabled in test"); }),
  generateSubmissionDraft: vi.fn(() => ""),
  preferredDomainReportingProvider: vi.fn(async () => null),
}));
vi.mock("../src/lib/domain-checker", () => ({ checkDomain: vi.fn(async () => ({ registered: false, hasWeb: false })) }));

import {
  sparrowAgent,
  createTakedownsFromAbuseReports,
  createTakedownsFromImpersonations,
  createTakedownsFromAppStoreImpersonations,
  createTakedownsFromDarkWebMentions,
} from "../src/agents/sparrow";

const ORG = 2;
const BRAND = "brand_acme";

/**
 * Wrap the harness D1 so that (a) `batch` is atomic like D1's (the harness
 * runs statements one by one with no rollback), and (b) a statement whose SQL
 * contains `failSql` and whose binds satisfy `failWhen` throws on execution.
 */
function testDb(
  raw: SqliteDb,
  fail?: { failSql: string; failWhen?: (args: unknown[]) => boolean },
): D1Database {
  const real = d1FromSqlite(raw);
  const boom = (): never => { throw new Error("D1_ERROR: simulated write failure"); };
  const wrap = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === "bind") {
          return (...args: unknown[]) => {
            const bound = target.bind(...args);
            if (fail && sql.includes(fail.failSql) && (fail.failWhen?.(args) ?? true)) {
              return { ...bound, run: async () => boom(), all: async () => boom(), first: async () => boom() };
            }
            return wrap(sql, bound);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  let sp = 0;
  return {
    prepare: (sql: string) => wrap(sql, real.prepare(sql)),
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      const name = `b${++sp}`;
      raw.exec(`SAVEPOINT ${name}`);
      try {
        const out: unknown[] = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec(`RELEASE ${name}`);
        return out;
      } catch (err) {
        raw.exec(`ROLLBACK TO ${name}`);
        raw.exec(`RELEASE ${name}`);
        throw err;
      }
    },
  } as unknown as D1Database;
}

function insert(raw: SqliteDb, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  raw.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => row[c] as never));
}

function count(raw: SqliteDb, sql: string): number {
  return (raw.prepare(sql).all() as Array<{ n: number }>)[0]!.n;
}

function seedAbuse(raw: SqliteDb, msgId: string, threats: Array<[id: string, domain: string]>): void {
  for (const [id, domain] of threats) {
    insert(raw, "threats", {
      id, threat_type: "phishing", malicious_domain: domain, malicious_url: `https://${domain}/login`,
      source_feed: "abuse_mailbox", status: "active",
    });
  }
  insert(raw, "abuse_inbox_messages", {
    id: msgId, org_id: ORG, brand_id: BRAND, classification: "phishing", severity: "HIGH",
    classified_by: "ai", promoted_threat_ids: JSON.stringify(threats.map(([id]) => id)),
    received_at: "2026-10-20 10:00:00",
  });
}

async function runSparrow(db: D1Database) {
  const env = { DB: db, CACHE: fakeKv(), AI_MODE: "rules_only" } as unknown as Env;
  return sparrowAgent.execute({ env, runId: "sparrow-run", agentName: "sparrow", input: {}, triggeredBy: null } as never);
}

describe.skipIf(!hasSqlite())("Sparrow — draft failures surface on the run", () => {
  let raw: SqliteDb;

  beforeEach(() => {
    raw = openMigratedDb();
    insert(raw, "brands", { id: BRAND, name: "Acme", canonical_domain: "acme.example" });
    insert(raw, "org_brands", { org_id: ORG, brand_id: BRAND });
  });

  it("every candidate fails and none is drafted → execute() throws with the first error", async () => {
    seedAbuse(raw, "msg-1", [["thr-1", "one.example"]]);
    seedAbuse(raw, "msg-2", [["thr-2", "two.example"]]);
    const db = testDb(raw, { failSql: "INSERT INTO takedown_requests" });

    await expect(runSparrow(db)).rejects.toThrow(
      /sparrow: all 2 takedown draft candidate\(s\) failed; first: abuse_report msg-\d\/thr-\d: D1_ERROR: simulated write failure/,
    );
    expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_requests")).toBe(0);
  });

  it("some candidates fail → run completes with degraded set (partial)", async () => {
    seedAbuse(raw, "msg-ok", [["thr-ok", "ok.example"]]);
    seedAbuse(raw, "msg-bad", [["thr-bad", "bad.example"]]);
    const db = testDb(raw, {
      failSql: "INSERT INTO takedown_requests",
      failWhen: (args) => args.includes("bad.example"),
    });

    const result = await runSparrow(db);

    expect(result.output.abuse_report_takedowns).toBe(1);
    expect(result.output.takedown_draft_failures).toBe(1);
    expect(result.degraded).toBeDefined();
    expect(result.degraded!.reason).toMatch(
      /^1 takedown draft candidate\(s\) failed \(1 created\); first: abuse_report msg-bad\/thr-bad: D1_ERROR: simulated write failure$/,
    );
    expect(result.agentOutputs?.some((o) => o.severity === "high" && /failed to write/.test(o.summary))).toBe(true);
  });

  it("no failures → no degraded, no throw", async () => {
    seedAbuse(raw, "msg-ok", [["thr-ok", "ok.example"]]);
    const result = await runSparrow(testDb(raw));
    expect(result.output.abuse_report_takedowns).toBe(1);
    expect(result.output.takedown_draft_failures).toBe(0);
    expect(result.degraded).toBeUndefined();
  });

  it("nothing to draft and nothing failed → plain success", async () => {
    const result = await runSparrow(testDb(raw));
    expect(result.output.takedown_draft_failures).toBe(0);
    expect(result.degraded).toBeUndefined();
  });

  describe("draft + evidence are atomic (evidence failure rolls back the draft)", () => {
    const failEvidence = () => testDb(raw, { failSql: "INSERT INTO takedown_evidence" });

    it("social profile", async () => {
      insert(raw, "social_profiles", {
        id: "sp-1", brand_id: BRAND, platform: "twitter", handle: "acme_support",
        classification: "impersonation", status: "active", impersonation_score: 0.9,
      });
      const tally = await createTakedownsFromImpersonations({ DB: failEvidence() } as unknown as Env);
      expect(tally.created).toBe(0);
      expect(tally.failed).toBe(1);
      expect(tally.firstError).toMatch(/^social_profile sp-1: D1_ERROR/);
      expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_requests")).toBe(0);

      // Still eligible: the next (healthy) run drafts it, with its evidence.
      const retry = await createTakedownsFromImpersonations({ DB: testDb(raw) } as unknown as Env);
      expect(retry).toEqual({ created: 1, failed: 0, firstError: null });
      expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_requests WHERE source_type = 'social_profile'")).toBe(1);
      expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_evidence")).toBe(1);
    });

    it("app-store listing", async () => {
      insert(raw, "app_store_listings", {
        id: "asl-1", brand_id: BRAND, store: "ios", app_id: "123", app_name: "Acme Wallet",
        classification: "impersonation", status: "active", severity: "HIGH", impersonation_score: 0.9,
      });
      const tally = await createTakedownsFromAppStoreImpersonations({ DB: failEvidence() } as unknown as Env);
      expect(tally.created).toBe(0);
      expect(tally.failed).toBe(1);
      expect(tally.firstError).toMatch(/^app_store asl-1: D1_ERROR/);
      expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_requests")).toBe(0);

      const retry = await createTakedownsFromAppStoreImpersonations({ DB: testDb(raw) } as unknown as Env);
      expect(retry).toEqual({ created: 1, failed: 0, firstError: null });
      expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_evidence")).toBe(1);
    });

    it("dark-web mention", async () => {
      insert(raw, "dark_web_mentions", {
        id: "dwm-1", brand_id: BRAND, source: "pastebin", source_url: "https://pastebin.example/abc",
        classification: "confirmed", status: "active", severity: "HIGH", last_seen: "2026-10-20 10:00:00",
      });
      const tally = await createTakedownsFromDarkWebMentions({ DB: failEvidence() } as unknown as Env);
      expect(tally.created).toBe(0);
      expect(tally.failed).toBe(1);
      expect(tally.firstError).toMatch(/^dark_web_mention dwm-1: D1_ERROR/);
      expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_requests")).toBe(0);

      const retry = await createTakedownsFromDarkWebMentions({ DB: testDb(raw) } as unknown as Env);
      expect(retry).toEqual({ created: 1, failed: 0, firstError: null });
      expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_evidence")).toBe(1);
    });
  });

  it("an abuse message with >100 promoted threat ids drafts all of them under D1's 100-bind cap", async () => {
    const N = 150;
    const threats: Array<[string, string]> = [];
    for (let i = 0; i < N; i++) threats.push([`thr-${i}`, `phish-${i}.example`]);
    seedAbuse(raw, "msg-big", threats);
    // A duplicate id in the list must not double-draft (IN ignored it before).
    raw.prepare("UPDATE abuse_inbox_messages SET promoted_threat_ids = ? WHERE id = 'msg-big'")
      .run(JSON.stringify([...threats.map(([id]) => id), "thr-0"]));

    const seen = { max: 0 };
    const base = testDb(raw);
    const db = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(t, p, r) {
                if (p === "bind") {
                  return (...args: unknown[]) => {
                    seen.max = Math.max(seen.max, args.length);
                    if (args.length > 100) throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
                    return t.bind(...args);
                  };
                }
                return Reflect.get(t, p, r) as unknown;
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const tally = await createTakedownsFromAbuseReports({ DB: db } as unknown as Env);
    expect(tally).toEqual({ created: N, failed: 0, firstError: null });
    expect(seen.max).toBeLessThanOrEqual(100);
    expect(count(raw, "SELECT COUNT(DISTINCT target_value) AS n FROM takedown_requests")).toBe(N);
    expect(count(raw, "SELECT COUNT(*) AS n FROM takedown_requests")).toBe(N);
    expect(count(raw, "SELECT COUNT(*) AS n FROM abuse_inbox_messages WHERE takedown_drafted_at IS NOT NULL")).toBe(1);
  });
});

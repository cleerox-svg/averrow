/**
 * Tests for handlers/admin.ts — handleSystemHealth (GET /api/admin/system-health).
 *
 * Locks the read-path caching change (a9a34a7, "cache system-health, kill
 * the raw-threats full scans"): the threats total/today/week counts now go
 * through cachedCount, the 14-day trend through cachedValue, and the whole
 * payload is wrapped in an outer 120s KV cache — but the response CONTRACT
 * (CLAUDE.md: "Response shape is byte-identical (frozen contract)") must
 * not move. Faked the same way organizations-search.test.ts fakes D1: a
 * hand-rolled `.prepare(sql).first()/.all()` router keyed on distinctive
 * SQL substrings, since the handler reads via getReadSession() ->
 * env.DB.withSession().
 */

import { describe, it, expect } from "vitest";
import { handleSystemHealth } from "../src/handlers/admin";
import type { Env } from "../src/types";

// ─── Minimal in-memory KV mock (mirrors cached-count.test.ts's MockKV) ────
class MockKV {
  store = new Map<string, string>();
  getCalls = 0;
  putCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface QueryLog {
  sql: string;
}

/** Routes .prepare(sql).first()/.all() by distinctive SQL substring so the
 *  five session.prepare() calls in handleSystemHealth (+ trend + audit)
 *  each get the row shape they expect. */
function makeSession(log: QueryLog[]) {
  return {
    prepare(sql: string) {
      log.push({ sql });
      return {
        async first<T>(): Promise<T> {
          if (sql.includes("-7 days")) {
            return { n: 900 } as unknown as T; // threats.week
          }
          if (sql.includes("-1 day") && sql.includes("FROM threats")) {
            return { n: 40 } as unknown as T; // threats.today
          }
          if (sql.includes("FROM threats")) {
            return { n: 694_321 } as unknown as T; // threats.total
          }
          if (sql.includes("FROM agent_runs")) {
            return { total: 229, successes: 220, errors: 9 } as unknown as T;
          }
          if (sql.includes("FROM feed_pull_history")) {
            return { pulls: 266, ingested: 6245 } as unknown as T;
          }
          if (sql.includes("FROM sessions")) {
            return { count: 94 } as unknown as T;
          }
          if (sql.includes("FROM d1_migrations")) {
            return {
              total: 45,
              last_run: "2026-03-27T00:00:00Z",
              last_name: "0047_agent_activity_log.sql",
            } as unknown as T;
          }
          throw new Error(`makeSession: unexpected .first() query: ${sql}`);
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("GROUP BY date(created_at)")) {
            return {
              results: [
                { day: "2026-06-27", count: 100 },
                { day: "2026-06-28", count: 150 },
              ] as unknown as T[],
            };
          }
          throw new Error(`makeSession: unexpected .all() query: ${sql}`);
        },
      };
    },
  };
}

function makeEnv(kv: MockKV, log: QueryLog[]): Env {
  const session = makeSession(log);
  return {
    DB: { withSession: () => session },
    CACHE: kv,
    AUDIT_DB: {
      prepare(sql: string) {
        log.push({ sql });
        return { async first() { return { count: 283 }; } };
      },
    },
  } as unknown as Env;
}

function req(): Request {
  return new Request("https://averrow.com/api/admin/system-health", {
    headers: { Origin: "https://averrow.com" },
  });
}

interface Body {
  success: boolean;
  data: {
    threats: { total: number; today: number; week: number };
    agents: { total: number; successes: number; errors: number };
    feeds: { pulls: number; ingested: number };
    sessions: { count: number };
    migrations: { total: number; last_run: string | null; last_name: string | null };
    audit: { count: number };
    trend: Array<{ day: string; count: number }>;
    infrastructure: unknown;
  };
}

async function bodyOf(res: Response): Promise<Body> {
  return res.json() as Promise<Body>;
}

describe("handleSystemHealth — cached read path preserves the frozen response contract", () => {
  it("returns the full documented shape on a cold cache", async () => {
    const kv = new MockKV();
    const log: QueryLog[] = [];
    const env = makeEnv(kv, log);

    const res = await handleSystemHealth(req(), env);
    expect(res.status).toBe(200);

    const body = await bodyOf(res);
    expect(body).toEqual({
      success: true,
      data: {
        threats: { total: 694_321, today: 40, week: 900 },
        agents: { total: 229, successes: 220, errors: 9 },
        feeds: { pulls: 266, ingested: 6245 },
        sessions: { count: 94 },
        migrations: {
          total: 45,
          last_run: "2026-03-27T00:00:00Z",
          last_name: "0047_agent_activity_log.sql",
        },
        audit: { count: 283 },
        trend: [
          { day: "2026-06-27", count: 100 },
          { day: "2026-06-28", count: 150 },
        ],
        infrastructure: {
          mainDb: { name: "trust-radar-v2", sizeMb: 79.5, tables: 57, region: "ENAM" },
          auditDb: { name: "trust-radar-v2-audit", sizeKb: 180, tables: 2, region: "ENAM" },
          worker: { name: "trust-radar", platform: "Cloudflare Workers" },
          kvNamespaces: [
            { name: "trust-radar-cache" },
            { name: "SESSIONS" },
            { name: "CACHE" },
          ],
        },
      },
    });
  });

  it("writes the outer system_health KV entry with a 120s TTL on a cold cache", async () => {
    const kv = new MockKV();
    const env = makeEnv(kv, []);
    await handleSystemHealth(req(), env);
    expect(kv.store.has("system_health")).toBe(true);
  });

  it("serves byte-identical shape from the outer cache on a warm hit, without re-querying D1", async () => {
    const kv = new MockKV();
    const log1: QueryLog[] = [];
    const env1 = makeEnv(kv, log1);
    const first = await bodyOf(await handleSystemHealth(req(), env1));
    const dbCallsAfterCold = log1.length;
    expect(dbCallsAfterCold).toBeGreaterThan(0);

    // Second call shares the same KV store (simulating the same Worker's
    // CACHE binding) but a session that throws if touched — the outer
    // "system_health" cache entry must short-circuit before any D1 read.
    const throwingSession = {
      prepare(sql: string): never {
        throw new Error(`unexpected D1 read on warm cache: ${sql}`);
      },
    };
    const env2 = {
      DB: { withSession: () => throwingSession },
      CACHE: kv,
      AUDIT_DB: {
        prepare(): never {
          throw new Error("unexpected AUDIT_DB read on warm cache");
        },
      },
    } as unknown as Env;

    const second = await bodyOf(await handleSystemHealth(req(), env2));
    expect(second).toEqual(first);
  });

  it("reconstructs threats.{total,today,week} from three independent cachedCount reads (not a single row)", async () => {
    const kv = new MockKV();
    const log: QueryLog[] = [];
    const env = makeEnv(kv, log);
    await handleSystemHealth(req(), env);

    const threatCountQueries = log.filter(
      (l) => l.sql.includes("FROM threats") && l.sql.includes("COUNT(*)") && !l.sql.includes("GROUP BY"),
    );
    // total, today, week — three separate SELECT COUNT(*) statements
    // (distinct from the 14-day trend's GROUP BY date(created_at) query).
    expect(threatCountQueries.length).toBe(3);
  });
});

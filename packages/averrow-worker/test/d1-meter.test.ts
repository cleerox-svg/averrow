/**
 * Per-job D1 attribution (lib/d1-meter.ts) — the metering proxy, its
 * wiring into executeAgent / handleScheduled / Workflows, and the
 * diagnostics `d1_hourly` / `d1_attribution_hourly` fetchers.
 *
 * The D1 double below runs on node:sqlite (the same lane as
 * sqlite-d1-harness.ts) but, unlike that harness, mirrors workerd's
 * D1PreparedStatement closely: `meta.rows_read` / `rows_written` on
 * all/run/batch, no meta on first(), workerd's first(col) column-not-found
 * throw, and a batch() that REJECTS statements it did not create (the real
 * batch reads the statements' internal fields, so a metered proxy must be
 * unwrapped before it reaches it).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";
import { meterD1, meterEnv, trackWaitUntil, runWithWorkflowMeter, withD1Meter } from "../src/lib/d1-meter";
import { newTally, type D1Tally } from "../src/lib/analytics";
import { executeAgent, type AgentModule } from "../src/lib/agentRunner";
import { fetchD1HourlyMetrics, clampHourlyWindow, toHourLabel } from "../src/lib/d1-budget";
import { fetchD1HourlyAttribution } from "../src/handlers/diagnostics";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

/** workerd-shaped D1 over node:sqlite. `log` records every executed SQL. */
function realishD1(raw: SqliteDb, log: string[] = []): D1Database {
  const created = new WeakSet<object>();
  const readRows = (sql: string, binds: unknown[]): Row[] => {
    log.push(sql);
    return raw.prepare(sql).all(...binds) as Row[];
  };
  const meta = (rowsRead: number, rowsWritten: number) => ({
    duration: 0, size_after: 0, rows_read: rowsRead, rows_written: rowsWritten,
    last_row_id: 0, changed_db: rowsWritten > 0, changes: rowsWritten,
  });
  const exec = (sql: string, binds: unknown[]) => {
    if (/^\s*select/i.test(sql)) {
      const rows = readRows(sql, binds);
      return { success: true, results: rows, meta: meta(rows.length, 0) };
    }
    log.push(sql);
    const r = raw.prepare(sql).run(...binds);
    const changes = Number(r.changes ?? 0);
    return { success: true, results: [], meta: meta(0, changes) };
  };
  const make = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const stmt = {
      bind: (...args: unknown[]) => make(sql, args),
      all: async () => exec(sql, binds),
      run: async () => exec(sql, binds),
      // workerd first(): same /query, meta discarded.
      first: async (col?: string) => {
        const rows = exec(sql, binds).results as Row[];
        if (rows.length === 0) return null;
        if (col !== undefined) {
          if (rows[0]![col] === undefined) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${col})`);
          return rows[0]![col];
        }
        return rows[0];
      },
      raw: async () => (exec(sql, binds).results as Row[]).map((r) => Object.values(r)),
    };
    created.add(stmt);
    return stmt as unknown as D1PreparedStatement;
  };
  const batch = async (stmts: D1PreparedStatement[]) => {
    for (const s of stmts) {
      if (!created.has(s)) throw new TypeError("batch(): not a D1PreparedStatement");
    }
    const out = [];
    for (const s of stmts) out.push(await s.all());
    return out;
  };
  return {
    prepare: (sql: string) => make(sql, []),
    batch,
    exec: async (sql: string) => {
      raw.exec(sql);
      return { count: sql.split(";").filter((x) => x.trim()).length, duration: 0 };
    },
    withSession: () => ({
      prepare: (sql: string) => make(sql, []),
      batch,
      getBookmark: () => "bookmark-1",
    }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function seeded(): SqliteDb {
  const raw = openDerivedDb([]);
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT)");
  raw.exec("INSERT INTO t (id, name, note) VALUES (1, 'a', NULL), (2, 'b', 'x'), (3, 'c', 'y')");
  return raw;
}

function fakeAe(): AnalyticsEngineDataset & { points: Array<{ blobs?: unknown[]; doubles?: number[] }> } {
  const points: Array<{ blobs?: unknown[]; doubles?: number[] }> = [];
  return {
    points,
    writeDataPoint: (p?: { blobs?: unknown[]; doubles?: number[] }) => { points.push(p ?? {}); },
  } as unknown as AnalyticsEngineDataset & { points: typeof points };
}

describe.skipIf(!hasSqlite())("meterD1 proxy", () => {
  it("tallies all() / run() / bind() reads, writes and queries", async () => {
    const tally = newTally();
    const db = meterD1(realishD1(seeded()), tally);
    const all = await db.prepare("SELECT * FROM t WHERE id >= ?").bind(2).all();
    expect(all.results).toHaveLength(2);
    await db.prepare("UPDATE t SET note = 'z' WHERE id <= ?").bind(2).run();
    expect(tally).toEqual<D1Tally>({ rowsRead: 2, rowsWritten: 2, queries: 2 });
  });

  it("first() reads through all() and matches the unwrapped binding exactly", async () => {
    const raw = seeded();
    const plain = realishD1(raw);
    const tally = newTally();
    const metered = meterD1(realishD1(raw), tally);
    const cases: Array<[string, unknown[], string | undefined]> = [
      ["SELECT * FROM t ORDER BY id", [], undefined],
      ["SELECT * FROM t WHERE id = ?", [2], "name"],
      ["SELECT * FROM t WHERE id = ?", [1], "note"], // SQL NULL value → null
      ["SELECT * FROM t WHERE id = ?", [99], undefined], // no rows → null
      ["SELECT * FROM t WHERE id = ?", [99], "name"], // no rows + col → null
      ["SELECT COUNT(*) AS n FROM t", [], "n"],
    ];
    for (const [sql, binds, col] of cases) {
      const a = col === undefined
        ? await plain.prepare(sql).bind(...binds).first()
        : await plain.prepare(sql).bind(...binds).first(col);
      const b = col === undefined
        ? await metered.prepare(sql).bind(...binds).first()
        : await metered.prepare(sql).bind(...binds).first(col);
      expect(b).toEqual(a);
    }
    // ORDER BY scan = 3 rows, three single-row hits, two misses, COUNT = 1 row.
    expect(tally).toEqual<D1Tally>({ rowsRead: 3 + 1 + 1 + 0 + 0 + 1, rowsWritten: 0, queries: 6 });
  });

  it("first(col) on a missing column throws the workerd error, like the binding", async () => {
    const raw = seeded();
    const sql = "SELECT id FROM t WHERE id = 1";
    const plainErr = await realishD1(raw).prepare(sql).first("nope").catch((e: unknown) => e);
    const meteredErr = await meterD1(realishD1(raw), newTally()).prepare(sql).first("nope").catch((e: unknown) => e);
    expect(meteredErr).toBeInstanceOf(Error);
    expect((meteredErr as Error).message).toBe((plainErr as Error).message);
  });

  it("batch() unwraps metered statements (the real batch rejects proxies) and tallies each result", async () => {
    const tally = newTally();
    const db = meterD1(realishD1(seeded()), tally);
    const res = await db.batch([
      db.prepare("SELECT * FROM t"),
      db.prepare("SELECT * FROM t WHERE id = ?").bind(1),
    ]);
    expect(res).toHaveLength(2);
    expect(tally).toEqual<D1Tally>({ rowsRead: 4, rowsWritten: 0, queries: 2 });
  });

  it("layers are exclusive: re-metering a metered binding hides the work from the outer tally", async () => {
    const outer = newTally();
    const inner = newTally();
    const outerDb = meterD1(realishD1(seeded()), outer);
    await outerDb.prepare("SELECT * FROM t WHERE id = 1").all(); // outer's own read
    const db = meterD1(outerDb, inner);
    await db.batch([db.prepare("SELECT * FROM t")]); // batch still unwraps to the real statement
    await db.prepare("SELECT * FROM t WHERE id = 1").first();
    expect(inner).toEqual<D1Tally>({ rowsRead: 4, rowsWritten: 0, queries: 2 });
    expect(outer).toEqual<D1Tally>({ rowsRead: 1, rowsWritten: 0, queries: 1 });
  });

  it("meterEnv over an already-metered env is exclusive too", async () => {
    const outer = newTally();
    const inner = newTally();
    const outerEnv = meterEnv({ DB: realishD1(seeded()) }, outer);
    const innerEnv = meterEnv(outerEnv, inner);
    await innerEnv.DB.prepare("SELECT * FROM t").all();
    expect(inner.rowsRead).toBe(3);
    expect(outer.queries).toBe(0);
  });

  it("withSession() statements and session batch are metered; getBookmark forwards", async () => {
    const tally = newTally();
    const db = meterD1(realishD1(seeded()), tally);
    const session = db.withSession("first-unconstrained");
    await session.prepare("SELECT * FROM t").all();
    await session.batch([session.prepare("SELECT * FROM t WHERE id = ?").bind(3)]);
    expect(session.getBookmark()).toBe("bookmark-1");
    expect(tally).toEqual<D1Tally>({ rowsRead: 4, rowsWritten: 0, queries: 2 });
  });

  it("exec() counts statements; raw() forwards unchanged and counts the query", async () => {
    const tally = newTally();
    const plain = realishD1(seeded());
    const db = meterD1(plain, tally);
    const r = await db.exec("CREATE TABLE u (x INTEGER); CREATE TABLE v (y INTEGER)");
    expect(r.count).toBe(2);
    const rows = await db.prepare("SELECT id FROM t ORDER BY id").raw();
    expect(rows).toEqual(await plain.prepare("SELECT id FROM t ORDER BY id").raw());
    expect(tally.queries).toBe(3);
  });

  it("errors propagate unchanged (same error object) from all/run/first/batch", async () => {
    const boom = new Error("D1_ERROR: no such table: missing");
    const failing = {
      prepare: () => {
        const s = {
          bind: () => s,
          all: async () => { throw boom; },
          run: async () => { throw boom; },
          first: async () => { throw boom; },
          raw: async () => { throw boom; },
        };
        return s;
      },
      batch: async () => { throw boom; },
    } as unknown as D1Database;
    const db = meterD1(failing, newTally());
    await expect(db.prepare("x").all()).rejects.toBe(boom);
    await expect(db.prepare("x").run()).rejects.toBe(boom);
    await expect(db.prepare("x").first()).rejects.toBe(boom);
    await expect(db.prepare("x").raw()).rejects.toBe(boom);
    await expect(db.batch([db.prepare("x")])).rejects.toBe(boom);
  });

  it("meterEnv wraps only bound D1 databases and leaves other bindings alone", () => {
    const db = realishD1(seeded());
    const kv = { get: () => null };
    const env = { DB: db, AUDIT_DB: db, CACHE: kv, SOME_VAR: "v" };
    const out = meterEnv(env, newTally());
    expect(out).not.toBe(env);
    expect(out.DB).not.toBe(db);
    expect(out.AUDIT_DB).not.toBe(db);
    expect(out.CACHE).toBe(kv);
    expect(out.SOME_VAR).toBe("v");
    expect(env.DB).toBe(db); // original untouched
  });
});

describe.skipIf(!hasSqlite())("executeAgent D1 attribution", () => {
  function agentDb(): SqliteDb {
    const raw = openDerivedDb(["agent_configs", "agent_approvals", "agent_runs", "agent_outputs", "agent_activity_log"]);
    raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT)");
    raw.exec("INSERT INTO t (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
    raw.exec("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('sentinel', 'approved', '2026-01-01 00:00:00')");
    return raw;
  }
  const module = (seen: { env?: Env }): AgentModule => ({
    name: "sentinel",
    execute: async (ctx) => {
      seen.env = ctx.env;
      const r = await ctx.env.DB.prepare("SELECT * FROM t").all();
      return { itemsProcessed: r.results.length, itemsCreated: 0, itemsUpdated: 0, output: {} };
    },
  }) as unknown as AgentModule;

  it("records an `agent:<id>` data point covering the agent's own reads", async () => {
    const ae = fakeAe();
    const raw = agentDb();
    const env = { DB: realishD1(raw), AE: ae } as unknown as Env;
    const seen: { env?: Env } = {};
    const res = await executeAgent(env, module(seen), {}, "test", "manual");
    expect(res.status).toBe("success");
    expect(seen.env).not.toBe(env); // agent ran on the metered copy
    expect(ae.points).toHaveLength(1);
    const p = ae.points[0]!;
    expect(p.blobs).toEqual(["agent:sentinel"]);
    const [rowsRead, rowsWritten, queries] = p.doubles!;
    expect(rowsRead).toBeGreaterThanOrEqual(3); // the agent's SELECT * FROM t
    expect(rowsWritten).toBeGreaterThan(0);     // agent_runs insert + finalize
    expect(queries).toBeGreaterThanOrEqual(5);
  });

  it("records on the failure path too", async () => {
    const ae = fakeAe();
    const env = { DB: realishD1(agentDb()), AE: ae } as unknown as Env;
    const failing = { name: "sentinel", execute: async () => { throw new Error("nope"); } } as unknown as AgentModule;
    const res = await executeAgent(env, failing);
    expect(res.status).toBe("failed");
    expect(ae.points.map((p) => p.blobs?.[0])).toEqual(["agent:sentinel"]);
  });

  it("is a no-op (agent gets the original env) when AE is not bound", async () => {
    const env = { DB: realishD1(agentDb()) } as unknown as Env;
    const seen: { env?: Env } = {};
    await executeAgent(env, module(seen));
    expect(seen.env).toBe(env);
  });

  /** Child agent: reads all 3 rows of t. Needs its own approval row. */
  const child = { name: "analyst", execute: async (ctx: { env: Env }) => {
    await ctx.env.DB.prepare("SELECT * FROM t").all();
    return { itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, output: {} };
  } } as unknown as AgentModule;
  const nestedDb = (): SqliteDb => {
    const raw = agentDb();
    raw.exec("INSERT INTO agent_approvals (agent_id, state, requested_at) VALUES ('analyst', 'approved', '2026-01-01 00:00:00'), ('flight_control', 'approved', '2026-01-01 00:00:00')");
    return raw;
  };
  /** Parent (FC-style): one own 1-row read, optionally dispatching `child`. */
  const parent = (mode: "none" | "await" | "waitUntil"): AgentModule => ({
    name: "flight_control",
    execute: async (ctx: { env: Env; input: Record<string, unknown> }) => {
      await ctx.env.DB.prepare("SELECT * FROM t WHERE id = 1").all();
      if (mode === "await") await executeAgent(ctx.env, child, {}, "test", "scheduled");
      if (mode === "waitUntil") {
        (ctx.input._executionCtx as ExecutionContext).waitUntil(executeAgent(ctx.env, child, {}, "test", "scheduled"));
      }
      return { itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, output: {} };
    },
  }) as unknown as AgentModule;
  const pointFor = (ae: ReturnType<typeof fakeAe>, label: string) =>
    ae.points.filter((p) => p.blobs?.[0] === label).map((p) => p.doubles);
  const ctxCollecting = (): { ctx: ExecutionContext; drain: () => Promise<void> } => {
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const drain = async () => { for (let i = 0; i < waited.length; i++) await waited[i]; };
    return { ctx, drain };
  };

  it("nested executeAgent (awaited, FC-style): the parent row excludes the child's reads", async () => {
    const baseAe = fakeAe();
    await executeAgent({ DB: realishD1(nestedDb()), AE: baseAe } as unknown as Env, parent("none"));
    const ae = fakeAe();
    await executeAgent({ DB: realishD1(nestedDb()), AE: ae } as unknown as Env, parent("await"));
    expect(pointFor(ae, "agent:flight_control")).toEqual(pointFor(baseAe, "agent:flight_control"));
    const childPoint = pointFor(ae, "agent:analyst");
    expect(childPoint).toHaveLength(1);
    expect(childPoint[0]![0]).toBeGreaterThanOrEqual(3);
  });

  it("nested executeAgent via waitUntil: the child gets its own row, the parent's :bg tail stays empty", async () => {
    const base = ctxCollecting();
    const baseAe = fakeAe();
    await executeAgent({ DB: realishD1(nestedDb()), AE: baseAe } as unknown as Env, parent("none"), { _executionCtx: base.ctx });
    await base.drain();
    const c = ctxCollecting();
    const ae = fakeAe();
    await executeAgent({ DB: realishD1(nestedDb()), AE: ae } as unknown as Env, parent("waitUntil"), { _executionCtx: c.ctx });
    await c.drain();
    expect(pointFor(ae, "agent:flight_control")).toEqual(pointFor(baseAe, "agent:flight_control"));
    expect(pointFor(ae, "agent:flight_control:bg")).toEqual([]);
    expect(pointFor(ae, "agent:analyst")).toHaveLength(1);
  });

  it("an agent's own non-agent waitUntil reads are recorded as agent:<id>:bg", async () => {
    const c = ctxCollecting();
    const ae = fakeAe();
    const mod = { name: "sentinel", execute: async (ctx: { env: Env; input: Record<string, unknown> }) => {
      const env = ctx.env;
      (ctx.input._executionCtx as ExecutionContext).waitUntil((async () => {
        // After the runner's finalize writes — the split is by time.
        await new Promise((r) => setTimeout(r, 5));
        await env.DB.prepare("SELECT * FROM t").all();
      })());
      return { itemsProcessed: 0, itemsCreated: 0, itemsUpdated: 0, output: {} };
    } } as unknown as AgentModule;
    await executeAgent({ DB: realishD1(agentDb()), AE: ae } as unknown as Env, mod, { _executionCtx: c.ctx });
    await c.drain();
    expect(pointFor(ae, "agent:sentinel:bg")).toEqual([[3, 0, 1]]);
  });

  it("workflow → executeAgent: the workflow's step point excludes the agent's reads", async () => {
    const ae = fakeAe();
    const base = { DB: realishD1(nestedDb()), AE: ae } as unknown as Env;
    let current: Env = base;
    const step = { do: async (_n: string, cb: () => Promise<unknown>) => cb() };
    await runWithWorkflowMeter("workflow:test", base, step, (e) => { current = e; }, async (s) => {
      await s.do("one", async () => {
        await current.DB.prepare("SELECT * FROM t WHERE id = 1").all();
        await executeAgent(current, child, {}, "workflow", "scheduled");
        return null;
      });
      return null;
    });
    expect(pointFor(ae, "workflow:test")).toEqual([[1, 0, 1]]);
    expect(pointFor(ae, "agent:analyst")).toHaveLength(1);
  });

  it("cron layer → agents (awaited + waitUntil): cron / cron:bg rows hold only non-agent work", async () => {
    const c = ctxCollecting();
    const ae = fakeAe();
    const env = { DB: realishD1(nestedDb()), AE: ae } as unknown as Env;
    await withD1Meter(env, "cron:test", async (menv, tctx) => {
      await menv.DB.prepare("SELECT * FROM t WHERE id = 1").all();       // inline, non-agent
      await executeAgent(menv, child, {}, "cron", "scheduled");          // awaited agent
      tctx!.waitUntil(executeAgent(menv, child, {}, "cron", "scheduled")); // waitUntil agent
      tctx!.waitUntil((async () => {                                      // waitUntil, non-agent
        await new Promise((r) => setTimeout(r, 5));
        await menv.DB.prepare("SELECT * FROM t WHERE id >= 2").all();
      })());
    }, c.ctx);
    await c.drain();
    expect(pointFor(ae, "cron:test")).toEqual([[1, 0, 1]]);
    expect(pointFor(ae, "cron:test:bg")).toEqual([[2, 0, 1]]);
    expect(pointFor(ae, "agent:analyst")).toHaveLength(2);
  });

  it("AE write failures stay non-fatal", async () => {
    const env = {
      DB: realishD1(agentDb()),
      AE: { writeDataPoint: () => { throw new Error("AE down"); } },
    } as unknown as Env;
    const res = await executeAgent(env, module({}));
    expect(res.status).toBe("success");
  });
});

describe.skipIf(!hasSqlite())("withD1Meter / trackWaitUntil / workflow meter", () => {
  it("withD1Meter records once even when fn throws, and rethrows the same error", async () => {
    const ae = fakeAe();
    const env = { DB: realishD1(seeded()), AE: ae } as unknown as Env;
    const err = new Error("x");
    await expect(withD1Meter(env, "cron:test", async (e) => {
      await e.DB.prepare("SELECT * FROM t").all();
      throw err;
    })).rejects.toBe(err);
    expect(ae.points).toEqual([{ blobs: ["cron:test"], doubles: [3, 0, 1], indexes: ["cron:test"] }]);
  });

  it("trackWaitUntil forwards to the real ctx and settles nested waitUntil work", async () => {
    const real: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { real.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const { ctx: tracked, settled } = trackWaitUntil(ctx);
    const order: string[] = [];
    tracked.waitUntil((async () => {
      await Promise.resolve();
      tracked.waitUntil((async () => { await Promise.resolve(); order.push("nested"); })());
      order.push("outer");
    })());
    await settled();
    expect(order).toEqual(["outer", "nested"]);
    expect(real).toHaveLength(2);
  });

  it("runWithWorkflowMeter swaps env, flushes per step, restores env", async () => {
    const ae = fakeAe();
    const base = { DB: realishD1(seeded()), AE: ae };
    let current: typeof base = base;
    const step = {
      do: async (_name: string, a: unknown, b?: unknown) => {
        const cb = (typeof a === "function" ? a : b) as () => Promise<unknown>;
        return cb();
      },
    };
    const result = await runWithWorkflowMeter("workflow:test", base, step, (e) => { current = e; }, async (s) => {
      expect(current).not.toBe(base);
      await s.do("one", async () => (await current.DB.prepare("SELECT * FROM t").all()).results.length);
      await s.do("two", { retries: { limit: 1 } }, async () => current.DB.prepare("SELECT * FROM t WHERE id = 1").first());
      await current.DB.prepare("SELECT * FROM t WHERE id >= 2").all(); // outside a step
      return "done";
    });
    expect(result).toBe("done");
    expect(current).toBe(base);
    expect(ae.points.map((p) => [p.blobs?.[0], p.doubles])).toEqual([
      ["workflow:test", [3, 0, 1]],
      ["workflow:test", [1, 0, 1]],
      ["workflow:test", [2, 0, 1]],
    ]);
  });
});

describe("hourly diagnostics fetchers", () => {
  const env = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct" } as unknown as Env;
  afterEach(() => { vi.unstubAllGlobals(); });

  it("toHourLabel normalises AE and GraphQL hour formats to one label", () => {
    expect(toHourLabel("2026-11-02 06:00:00")).toBe("2026-11-02T06:00:00Z");
    expect(toHourLabel("2026-11-02T06:00:00Z")).toBe("2026-11-02T06:00:00Z");
    expect(toHourLabel("2026-11-02T06:00:00.000Z")).toBe("2026-11-02T06:00:00Z");
    expect(toHourLabel("garbage")).toBe("garbage");
  });

  it("clampHourlyWindow caps at 48 and floors at 1", () => {
    expect(clampHourlyWindow(168)).toBe(48);
    expect(clampHourlyWindow(0)).toBe(1);
    expect(clampHourlyWindow(Number.NaN)).toBe(6);
    expect(clampHourlyWindow(12)).toBe(12);
  });

  it("fetchD1HourlyMetrics sums databases per hour, oldest first", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      expect(body.query).toContain("dimensions { datetimeHour databaseId }");
      expect(body.query).toContain('datetimeHour_geq: "2026-11-02T00:00:00.000Z"');
      return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [
          { sum: { rowsRead: 100, rowsWritten: 5 }, dimensions: { datetimeHour: "2026-11-02T06:00:00Z", databaseId: "main" } },
          { sum: { rowsRead: 900, rowsWritten: 1 }, dimensions: { datetimeHour: "2026-11-02T06:00:00Z", databaseId: "dnsq" } },
          { sum: { rowsRead: 7, rowsWritten: 0 }, dimensions: { datetimeHour: "2026-11-02T00:00:00Z", databaseId: "main" } },
        ] }] } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchD1HourlyMetrics(env, 7, new Date("2026-11-02T06:30:00Z"));
    expect(r.error).toBeUndefined();
    expect(r.window_hours).toBe(7);
    expect(r.hours.map((h) => [h.hour, h.rows_read, h.rows_written])).toEqual([
      ["2026-11-02T00:00:00Z", 7, 0],
      ["2026-11-02T06:00:00Z", 1000, 6],
    ]);
    expect(r.hours[1]!.per_database[0]).toEqual({ database_id: "dnsq", rows_read: 900, rows_written: 1 });
  });

  it("fetchD1HourlyMetrics surfaces GraphQL errors and missing setup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "bad field" }] }))));
    expect((await fetchD1HourlyMetrics(env, 6)).error).toBe("bad field");
    const none = await fetchD1HourlyMetrics({} as Env, 6);
    expect(none.setup_required).toBe(true);
    expect(none.hours).toEqual([]);
  });

  it("fetchD1HourlyAttribution groups AE rows by hour, coerces numbers, keeps the top N", async () => {
    const data = [
      { hour: "2026-11-02 06:00:00", endpoint: "cron:7 * * * *", rows_read: "5000", rows_written: "10", queries: "40", points: "1" },
      { hour: "2026-11-02 06:00:00", endpoint: "agent:analyst", rows_read: 6000, rows_written: 0, queries: 30, points: 1 },
      { hour: "2026-11-02 05:00:00", endpoint: "workflow:nexus_run", rows_read: 10, rows_written: 1, queries: 2, points: 3 },
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      // Same whole-hour window as d1_hourly: 12 buckets ending 06:xx.
      expect(body).toContain("timestamp >= toDateTime('2026-11-01 19:00:00')");
      expect(body).toContain("ORDER BY hour DESC");
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await fetchD1HourlyAttribution(env, 12, new Date("2026-11-02T06:30:00Z"));
    // Same label format as d1_hourly, oldest first.
    expect(r.hours.map((h) => h.hour)).toEqual(["2026-11-02T05:00:00Z", "2026-11-02T06:00:00Z"]);
    expect(r.hours[1]!.endpoints.map((e) => [e.endpoint, e.rows_read])).toEqual([
      ["agent:analyst", 6000],
      ["cron:7 * * * *", 5000],
    ]);
  });
});

describe("handleScheduled D1 attribution", () => {
  it("records a `cron:<expression>` point for the invocation and drains the tail via waitUntil", async () => {
    const { handleScheduled } = await import("../src/cron/orchestrator");
    const ae = fakeAe();
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const env = { DB: { prepare: () => { throw new Error("no D1 expected"); } }, AE: ae } as unknown as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});
    // An unmatched expression falls through every exact-match branch and the
    // hourly-mesh guard without touching D1.
    await handleScheduled({ cron: "1 2 3 4 5", scheduledTime: Date.now() } as unknown as ScheduledEvent, env, ctx);
    await Promise.all(waited);
    expect(ae.points).toEqual([{ blobs: ["cron:1 2 3 4 5"], doubles: [0, 0, 0], indexes: ["cron:1 2 3 4 5"] }]);
    vi.restoreAllMocks();
  });
});

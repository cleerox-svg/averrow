/**
 * Per-store D1 metering (lib/d1-meter.ts + lib/analytics.ts point shape v2):
 * one AE point per (endpoint, store), overload / error counting that
 * rethrows the same error, record-weighted readers in diagnostics.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { meterD1, meterEnv, storeBreakdownOf, withD1Meter, runWithWorkflowMeter } from "../src/lib/d1-meter";
import { d1AttributionPoints, newTally, writeD1Attribution } from "../src/lib/analytics";
import { fetchD1EndpointAttribution, fetchD1HourlyAttribution } from "../src/handlers/diagnostics";
import type { Env } from "../src/types";

interface Point { blobs?: unknown[]; doubles?: number[]; indexes?: unknown[] }

function fakeAe(): AnalyticsEngineDataset & { points: Point[] } {
  const points: Point[] = [];
  return { points, writeDataPoint: (p?: Point) => { points.push(p ?? {}); } } as unknown as AnalyticsEngineDataset & { points: Point[] };
}

/** Minimal D1 double: every read returns `rows` rows with matching meta. */
function fakeD1(rowsRead: number, rowsWritten = 0, fail?: unknown): D1Database {
  const result = () => ({ success: true, results: Array.from({ length: rowsRead }, (_, i) => ({ id: i })), meta: { rows_read: rowsRead, rows_written: rowsWritten } });
  const stmt = {
    bind: () => stmt,
    all: async () => { if (fail) throw fail; return result(); },
    run: async () => { if (fail) throw fail; return result(); },
    first: async () => { if (fail) throw fail; return null; },
    raw: async () => { if (fail) throw fail; return []; },
  };
  return {
    prepare: () => stmt,
    batch: async (s: unknown[]) => { if (fail) throw fail; return s.map(() => result()); },
    withSession: () => ({ prepare: () => stmt, batch: async (s: unknown[]) => s.map(() => result()) }),
  } as unknown as D1Database;
}

describe("per-store tally", () => {
  it("meterEnv tags each binding with its registry store; the total is the sum", async () => {
    const tally = newTally();
    const env = meterEnv({ DB: fakeD1(3, 1), AUDIT_DB: fakeD1(0, 2), DNS_QUEUE_DB: fakeD1(5) }, tally);
    await env.DB.prepare("x").all();
    await env.DB.withSession("first-unconstrained").prepare("y").all(); // session inherits the store
    await env.AUDIT_DB.prepare("z").run();
    await env.DNS_QUEUE_DB.batch([env.DNS_QUEUE_DB.prepare("a"), env.DNS_QUEUE_DB.prepare("b")]);
    expect(tally).toEqual({ rowsRead: 3 + 3 + 0 + 10, rowsWritten: 1 + 1 + 2, queries: 5 });
    const b = storeBreakdownOf(tally);
    expect(b.core).toEqual({ rowsRead: 6, rowsWritten: 2, queries: 2, overloads: 0, errors: 0 });
    expect(b.audit).toEqual({ rowsRead: 0, rowsWritten: 2, queries: 1, overloads: 0, errors: 0 });
    expect(b.dnsq).toEqual({ rowsRead: 10, rowsWritten: 0, queries: 2, overloads: 0, errors: 0 });
  });

  it("counts an overload rejection and an other error, rethrowing the SAME error object", async () => {
    const overload = new Error("D1 DB is overloaded. Too many resources consumed within a 10 second window");
    const other = new Error("D1_ERROR: no such table: missing");
    const tally = newTally();
    const over = meterD1(fakeD1(0, 0, overload), tally, "core");
    await expect(over.prepare("x").all()).rejects.toBe(overload);
    await expect(over.prepare("x").run()).rejects.toBe(overload);
    await expect(over.prepare("x").first()).rejects.toBe(overload);
    await expect(over.batch([over.prepare("x")])).rejects.toBe(overload);
    const bad = meterD1(fakeD1(0, 0, other), tally, "audit");
    await expect(bad.prepare("x").raw()).rejects.toBe(other);
    const b = storeBreakdownOf(tally);
    expect(b.core!.overloads).toBe(4);
    expect(b.core!.errors).toBe(0);
    expect(b.audit!.errors).toBe(1);
    expect(b.audit!.overloads).toBe(0);
    expect(tally.queries).toBe(5); // a rejected query is still a query
  });
});

describe("AE point shape v2", () => {
  it("one point per store with queries, record weight 1 on the first only; sums equal the total", () => {
    const tally = { rowsRead: 13, rowsWritten: 4, queries: 5 };
    const pts = d1AttributionPoints("agent:x", tally, {
      core: { rowsRead: 3, rowsWritten: 2, queries: 2, overloads: 1, errors: 0 },
      audit: { rowsRead: 0, rowsWritten: 2, queries: 1, overloads: 0, errors: 1 },
      dnsq: { rowsRead: 10, rowsWritten: 0, queries: 2, overloads: 0, errors: 0 },
      geo: { rowsRead: 0, rowsWritten: 0, queries: 0, overloads: 0, errors: 0 }, // untouched → no point
    });
    expect(pts.map((p) => p.blobs)).toEqual([["agent:x", "core"], ["agent:x", "audit"], ["agent:x", "dnsq"]]);
    expect(pts.map((p) => p.doubles)).toEqual([[3, 2, 2, 1, 0, 1], [0, 2, 1, 0, 1, 0], [10, 0, 2, 0, 0, 0]]);
    expect(pts.every((p) => (p.indexes ?? [])[0] === "agent:x")).toBe(true);
    const sum = (i: number) => pts.reduce((s, p) => s + (p.doubles?.[i] ?? 0), 0);
    expect([sum(0), sum(1), sum(2), sum(5)]).toEqual([13, 4, 5, 1]);
  });

  it("a hand-built tally (no breakdown) keeps one store-less point; a remainder after store points goes to '-'", () => {
    expect(d1AttributionPoints("observatory_nodes", { rowsRead: 7, rowsWritten: 0, queries: 2 }))
      .toEqual([{ blobs: ["observatory_nodes", ""], doubles: [7, 0, 2, 0, 0, 1], indexes: ["observatory_nodes"] }]);
    const pts = d1AttributionPoints("e", { rowsRead: 10, rowsWritten: 0, queries: 3 }, {
      core: { rowsRead: 4, rowsWritten: 0, queries: 1, overloads: 0, errors: 0 },
    });
    expect(pts.map((p) => [p.blobs?.[1], p.doubles])).toEqual([["core", [4, 0, 1, 0, 0, 1]], ["-", [6, 0, 2, 0, 0, 0]]]);
  });

  it("writeD1Attribution stays non-fatal", () => {
    const ae = { writeDataPoint: () => { throw new Error("AE down"); } } as unknown as AnalyticsEngineDataset;
    expect(() => writeD1Attribution(ae, "x", newTally())).not.toThrow();
  });

  it("withD1Meter: inline and :bg points carry their own per-store deltas", async () => {
    const ae = fakeAe();
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const env = { DB: fakeD1(2), DNS_QUEUE_DB: fakeD1(5), AE: ae } as unknown as Env;
    await withD1Meter(env, "cron:t", async (menv, tctx) => {
      await menv.DB.prepare("x").all();
      tctx!.waitUntil((async () => {
        await new Promise((r) => setTimeout(r, 5));
        await menv.DNS_QUEUE_DB!.prepare("y").all();
      })());
    }, ctx);
    for (let i = 0; i < waited.length; i++) await waited[i];
    expect(ae.points.map((p) => [p.blobs, p.doubles])).toEqual([
      [["cron:t", "core"], [2, 0, 1, 0, 0, 1]],
      [["cron:t:bg", "dnsq"], [5, 0, 1, 0, 0, 1]],
    ]);
  });

  it("runWithWorkflowMeter flushes per-store step deltas", async () => {
    const ae = fakeAe();
    const base = { DB: fakeD1(1), AUDIT_DB: fakeD1(0, 3), AE: ae };
    let current: typeof base = base;
    const step = { do: async (_n: string, cb: () => Promise<unknown>) => cb() };
    await runWithWorkflowMeter("workflow:w", base, step, (e) => { current = e; }, async (s) => {
      await s.do("a", async () => current.DB.prepare("x").all());
      await s.do("b", async () => current.AUDIT_DB.prepare("x").run());
      return null;
    });
    expect(ae.points.map((p) => [p.blobs?.[1], p.doubles])).toEqual([
      ["core", [1, 0, 1, 0, 0, 1]],
      ["audit", [0, 3, 1, 0, 0, 1]],
    ]);
  });
});

describe("diagnostics AE readers count records, not store points", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const env = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct" } as unknown as Env;

  it("weights request_count / points by double6 (pre-v2 / store-less points count 1) and lists feed: rows", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
    await fetchD1EndpointAttribution(env);
    await fetchD1HourlyAttribution(env, 6);
    for (const b of bodies) {
      expect(b).toContain("if(blob2 = '', 1, double6)");
      expect(b).toContain("GROUP BY");
      expect(b).not.toMatch(/SUM\(_sample_interval\) AS/);
    }
    expect(bodies[1]).toContain("startsWith(blob1, 'feed:')");
  });
});

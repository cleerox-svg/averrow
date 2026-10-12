/**
 * Tests for the DNS-queue reconciler (keyset cursor on (created_at, rowid)).
 *
 * Driven against a REAL SQLite instance (`node:sqlite`) carrying the prod
 * index DDL (migration 0045 `idx_threats_status_created` + 0001
 * `idx_threats_created_at`), wrapped in a minimal D1 shim that also
 * enforces bind arity (number of `?` == number of binds) on every
 * statement. The SQLite lanes self-skip on a runtime without node:sqlite.
 *
 * Regression pinned (2026-10-06 incident): the old cursor read
 * `created_at >= cursor ORDER BY created_at LIMIT 500` and advanced only
 * when MAX(created_at) > cursor. ≥500 candidate rows sharing the cursor's
 * second (feeds bulk-insert with one `datetime('now')` per batch) froze it
 * forever. The "frozen cursor" test below fails on that code.
 */

import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  reconcileDnsQueue,
  backfillDnsQueueHistory,
  stepDnsQueueReconciler,
  seedDnsQueueCursor,
  parseDnsQueueCursor,
  serializeDnsQueueCursor,
  compareDnsQueueCursor,
  parseReconcileStepParams,
  RECONCILER_TIE_SQL,
  RECONCILER_AFTER_SQL,
  RECONCILER_READ_LIMIT,
} from "../src/lib/dns-queue-reconciler";
import type { Env } from "../src/types";
import { IDP_FAMILY_TECHNIQUES } from "../src/lib/idp-impersonation";

const CURSOR_KEY = "reconciler:dns_queue:cursor";

// ═══════════════════════════════════════════════════════════════════════
// node:sqlite harness + D1 shim
// ═══════════════════════════════════════════════════════════════════════

interface RawStmt {
  all(...p: unknown[]): unknown[];
  run(...p: unknown[]): { changes: number | bigint };
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): RawStmt;
}
type SqliteCtor = new (path: string) => RawDb;

const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: SqliteCtor | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: SqliteCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const noSqlite = DatabaseSync === null;

interface Captured {
  /** Every SELECT against threats, with binds + returned rows. */
  threatSelects: Array<{ sql: string; binds: unknown[]; rows: Array<Record<string, unknown>> }>;
  batches: number;
  batchStatements: number;
}

function countPlaceholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

interface ShimStmt {
  sql: string;
  binds: unknown[];
}

function d1(raw: RawDb, captured: Captured, opts: { batchThrows?: boolean } = {}): D1Database {
  const make = (sql: string, binds: unknown[]): D1PreparedStatement => {
    const checkArity = () => {
      const n = countPlaceholders(sql);
      if (n !== binds.length) {
        throw new Error(`bind arity mismatch: ${n} placeholders, ${binds.length} binds`);
      }
    };
    const stmt = {
      __shim: { sql, binds } as ShimStmt,
      bind: (...args: unknown[]) => make(sql, args),
      all: async () => {
        checkArity();
        const rows = raw.prepare(sql).all(...binds) as Array<Record<string, unknown>>;
        if (/FROM threats/.test(sql)) captured.threatSelects.push({ sql, binds, rows });
        return { results: rows, success: true, meta: {} };
      },
      first: async (col?: string) => {
        checkArity();
        const rows = raw.prepare(sql).all(...binds) as Array<Record<string, unknown>>;
        if (rows.length === 0) return null;
        return col ? rows[0][col] : rows[0];
      },
      run: async () => {
        checkArity();
        const r = raw.prepare(sql).run(...binds);
        return { results: [], success: true, meta: { changes: Number(r.changes) } };
      },
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return {
    prepare: (sql: string) => make(sql, []),
    batch: async (stmts: D1PreparedStatement[]) => {
      captured.batches++;
      captured.batchStatements += stmts.length;
      if (opts.batchThrows) throw new Error("D1_NETWORK_ERROR");
      return stmts.map((s) => {
        const { sql, binds } = (s as unknown as { __shim: ShimStmt }).__shim;
        if (countPlaceholders(sql) !== binds.length) throw new Error("bind arity mismatch (batch)");
        const r = raw.prepare(sql).run(...binds);
        return { results: [], success: true, meta: { changes: Number(r.changes) } };
      });
    },
  } as unknown as D1Database;
}

const THREATS_DDL = `
  CREATE TABLE threats (
    id TEXT PRIMARY KEY,
    source_feed TEXT NOT NULL DEFAULT 'feed',
    malicious_domain TEXT,
    ip_address TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    dns_exhausted_at TEXT,
    technique TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_threats_status ON threats(status);
  CREATE INDEX idx_threats_created_at ON threats(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_threats_status_created ON threats(status, created_at DESC);
`;

// Replayed from migrations-dns-queue/ so the queue shape (incl. the
// 0002 priority column + index) can never drift from prod.
const QUEUE_DDL = readdirSync(resolve(__dirname, "..", "migrations-dns-queue"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(resolve(__dirname, "..", "migrations-dns-queue", f), "utf8"))
  .join("\n");

interface Harness {
  env: Env;
  threats: RawDb;
  queue: RawDb;
  kv: Map<string, string>;
  captured: Captured;
  insert: (rows: Array<{ domain: string | null; created_at: string; status?: string; ip?: string | null }>) => void;
  queueDomains: () => string[];
}

let idSeq = 0;

function makeHarness(opts: {
  cursor?: string | null;
  noQueueBinding?: boolean;
  kvPutThrows?: boolean;
  batchThrows?: boolean;
} = {}): Harness {
  const threats = new DatabaseSync!(":memory:");
  threats.exec(THREATS_DDL);
  const queue = new DatabaseSync!(":memory:");
  queue.exec(QUEUE_DDL);
  const kv = new Map<string, string>();
  if (opts.cursor) kv.set(CURSOR_KEY, opts.cursor);
  const captured: Captured = { threatSelects: [], batches: 0, batchStatements: 0 };

  const env: Partial<Env> = {
    DB: d1(threats, captured),
    CACHE: {
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async put(key: string, value: string) {
        if (opts.kvPutThrows && key === CURSOR_KEY) throw new Error("KV_WRITE_FAILED");
        kv.set(key, value);
      },
    } as unknown as Env["CACHE"],
  };
  if (!opts.noQueueBinding) {
    (env as { DNS_QUEUE_DB?: D1Database }).DNS_QUEUE_DB = d1(queue, captured, { batchThrows: opts.batchThrows });
  }
  const ins = threats.prepare(
    "INSERT INTO threats (id, malicious_domain, ip_address, status, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  return {
    env: env as Env,
    threats,
    queue,
    kv,
    captured,
    insert: (rows) => {
      for (const r of rows) {
        ins.run(`t${++idSeq}`, r.domain, r.ip ?? null, r.status ?? "active", r.created_at);
      }
    },
    queueDomains: () =>
      (queue.prepare("SELECT malicious_domain FROM dns_queue ORDER BY malicious_domain").all() as Array<{ malicious_domain: string }>)
        .map((r) => r.malicious_domain),
  };
}

/** Rows the reconciler returned across all runs, in read order. */
function readRids(h: Harness): number[] {
  return h.captured.threatSelects
    .filter((s) => s.sql.includes("rowid AS rid"))
    .flatMap((s) => s.rows.map((r) => Number(r.rid)));
}

function silenceErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

// ═══════════════════════════════════════════════════════════════════════
// Cursor encoding (pure)
// ═══════════════════════════════════════════════════════════════════════

describe("dns-queue cursor encoding", () => {
  it("parses the legacy bare-timestamp value as rowid 0 (old >= semantics)", () => {
    expect(parseDnsQueueCursor("2026-10-06 12:00:00")).toEqual({ created_at: "2026-10-06 12:00:00", rowid: 0 });
  });

  it("round-trips the JSON keyset form", () => {
    const c = { created_at: "2026-10-06 12:00:00", rowid: 98765 };
    expect(parseDnsQueueCursor(serializeDnsQueueCursor(c))).toEqual(c);
  });

  it("rejects empty / malformed / invalid-rowid values", () => {
    expect(parseDnsQueueCursor(null)).toBeNull();
    expect(parseDnsQueueCursor("")).toBeNull();
    expect(parseDnsQueueCursor("{not json")).toBeNull();
    expect(parseDnsQueueCursor('{"created_at":"2026-10-06 12:00:00"}')).toBeNull();
    expect(parseDnsQueueCursor('{"created_at":"2026-10-06 12:00:00","rowid":-1}')).toBeNull();
    expect(parseDnsQueueCursor('{"created_at":"2026-10-06 12:00:00","rowid":1.5}')).toBeNull();
    expect(parseDnsQueueCursor('{"created_at":"","rowid":1}')).toBeNull();
  });

  it("orders by created_at then rowid", () => {
    const a = { created_at: "2026-10-06 12:00:00", rowid: 5 };
    expect(compareDnsQueueCursor(a, { ...a })).toBe(0);
    expect(compareDnsQueueCursor(a, { ...a, rowid: 6 })).toBe(-1);
    expect(compareDnsQueueCursor({ ...a, created_at: "2026-10-06 12:00:01", rowid: 1 }, a)).toBe(1);
  });
});

describe("parseReconcileStepParams", () => {
  const p = (q: string) => parseReconcileStepParams(new URLSearchParams(q));
  it("defaults to one page, no seed", () => {
    expect(p("")).toEqual({ ok: true, pages: 1, from: null });
  });
  it("accepts pages within 1..20 and a well-formed past from", () => {
    expect(p("pages=20&from=2026-10-06 00:00:00")).toEqual({ ok: true, pages: 20, from: "2026-10-06 00:00:00" });
  });
  it("rejects out-of-range / non-integer pages and malformed or future from", () => {
    expect(p("pages=0").ok).toBe(false);
    expect(p("pages=21").ok).toBe(false);
    expect(p("pages=2.5").ok).toBe(false);
    expect(p("from=2026-10-06T00:00:00Z").ok).toBe(false);
    expect(p("from=2026-13-45 99:99:99").ok).toBe(false);
    expect(p("from=2999-01-01 00:00:00").ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Query shape — EXPLAIN on real SQLite with the prod indexes
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(noSqlite)("reconciler SQL plans", () => {
  const plan = (sql: string, binds: unknown[]): string[] => {
    const h = makeHarness();
    return (h.threats.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
      .map((r) => r.detail);
  };

  it("tie query seeks exactly on (status, created_at, rowid) — no re-read of the cursor's second", () => {
    const p = plan(RECONCILER_TIE_SQL, ["2026-10-06 12:00:00", 10, 500]);
    expect(p.join("\n")).toMatch(
      /SEARCH threats USING INDEX idx_threats_status_created \(status=\? AND created_at=\? AND rowid>\?\)/,
    );
    expect(p.join("\n")).not.toMatch(/SCAN threats|TEMP B-TREE/);
  });

  it("after query range-seeks on (status, created_at) — never a table scan or full sort", () => {
    const p = plan(RECONCILER_AFTER_SQL, ["2026-10-06 12:00:00", 500]).join("\n");
    expect(p).toMatch(/SEARCH threats USING INDEX idx_threats_status_created \(status=\? AND created_at>\?\)/);
    expect(p).not.toMatch(/SCAN threats/);
    // Only the per-second rowid tiebreak is sorted, never the whole range.
    expect(p).not.toMatch(/USE TEMP B-TREE FOR ORDER BY/);
  });

  it("bind arity: tie = 3 placeholders, after = 2", () => {
    expect(countPlaceholders(RECONCILER_TIE_SQL)).toBe(3);
    expect(countPlaceholders(RECONCILER_AFTER_SQL)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// reconcileDnsQueue
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(noSqlite)("reconcileDnsQueue (keyset cursor)", () => {
  it("returns skipped when DNS_QUEUE_DB is unbound", async () => {
    const h = makeHarness({ noQueueBinding: true });
    const result = await reconcileDnsQueue(h.env);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("binding_unset");
  });

  it("REGRESSION: ≥500 candidates sharing the cursor's second no longer freeze the cursor", async () => {
    const SECOND = "2026-10-06 12:00:00";
    // 1,200 candidates in ONE second (a bulk feed batch), then later rows.
    const h = makeHarness({ cursor: SECOND });
    h.insert(Array.from({ length: 1200 }, (_, i) => ({ domain: `bulk${i}.example`, created_at: SECOND })));
    h.insert(Array.from({ length: 300 }, (_, i) => ({ domain: `later${i}.example`, created_at: "2026-10-06 12:00:05" })));
    h.insert([{ domain: "tail.example", created_at: "2026-10-07 00:00:00" }]);

    const cursors: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await reconcileDnsQueue(h.env);
      expect(r.skipped).toBe(false);
      expect(r.cursorStuck).toBe(false);
      cursors.push(r.cursorAfter ?? "");
      if (r.scanned < RECONCILER_READ_LIMIT) break;
    }
    // Every candidate reached the queue (old code: stuck at the first 500 forever).
    expect(h.queueDomains()).toHaveLength(1501);
    // Cursor strictly advanced every page and ended on the last row.
    for (let i = 1; i < cursors.length; i++) {
      expect(compareDnsQueueCursor(parseDnsQueueCursor(cursors[i])!, parseDnsQueueCursor(cursors[i - 1])!))
        .toBeGreaterThanOrEqual(0);
    }
    expect(parseDnsQueueCursor(h.kv.get(CURSOR_KEY) ?? null)?.created_at).toBe("2026-10-07 00:00:00");
    // Never re-read a row: total read == distinct candidates.
    const rids = readRids(h);
    expect(new Set(rids).size).toBe(rids.length);
    expect(rids).toHaveLength(1501);
  });

  it("walks a mixed table with no duplicate and no skip across pages, ignoring non-candidates", async () => {
    const h = makeHarness({ cursor: "2026-10-01 00:00:00" });
    // Deterministic pseudo-random mix: ties straddling page boundaries,
    // interleaved non-candidates (resolved IP, inactive, wildcard, no dot).
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 2600; i++) {
      const sec = Math.floor(rnd() * 40); // ~65 rows/second → many ties
      const ts = `2026-10-02 00:00:${String(sec).padStart(2, "0")}`;
      const kind = rnd();
      h.insert([{
        domain: kind < 0.05 ? "*.wild.example" : kind < 0.08 ? "nodot" : `d${i}.example`,
        created_at: ts,
        status: kind > 0.95 ? "down" : "active",
        ip: kind > 0.9 && kind <= 0.95 ? "1.2.3.4" : null,
      }]);
    }
    const expected = (h.threats.prepare(`
      SELECT rowid AS rid FROM threats
      WHERE status='active' AND ip_address IS NULL AND dns_exhausted_at IS NULL
        AND malicious_domain IS NOT NULL AND malicious_domain != ''
        AND malicious_domain NOT LIKE '*%' AND malicious_domain LIKE '%.%'
      ORDER BY created_at, rowid
    `).all() as Array<{ rid: number }>).map((r) => r.rid);
    expect(expected.length).toBeGreaterThan(2 * RECONCILER_READ_LIMIT);

    for (let i = 0; i < 20; i++) {
      const r = await reconcileDnsQueue(h.env);
      if (r.scanned < RECONCILER_READ_LIMIT) break;
    }
    expect(readRids(h)).toEqual(expected);
  });

  it("migrates a legacy KV cursor: re-reads its own second from the start, then writes JSON", async () => {
    const h = makeHarness({ cursor: "2026-10-06 12:00:00" });
    h.insert([
      { domain: "before.example", created_at: "2026-10-06 11:59:59" },
      { domain: "same.example", created_at: "2026-10-06 12:00:00" },
      { domain: "after.example", created_at: "2026-10-06 12:00:01" },
    ]);
    const r = await reconcileDnsQueue(h.env);
    expect(r.scanned).toBe(2);
    expect(h.queueDomains()).toEqual(["after.example", "same.example"]);
    const stored = h.kv.get(CURSOR_KEY)!;
    expect(stored.startsWith("{")).toBe(true);
    expect(parseDnsQueueCursor(stored)?.created_at).toBe("2026-10-06 12:00:01");
  });

  it("picks up a row inserted later in the cursor's own second", async () => {
    const SECOND = "2026-10-06 12:00:00";
    const h = makeHarness({ cursor: "2026-10-06 11:00:00" });
    h.insert([{ domain: "first.example", created_at: SECOND }]);
    await reconcileDnsQueue(h.env);
    expect(parseDnsQueueCursor(h.kv.get(CURSOR_KEY)!)?.created_at).toBe(SECOND);
    h.insert([{ domain: "late.example", created_at: SECOND }]);
    const r = await reconcileDnsQueue(h.env);
    expect(r.scanned).toBe(1);
    expect(h.queueDomains()).toContain("late.example");
  });

  it("bootstraps cursor to ~30 min ago when KV cursor is missing", async () => {
    const h = makeHarness({ cursor: null });
    const before = Date.now();
    await reconcileDnsQueue(h.env);
    const sel = h.captured.threatSelects[0];
    const cursorBound = sel.binds[0] as string;
    expect(cursorBound).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const ageMin = (before - Date.parse(cursorBound.replace(" ", "T") + "Z")) / 60_000;
    expect(ageMin).toBeGreaterThanOrEqual(29);
    expect(ageMin).toBeLessThanOrEqual(31);
  });

  it("keeps cursor when no candidates are found in the tick", async () => {
    const h = makeHarness({ cursor: "2026-10-06 12:00:00" });
    const result = await reconcileDnsQueue(h.env);
    expect(result.scanned).toBe(0);
    expect(result.enqueued).toBe(0);
    expect(h.kv.get(CURSOR_KEY)).toBe("2026-10-06 12:00:00"); // untouched
    expect(result.cursorAfter).toBe(result.cursorBefore);
    expect(h.captured.batches).toBe(0);
  });

  it("dedupes duplicate malicious_domains within one tick", async () => {
    const h = makeHarness({ cursor: "2026-10-06 12:00:00" });
    h.insert([
      { domain: "dup.com", created_at: "2026-10-06 12:01:00" },
      { domain: "dup.com", created_at: "2026-10-06 12:01:30" },
      { domain: "other.com", created_at: "2026-10-06 12:02:00" },
    ]);
    const result = await reconcileDnsQueue(h.env);
    expect(result.scanned).toBe(3);
    expect(h.captured.batchStatements).toBe(2);
    expect(result.enqueued).toBe(2);
  });

  it("surfaces KV cursor-write failures via lastError without throwing", async () => {
    const spy = silenceErrors();
    const h = makeHarness({ cursor: "2026-10-06 12:00:00", kvPutThrows: true });
    h.insert([{ domain: "x.com", created_at: "2026-10-06 12:05:00" }]);
    const result = await reconcileDnsQueue(h.env);
    expect(result.skipped).toBe(false);
    expect(result.enqueued).toBe(1);
    expect(result.lastError).toMatch(/KV_WRITE_FAILED/);
    spy.mockRestore();
  });

  it("surfaces batch failures, counts them, and still advances the cursor", async () => {
    const spy = silenceErrors();
    const h = makeHarness({ cursor: "2026-10-06 12:00:00", batchThrows: true });
    h.insert([{ domain: "x.com", created_at: "2026-10-06 12:05:00" }]);
    const result = await reconcileDnsQueue(h.env);
    expect(result.batchesAttempted).toBe(1);
    expect(result.batchesFailed).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.lastError).toMatch(/D1_NETWORK_ERROR/);
    expect(parseDnsQueueCursor(h.kv.get(CURSOR_KEY)!)?.created_at).toBe("2026-10-06 12:05:00");
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Defensive self-heal — a full page that makes no progress
// ═══════════════════════════════════════════════════════════════════════

describe("reconcileDnsQueue self-heal", () => {
  it("flags cursorStuck and skips the rest of the second when a full page makes no progress", async () => {
    const spy = silenceErrors();
    const kv = new Map<string, string>([[CURSOR_KEY, serializeDnsQueueCursor({ created_at: "2026-10-06 12:00:00", rowid: 900 })]]);
    // A broken D1 that hands back a full page of rows at/behind the cursor.
    const badRows = Array.from({ length: RECONCILER_READ_LIMIT }, (_, i) => ({
      rid: 1 + (i % 3), malicious_domain: `b${i}.example`, source_feed: "f", created_at: "2026-10-06 12:00:00",
    }));
    let calls = 0;
    const db = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: calls++ === 0 ? badRows : [] }),
          first: async () => null,
        }),
      }),
    };
    const queueDb = {
      prepare: (sql: string) => /COUNT/.test(sql)
        ? { first: async () => ({ n: 0 }) }
        : { bind: () => ({}) },
      batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 1 } })),
    };
    const env = {
      DB: db, DNS_QUEUE_DB: queueDb,
      CACHE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
    } as unknown as Env;

    const r = await reconcileDnsQueue(env);
    expect(r.cursorStuck).toBe(true);
    expect(r.lastError).toMatch(/cursor_stuck/);
    expect(parseDnsQueueCursor(kv.get(CURSOR_KEY)!)).toEqual({
      created_at: "2026-10-06 12:00:00", rowid: Number.MAX_SAFE_INTEGER,
    });
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Internal catch-up step + seed, and the backfill's cursor read
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(noSqlite)("stepDnsQueueReconciler / seedDnsQueueCursor", () => {
  it("runs pages back-to-back and stops once caught up", async () => {
    const h = makeHarness({ cursor: "2026-10-06 00:00:00" });
    h.insert(Array.from({ length: 1100 }, (_, i) => ({ domain: `s${i}.example`, created_at: "2026-10-06 01:00:00" })));
    const r = await stepDnsQueueReconciler(h.env, 20);
    expect(r.pages).toBe(3);
    expect(r.caughtUp).toBe(true);
    expect(r.scanned).toBe(1100);
    expect(r.enqueued).toBe(1100);
    expect(h.queueDomains()).toHaveLength(1100);
  });

  it("clamps pages to the route cap", async () => {
    const h = makeHarness({ cursor: "2026-10-06 00:00:00" });
    h.insert(Array.from({ length: 25 * RECONCILER_READ_LIMIT }, (_, i) => ({
      domain: `c${i}.example`, created_at: "2026-10-06 01:00:00",
    })));
    const r = await stepDnsQueueReconciler(h.env, 1000);
    expect(r.pages).toBe(20);
    expect(r.caughtUp).toBe(false);
  });

  it("seed rewinds the cursor to the start of a second", async () => {
    const h = makeHarness({ cursor: serializeDnsQueueCursor({ created_at: "2026-10-09 00:00:00", rowid: 5 }) });
    h.insert([{ domain: "old.example", created_at: "2026-10-06 03:00:00" }]);
    await seedDnsQueueCursor(h.env, "2026-10-06 00:00:00");
    const r = await stepDnsQueueReconciler(h.env, 1);
    expect(r.scanned).toBe(1);
    expect(h.queueDomains()).toEqual(["old.example"]);
  });

  it("historical backfill initialises its boundary from a JSON forward cursor", async () => {
    const h = makeHarness({ cursor: serializeDnsQueueCursor({ created_at: "2026-10-06 12:00:00", rowid: 42 }) });
    h.insert([{ domain: "hist.example", created_at: "2026-10-01 00:00:00" }]);
    const r = await backfillDnsQueueHistory(h.env);
    expect(r.skipped).toBe(false);
    const sel = h.captured.threatSelects.find((s) => /ORDER BY created_at DESC/.test(s.sql))!;
    expect(sel.binds[0]).toBe("2026-10-06 12:00:00");
    expect(h.queueDomains()).toEqual(["hist.example"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// IdP priority lane (lib/dns-queue-priority.ts, DNS-queue migration 0002)
// ═══════════════════════════════════════════════════════════════════════

describe.skipIf(noSqlite)("reconciler stamps the IdP priority lane", () => {
  const priorities = (h: Harness) =>
    Object.fromEntries(
      (h.queue.prepare("SELECT malicious_domain, priority FROM dns_queue").all() as Array<{ malicious_domain: string; priority: number }>)
        .map((r) => [r.malicious_domain, r.priority]),
    );

  it("IdP-family candidates enqueue at priority 1, others at 0; an already-queued domain is promoted", async () => {
    const SECOND = "2026-10-06 12:00:00";
    const h = makeHarness({ cursor: SECOND });
    h.queue.exec("INSERT INTO dns_queue (malicious_domain, priority) VALUES ('queued.example', 0)");
    const ins = h.threats.prepare(
      "INSERT INTO threats (id, malicious_domain, status, technique, created_at) VALUES (?, ?, 'active', ?, ?)",
    );
    ins.run("p1", "okta-sso.example", IDP_FAMILY_TECHNIQUES[0], "2026-10-06 12:00:01");
    ins.run("p2", "plain.example", null, "2026-10-06 12:00:01");
    ins.run("p3", "queued.example", IDP_FAMILY_TECHNIQUES[0], "2026-10-06 12:00:02");
    // Same domain twice in one page, normal first then IdP → max wins.
    ins.run("p4", "dup.example", null, "2026-10-06 12:00:03");
    ins.run("p5", "dup.example", IDP_FAMILY_TECHNIQUES[0], "2026-10-06 12:00:03");

    const r = await reconcileDnsQueue(h.env);
    expect(r.skipped).toBe(false);
    expect(r.enqueued).toBe(4); // 3 inserts + 1 promotion
    expect(priorities(h)).toEqual({
      "okta-sso.example": 1,
      "plain.example": 0,
      "queued.example": 1,
      "dup.example": 1,
    });

    // Re-running the same page never demotes and writes nothing.
    await seedDnsQueueCursor(h.env, SECOND);
    const again = await reconcileDnsQueue(h.env);
    expect(again.enqueued).toBe(0);
    expect(priorities(h)["queued.example"]).toBe(1);
  });
});

// DNS-queue IdP priority lane (lib/dns-queue-priority.ts, DNS-queue
// migration 0002): promote-only upsert, drain order, query plans, bind
// arity, binding-absent no-ops, and the internal prioritize-idp route.
//
// The queue DB is replayed from migrations-dns-queue/ and the threats DB is
// derived from migrations/ (+ live indexes), so plans pin what prod can pick.

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "../src/types";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));

import worker from "../src/index";
import {
  DNS_DRAIN_NORMAL_SQL,
  DNS_DRAIN_PRIORITY_SQL,
  DNS_PRIORITY_IDP,
  DNS_PRIORITY_NORMAL,
  DNS_QUEUE_UPSERT_SQL,
  PRIORITIZE_IDP_SELECT_SQL,
  dnsPriorityForTechnique,
  dnsQueueUpsertStmt,
  enqueueIdpDns,
  parsePrioritizeIdpParams,
  prioritizeIdpDns,
} from "../src/lib/dns-queue-priority";
import { runDomainGeoBackfillBatch } from "../src/lib/dns-backfill";
import * as resolverModule from "../src/lib/domain-resolver";
import { IDP_FAMILY_TECHNIQUES } from "../src/lib/idp-impersonation";
import { d1FromSqlite, hasSqlite, openDerivedDb, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";

const noSqlite = !hasSqlite();
const IDP = IDP_FAMILY_TECHNIQUES[0]!;
const placeholders = (sql: string): number => (sql.match(/\?/g) ?? []).length;

const QUEUE_DIR = resolve(__dirname, "..", "migrations-dns-queue");
function openQueue(): SqliteDb {
  // openDerivedDb([]) would demand a main-DB table; build the queue from its own dir.
  const raw = openDerivedDb(["threats"]);
  raw.exec("DROP TABLE threats");
  for (const f of readdirSync(QUEUE_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(resolve(QUEUE_DIR, f), "utf8"));
  }
  return raw;
}

function openThreats(): SqliteDb {
  const raw = openDerivedDb(["threats"]);
  for (const ddl of liveIndexDdl("threats").values()) raw.exec(ddl);
  return raw;
}

const plan = (raw: SqliteDb, sql: string, binds: unknown[]): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map((r) => r.detail).join("\n");

function queueRows(raw: SqliteDb): Array<{ malicious_domain: string; priority: number; attempted_resolve_at: string | null }> {
  return raw.prepare("SELECT malicious_domain, priority, attempted_resolve_at FROM dns_queue ORDER BY malicious_domain")
    .all() as Array<{ malicious_domain: string; priority: number; attempted_resolve_at: string | null }>;
}

afterEach(() => vi.restoreAllMocks());

describe("technique → priority", () => {
  it("IdP family → 1, anything else → 0", () => {
    for (const t of IDP_FAMILY_TECHNIQUES) expect(dnsPriorityForTechnique(t)).toBe(DNS_PRIORITY_IDP);
    expect(dnsPriorityForTechnique(null)).toBe(DNS_PRIORITY_NORMAL);
    expect(dnsPriorityForTechnique("credential_harvesting")).toBe(DNS_PRIORITY_NORMAL);
  });
});

describe.skipIf(noSqlite)("dns_queue plans (EXPLAIN on real SQLite, migration-replayed indexes)", () => {
  it("priority drain walks idx_dns_queue_priority_drainable", () => {
    const p = plan(openQueue(), DNS_DRAIN_PRIORITY_SQL, [500]);
    expect(p).toMatch(/SCAN dns_queue USING INDEX idx_dns_queue_priority_drainable/);
    expect(p).not.toMatch(/TEMP B-TREE/);
  });

  it("normal drain keeps idx_dns_queue_drainable (priority = 0 is a residual)", () => {
    const p = plan(openQueue(), DNS_DRAIN_NORMAL_SQL, [500]);
    expect(p).toMatch(/SCAN dns_queue USING INDEX idx_dns_queue_drainable/);
    expect(p).not.toMatch(/TEMP B-TREE/);
  });

  it("prioritize-idp select range-seeks idx_threats_technique_created", () => {
    const binds = [...IDP_FAMILY_TECHNIQUES, "2026-10-01 00:00:00", 500];
    const p = plan(openThreats(), PRIORITIZE_IDP_SELECT_SQL, binds);
    expect(p).toMatch(/SEARCH threats USING INDEX idx_threats_technique_created \(technique=\? AND created_at>\?\)/);
    expect(p).not.toMatch(/SCAN threats/);
  });

  it("bind arity", () => {
    expect(placeholders(DNS_DRAIN_PRIORITY_SQL)).toBe(1);
    expect(placeholders(DNS_DRAIN_NORMAL_SQL)).toBe(1);
    expect(placeholders(DNS_QUEUE_UPSERT_SQL)).toBe(3);
    expect(placeholders(PRIORITIZE_IDP_SELECT_SQL)).toBe(IDP_FAMILY_TECHNIQUES.length + 2);
  });
});

describe.skipIf(noSqlite)("promote-only upsert", () => {
  it("inserts new rows with their priority, promotes 0→1, never demotes, keeps attempts/cooldown", async () => {
    const raw = openQueue();
    const db = d1FromSqlite(raw);
    raw.exec("INSERT INTO dns_queue (malicious_domain, enrichment_attempts, attempted_resolve_at) VALUES ('old.example', 3, '2026-10-12 00:00:00')");

    const r1 = await dnsQueueUpsertStmt(db, "new.example", "feed", DNS_PRIORITY_NORMAL).run();
    const r2 = await dnsQueueUpsertStmt(db, "old.example", "feed", DNS_PRIORITY_IDP).run();
    const r3 = await dnsQueueUpsertStmt(db, "old.example", "feed", DNS_PRIORITY_NORMAL).run();
    const r4 = await dnsQueueUpsertStmt(db, "new.example", "feed", DNS_PRIORITY_NORMAL).run();
    expect([r1.meta.changes, r2.meta.changes, r3.meta.changes, r4.meta.changes]).toEqual([1, 1, 0, 0]);

    const old = raw.prepare("SELECT priority, enrichment_attempts, attempted_resolve_at FROM dns_queue WHERE malicious_domain = 'old.example'").all()[0];
    expect(old).toEqual({ priority: 1, enrichment_attempts: 3, attempted_resolve_at: "2026-10-12 00:00:00" });
    expect(queueRows(raw).find((r) => r.malicious_domain === "new.example")?.priority).toBe(0);
  });

  it("enqueueIdpDns dedupes, skips unqueueable domains and chunks at 50", async () => {
    const raw = openQueue();
    const db = d1FromSqlite(raw);
    const batch = vi.spyOn(db, "batch");
    const items = [
      ...Array.from({ length: 60 }, (_, i) => ({ malicious_domain: `idp${i}.example`, source_feed: "f" })),
      { malicious_domain: "idp0.example", source_feed: "f" },
      { malicious_domain: "*.wild.example", source_feed: "f" },
      { malicious_domain: "nodot", source_feed: "f" },
      { malicious_domain: "", source_feed: "f" },
      { malicious_domain: null, source_feed: "f" },
    ];
    expect(await enqueueIdpDns(db, items)).toBe(60);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(queueRows(raw).every((r) => r.priority === DNS_PRIORITY_IDP)).toBe(true);
  });

  it("enqueueIdpDns is a no-op without DNS_QUEUE_DB and never throws on batch failure", async () => {
    expect(await enqueueIdpDns(undefined, [{ malicious_domain: "a.example", source_feed: null }])).toBe(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error("D1 down"); } } as unknown as D1Database;
    expect(await enqueueIdpDns(failing, [{ malicious_domain: "a.example", source_feed: null }])).toBe(0);
  });
});

describe.skipIf(noSqlite)("drain order — IdP lane first", () => {
  function setup() {
    const raw = openQueue();
    for (const d of ["n1.example", "n2.example", "n3.example"]) {
      raw.prepare("INSERT INTO dns_queue (malicious_domain, priority) VALUES (?, 0)").run(d);
    }
    for (const d of ["p1.example", "p2.example"]) {
      raw.prepare("INSERT INTO dns_queue (malicious_domain, priority) VALUES (?, 1)").run(d);
    }
    // A priority row in cooldown must NOT jump the queue (or appear via the normal lane).
    raw.prepare("INSERT INTO dns_queue (malicious_domain, priority, attempted_resolve_at) VALUES ('pcool.example', 1, datetime('now'))").run();
    const threatsStmt = {
      bind: () => threatsStmt,
      run: async () => ({ success: true, meta: { changes: 0 } }),
      all: async () => ({ results: [] }),
      first: async () => null,
    };
    const env = {
      DB: { prepare: () => threatsStmt, batch: async (s: unknown[]) => s.map(() => ({ success: true, meta: { changes: 0 } })) },
      DNS_QUEUE_DB: d1FromSqlite(raw),
    } as unknown as Env;
    const resolved: string[] = [];
    vi.spyOn(resolverModule, "resolveDomain").mockImplementation(async (d: string) => {
      resolved.push(d);
      return { kind: "transient" };
    });
    return { raw, env, resolved };
  }

  it("a batch smaller than the priority lane takes only priority rows", async () => {
    const h = setup();
    await runDomainGeoBackfillBatch(h.env, { batchSize: 2, timeoutMs: 30_000 });
    expect(h.resolved.sort()).toEqual(["p1.example", "p2.example"]);
  });

  it("the normal lane fills the remainder, with no duplicates", async () => {
    const h = setup();
    await runDomainGeoBackfillBatch(h.env, { batchSize: 4, timeoutMs: 30_000 });
    expect(h.resolved).toHaveLength(4);
    expect(new Set(h.resolved).size).toBe(4);
    expect(h.resolved.filter((d) => d.startsWith("p")).sort()).toEqual(["p1.example", "p2.example"]);
    expect(h.resolved).not.toContain("pcool.example");
  });
});

describe.skipIf(noSqlite)("prioritizeIdpDns", () => {
  function setup(bound = true) {
    const threats = openThreats();
    const ins = threats.prepare(
      "INSERT INTO threats (id, source_feed, threat_type, malicious_domain, ip_address, status, technique, created_at) VALUES (?, 'f', 'phishing', ?, ?, 'active', ?, ?)",
    );
    const now = "2026-10-12 12:00:00";
    ins.run("t1", "okta-login.example", null, IDP, now);
    ins.run("t2", "resolved.example", "1.2.3.4", IDP, now);          // has ip → skip
    ins.run("t3", "plain.example", null, null, now);                  // not IdP → skip
    ins.run("t4", "ancient.example", null, IDP, "2026-01-01 00:00:00"); // outside window
    ins.run("t5", "okta-login.example", null, IDP, now);              // duplicate domain
    const queue = openQueue();
    queue.exec("INSERT INTO dns_queue (malicious_domain, priority) VALUES ('okta-login.example', 0)");
    const env = { DB: d1FromSqlite(threats), ...(bound ? { DNS_QUEUE_DB: d1FromSqlite(queue) } : {}) } as unknown as Env;
    return { env, queue };
  }

  it("promotes in-window, unresolved IdP threats only", async () => {
    const h = setup();
    const r = await prioritizeIdpDns(h.env, 14, 500, new Date("2026-10-12T13:00:00Z"));
    expect(r).toMatchObject({ skipped: false, scanned: 2, domains: 1, enqueued: 1 });
    expect(queueRows(h.queue)).toEqual([{ malicious_domain: "okta-login.example", priority: 1, attempted_resolve_at: null }]);
  });

  it("is a no-op without DNS_QUEUE_DB", async () => {
    const h = setup(false);
    const r = await prioritizeIdpDns(h.env, 14, 500);
    expect(r).toMatchObject({ skipped: true, reason: "binding_unset", scanned: 0 });
  });
});

describe("prioritize-idp params", () => {
  const p = (q: string) => parsePrioritizeIdpParams(new URLSearchParams(q));
  it("defaults to 14 days / 500 rows", () => expect(p("")).toEqual({ ok: true, days: 14, limit: 500 }));
  it("accepts in-range values", () => expect(p("days=30&limit=1000")).toEqual({ ok: true, days: 30, limit: 1000 }));
  it("rejects out-of-range or non-integer values", () => {
    for (const q of ["days=0", "days=31", "limit=0", "limit=1001", "days=2.5", "limit=-1", "days=abc"]) {
      expect(p(q).ok, q).toBe(false);
    }
  });
});

describe("POST /api/internal/dns-queue/prioritize-idp", () => {
  const SECRET = "test-internal-secret";
  const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  function makeEnv() {
    const sql: string[] = [];
    const stmt = { bind: () => stmt, all: async () => ({ results: [] }), run: async () => ({ success: true, meta: {} }) };
    const env = {
      AVERROW_INTERNAL_SECRET: SECRET,
      CACHE: { get: async () => null, put: async () => {}, delete: async () => {} },
      DB: { prepare: (s: string) => { sql.push(s); return stmt; }, batch: async () => [] },
      DNS_QUEUE_DB: { prepare: () => stmt, batch: async () => [] },
    } as unknown as Env;
    return { env, sql };
  }
  const call = (path: string, env: Env, auth: string | null = `Bearer ${SECRET}`, method = "POST") => {
    const headers = new Headers();
    if (auth !== null) headers.set("Authorization", auth);
    return worker.fetch(new Request(`https://averrow.com${path}`, { method, headers }), env, execCtx);
  };
  const PATH = "/api/internal/dns-queue/prioritize-idp";

  it("401 without / with a wrong secret, and runs no SQL", async () => {
    const h = makeEnv();
    expect((await call(PATH, h.env, null)).status).toBe(401);
    expect((await call(PATH, h.env, "Bearer nope")).status).toBe(401);
    expect(h.sql.filter((s) => s.includes("idx_threats_technique_created"))).toEqual([]);
  }, 60_000);

  it("400 on out-of-range bounds", async () => {
    const h = makeEnv();
    const res = await call(`${PATH}?days=31&limit=500`, h.env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
    expect((await call(`${PATH}?limit=5000`, h.env)).status).toBe(400);
  }, 60_000);

  it("200 with the bounded result on a valid call", async () => {
    const h = makeEnv();
    const res = await call(`${PATH}?days=14&limit=500`, h.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { days: number; scanned: number } };
    expect(body).toMatchObject({ success: true, data: { days: 14, scanned: 0, skipped: false } });
    expect(h.sql.some((s) => s.includes("idx_threats_technique_created"))).toBe(true);
  }, 60_000);
});

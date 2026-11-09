// Pins: a filtered /api/threats total is computed once per slice (filters +
// org scope) and shared across pages and sorts, via cachedCount. Before this
// the list cache key carried sort/dir/limit/offset, so paging or re-sorting a
// broad slice (e.g. status=active) re-ran the same COUNT(*) every time.

import { describe, it, expect } from "vitest";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv, type StatementLogEntry } from "./sqlite-d1-harness";
import { handleListThreats, threatListTotalKey, THREAT_LIST_FILTERED_TOTAL_TTL_S } from "../src/handlers/threats";
import type { Env } from "../src/types";

function makeEnv() {
  const raw = openMigratedDb();
  // threats.registration_date exists in prod but no migration adds it.
  const cols = raw.prepare("PRAGMA table_info(threats)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "registration_date")) raw.exec("ALTER TABLE threats ADD COLUMN registration_date TEXT");
  const log: StatementLogEntry[] = [];
  const db = d1FromSqlite(raw, { log });
  const dbWithSession = Object.assign(db, {
    withSession: () => Object.assign(Object.create(db), { getBookmark: () => null }),
  });
  const kv = fakeKv();
  const env = { DB: dbWithSession, CACHE: kv } as unknown as Env;
  const ins = raw.prepare(
    "INSERT INTO threats (id, threat_type, severity, status, source_feed, malicious_domain, created_at) VALUES (?, 'phishing', ?, ?, 'feed', ?, datetime('now'))",
  );
  for (let i = 0; i < 7; i++) ins.run(`a${i}`, "high", "active", `a${i}.example`);
  for (let i = 0; i < 3; i++) ins.run(`d${i}`, "low", "down", `d${i}.example`);
  return { env, raw, log, kv };
}

const req = (q: string) => new Request(`https://averrow.test/api/threats?${q}`);
const countReads = (log: StatementLogEntry[]) =>
  log.filter((e) => /^SELECT COUNT\(\*\) as cnt FROM threats t WHERE/.test(e.sql.trim()));

type ListBody = { success: boolean; data: { threats: Array<{ id: string }>; total: number } };

describe("threatListTotalKey", () => {
  it("encodes every WHERE-shaping filter and the scope, not sort or paging", () => {
    const base = { severity: "high", type: null, status: "active", source: null, country: "US", brandId: null, search: null };
    const k = threatListTotalKey(base, "global");
    expect(k).toBe("count.threats.list:high::active::US:::global");
    expect(threatListTotalKey({ ...base, search: "x" }, "global")).not.toBe(k);
    expect(threatListTotalKey(base, "org:o1:abc")).not.toBe(k);
    expect(THREAT_LIST_FILTERED_TOTAL_TTL_S).toBe(300);
  });

  it("escapes ':' inside values so adjacent filters can't collide", () => {
    const none = { severity: null, type: null, status: null, source: null, country: null, brandId: null, search: null };
    const joined = threatListTotalKey({ ...none, brandId: "x:y" }, "global");
    const split = threatListTotalKey({ ...none, brandId: "x", search: "y" }, "global");
    expect(joined).not.toBe(split);
    expect(joined).toBe("count.threats.list::::::x%3Ay::global");
    expect(split).toBe("count.threats.list::::::x:y:global");
    // The scope segment stays last and unescaped.
    expect(threatListTotalKey(none, "org:o1:abc").endsWith(":org:o1:abc")).toBe(true);
  });
});

describe.skipIf(!hasSqlite())("filtered /api/threats total", () => {
  it("is computed once per slice and reused across pages and sorts", async () => {
    const { env, log, kv } = makeEnv();
    const p1 = await (await handleListThreats(req("status=active&limit=5&offset=0"), env, null)).json() as ListBody;
    const p2 = await (await handleListThreats(req("status=active&limit=5&offset=5"), env, null)).json() as ListBody;
    const resorted = await (await handleListThreats(req("status=active&limit=5&offset=0&sort=type&dir=asc"), env, null)).json() as ListBody;

    expect(p1.data.total).toBe(7);
    expect(p2.data.total).toBe(7);
    expect(resorted.data.total).toBe(7);
    expect(p1.data.threats).toHaveLength(5);
    expect(p2.data.threats).toHaveLength(2);
    // One COUNT for three list requests on the same slice.
    expect(countReads(log)).toHaveLength(1);
    expect([...kv.store.keys()].some((k) => k.endsWith("count.threats.list:::active:::::global"))).toBe(true);
  });

  it("a different slice gets its own exact count", async () => {
    const { env, log } = makeEnv();
    const active = await (await handleListThreats(req("status=active"), env, null)).json() as ListBody;
    const down = await (await handleListThreats(req("status=down"), env, null)).json() as ListBody;
    expect(active.data.total).toBe(7);
    expect(down.data.total).toBe(3);
    expect(countReads(log)).toHaveLength(2);
  });
});

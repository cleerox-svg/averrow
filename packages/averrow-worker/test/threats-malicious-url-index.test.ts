// Pin: migration 0278's partial idx_threats_malicious_url serves the
// abuse-mailbox exact-URL correlation lookup (lib/abuse-mailbox-iocs.ts
// correlateUrls) AS WRITTEN — `malicious_url = ?` implies the index's
// `malicious_url IS NOT NULL`, so no extra predicate is needed. Before
// 0278 the lookup was a full `SCAN threats` (~10M rows read/day).
//
// Runs the SQL extracted from source against the migration-derived threats
// shape + the live (post-DROP) index set from migrations/.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasSqlite, openDerivedDb, d1FromSqlite, sqlContaining, type SqliteDb } from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import { correlateUrls } from "../src/lib/abuse-mailbox-iocs";
import type { Env } from "../src/types";

const SRC = resolve(__dirname, "..", "src");
const read = (f: string) => readFileSync(resolve(SRC, f), "utf8");

function openThreats(): SqliteDb {
  const raw = openDerivedDb(["threats"]);
  for (const ddl of liveIndexDdl("threats").values()) raw.exec(ddl);
  return raw;
}

const plan = (raw: SqliteDb, sql: string, ...binds: unknown[]): string =>
  (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");

const URL_LOOKUP = () => sqlContaining(read("lib/abuse-mailbox-iocs.ts"), ["WHERE malicious_url = ?", "LIMIT 1"]);

describe.skipIf(!hasSqlite())("idx_threats_malicious_url (migration 0278)", () => {
  it("is defined by 0278 as a partial index and survives replay", () => {
    const ddl = liveIndexDdl("threats").get("idx_threats_malicious_url");
    expect(ddl).toBeDefined();
    expect(ddl!.replace(/\s+/g, " ")).toMatch(/ON threats\(malicious_url\) WHERE malicious_url IS NOT NULL/);
  });

  it("the abuse-mailbox exact-URL lookup seeks the index, never scans threats", () => {
    const p = plan(openThreats(), URL_LOOKUP(), "https://evil.example/login");
    expect(p).toContain("idx_threats_malicious_url (malicious_url=?)");
    expect(p).not.toMatch(/SCAN threats/);
  });

  it("still picks the index under prod-like planner stats", () => {
    const raw = openThreats();
    raw.exec("ANALYZE");
    raw.exec("DELETE FROM sqlite_stat1");
    const ins = raw.prepare("INSERT INTO sqlite_stat1(tbl, idx, stat) VALUES ('threats', ?, ?)");
    ins.run(null, "1250000");
    ins.run("idx_threats_malicious_url", "600000 1");
    ins.run("idx_threats_domain", "1250000 3");
    raw.exec("ANALYZE sqlite_schema");
    const p = plan(raw, URL_LOOKUP(), "https://evil.example/login");
    expect(p).toContain("idx_threats_malicious_url");
    expect(p).not.toMatch(/SCAN threats/);
  });

  it("correlateUrls results are unchanged (URL hit incl. NULL/divergent domain rows, domain fallback)", async () => {
    const raw = openThreats();
    const t = raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_url, malicious_domain, first_seen)
       VALUES (?, ?, 'phishing', ?, ?, ?)`,
    );
    t.run("taxii1", "taxii", "https://a.example/x", null, "2026-10-01 00:00:00"); // NULL domain
    t.run("us1", "urlscanio", "https://short.example/r", "landing.example", "2026-10-01 00:00:00"); // divergent
    t.run("d1", "phishtank", "https://b.example/other", "b.example", "2026-10-02 00:00:00");
    const env = { DB: d1FromSqlite(raw) } as unknown as Env;
    const out = await correlateUrls(env, [
      { url: "https://a.example/x", domain: "a.example", count: 1 },
      { url: "https://short.example/r", domain: "short.example", count: 1 },
      { url: "https://b.example/new", domain: "b.example", count: 1 },
      { url: "https://none.example/", domain: "none.example", count: 1 },
    ]);
    expect(out.map((c) => c.threat_id)).toEqual(["taxii1", "us1", "d1"]);
  });
});

// Regression: Strategist auto-paused on 2026-10-02 with
//   D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
//
// D1 caps a LIKE/GLOB pattern at 50 bytes (probed against prod 2026-10-21:
// 50 bytes runs, 51 raises the error). The registrar dedup probe was
// `attack_pattern LIKE '%"registrar":"<name>"%'` — 16 bytes of framing — so any
// registrar over 34 bytes ("NICENIC INTERNATIONAL GROUP CO., LIMITED" = 40,
// "Vantage of Convergence (Chengdu) Technology Co., Ltd." = 53, both in the
// prod top-10) threw, uncaught, and failed every run until the breaker paused
// the agent.
//
// node:sqlite ships the stock 50,000-byte limit and no setLimit(), so these
// tests override the built-in `like()` with one that enforces D1's 50-byte cap
// (same error text) and otherwise implements LIKE's semantics. Every LIKE the
// agent issues — literal or bound — goes through it.

import { describe, it, expect, beforeEach } from "vitest";
import { strategistAgent, loadCampaignIdsByKey, asciiLower } from "../src/agents/strategist";
import {
  hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqliteTimestampHoursAgo,
  type SqliteDb, type StatementLogEntry,
} from "./sqlite-d1-harness";

const D1_LIKE_PATTERN_LIMIT = 50;

/** Override SQLite's like(pattern, value) with D1's 50-byte pattern cap. */
function enforceD1LikeLimit(raw: SqliteDb): void {
  const fn = (raw as unknown as {
    function(name: string, opts: { deterministic: boolean }, f: (p: unknown, v: unknown) => number | null): void;
  }).function.bind(raw);
  fn("like", { deterministic: true }, (pattern, value) => {
    if (pattern === null || value === null) return null;
    const p = String(pattern);
    if (Buffer.byteLength(p, "utf8") > D1_LIKE_PATTERN_LIMIT) {
      throw new Error("LIKE or GLOB pattern too complex");
    }
    const re = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]");
    return new RegExp(`^${re}$`, "i").test(String(value)) ? 1 : 0;
  });
}

const TABLES = ["campaigns", "threats", "brands", "hosting_providers"];
const LONG_REGISTRAR = "NICENIC INTERNATIONAL GROUP CO., LIMITED"; // 40 bytes, prod value
const LONGER_REGISTRAR = "Vantage of Convergence (Chengdu) Technology Co., Ltd."; // 53 bytes, prod value

describe.skipIf(!hasSqlite())("strategist — no data-derived LIKE over D1's 50-byte pattern cap", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];

  const addCampaign = (id: string, name: string, attackPattern: string | null) =>
    raw.prepare(
      `INSERT INTO campaigns (id, name, threat_count, attack_pattern, status) VALUES (?, ?, 0, ?, 'active')`,
    ).run(id, name, attackPattern);

  let threatSeq = 0;
  const addThreat = (over: { ip_address?: string | null; registrar?: string | null; malicious_domain?: string }) =>
    raw.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, ip_address, registrar, status, severity, created_at)
       VALUES (?, 'test_feed', 'phishing', ?, ?, ?, 'active', 'medium', ?)`,
    ).run(
      `t${++threatSeq}`,
      over.malicious_domain ?? `d${threatSeq}.example`,
      over.ip_address ?? null,
      over.registrar ?? null,
      sqliteTimestampHoursAgo(2),
    );

  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    enforceD1LikeLimit(raw);
    log = [];
    threatSeq = 0;
  });

  it("the emulated cap matches D1: 50 bytes runs, 51 throws, and the OLD registrar probe throws", () => {
    const q = raw.prepare("SELECT 'x' LIKE ? AS m");
    expect(() => q.all(`%${"a".repeat(48)}%`)).not.toThrow();
    expect(() => q.all(`%${"a".repeat(49)}%`)).toThrow(/LIKE or GLOB pattern too complex/);
    // The exact pre-fix probe for the prod registrar — proves the test would
    // have caught the 2026-10-02 failure.
    expect(() => q.all(`%"registrar":"${LONG_REGISTRAR}"%`)).toThrow(/LIKE or GLOB pattern too complex/);
  });

  describe("loadCampaignIdsByKey", () => {
    beforeEach(() => {
      addCampaign("c-nicenic", "Registrar-cluster-NICENIC", JSON.stringify({ type: "shared_registrar", registrar: LONG_REGISTRAR }));
      addCampaign("c-vantage", "Vantage", JSON.stringify({ type: "shared_registrar", registrar: LONGER_REGISTRAR }));
      addCampaign("c-gname-full", "Gname full", JSON.stringify({ type: "shared_registrar", registrar: "Gname.com Pte. Ltd." }));
      addCampaign("c-ip-11", "IP 11.2.3.45", JSON.stringify({ type: "shared_ip", ip: "11.2.3.45" }));
      addCampaign("c-ip-dup-1", "first", JSON.stringify({ type: "shared_ip", ip: "9.9.9.9" }));
      addCampaign("c-ip-dup-2", "second", JSON.stringify({ type: "shared_ip", ip: "9.9.9.9" }));
      addCampaign("c-quote", "quote", JSON.stringify({ type: "shared_registrar", registrar: 'Acme "Domains" Ltd' }));
      // Prod holds exactly this kind of row: a hand-seeded non-JSON attack_pattern.
      addCampaign("iran-irgc-retaliation-2026", "IRGC", "credential_harvesting,wiper,ddos,defacement,vishing");
      addCampaign("c-null", "null pattern", null);
    });

    const db = () => d1FromSqlite(raw, { log });

    it("resolves registrars far longer than the 50-byte cap, exactly", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_registrar", [LONG_REGISTRAR, LONGER_REGISTRAR]);
      expect(m.get(asciiLower(LONG_REGISTRAR))).toBe("c-nicenic");
      expect(m.get(asciiLower(LONGER_REGISTRAR))).toBe("c-vantage");
      expect(log.every((e) => e.error === undefined)).toBe(true);
    });

    it("a registrar longer than any pattern cap (2 KB) is a clean miss, not an error", async () => {
      const huge = "X".repeat(2048);
      const m = await loadCampaignIdsByKey(db(), "shared_registrar", [huge]);
      expect(m.size).toBe(0);
    });

    it("is exact: a prefix registrar does not collide with a longer one", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_registrar", ["Gname"]);
      expect(m.size).toBe(0);
    });

    it("is exact for IPs: 1.2.3.4 does not match the 11.2.3.45 campaign (old substring LIKE did)", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_ip", ["1.2.3.4", "11.2.3.45"]);
      expect(m.has("1.2.3.4")).toBe(false);
      expect(m.get("11.2.3.45")).toBe("c-ip-11");
    });

    it("keeps LIKE's ASCII case-insensitivity", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_registrar", [LONG_REGISTRAR.toLowerCase()]);
      expect(m.get(asciiLower(LONG_REGISTRAR))).toBe("c-nicenic");
    });

    it("matches JSON-escaped values the old LIKE probe missed", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_registrar", ['Acme "Domains" Ltd']);
      expect(m.get(asciiLower('Acme "Domains" Ltd'))).toBe("c-quote");
    });

    it("never crosses types: an IP key does not match a registrar campaign", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_ip", [LONG_REGISTRAR]);
      expect(m.size).toBe(0);
    });

    it("on duplicate keys the lowest rowid wins (old unordered .first() over a scan)", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_ip", ["9.9.9.9"]);
      expect(m.get("9.9.9.9")).toBe("c-ip-dup-1");
    });

    it("skips non-JSON attack_pattern rows instead of throwing", async () => {
      await expect(loadCampaignIdsByKey(db(), "shared_registrar", ["wiper"])).resolves.toBeInstanceOf(Map);
    });

    it("issues no query when there are no keys", async () => {
      const m = await loadCampaignIdsByKey(db(), "shared_ip", []);
      expect(m.size).toBe(0);
      expect(log).toHaveLength(0);
    });
  });

  describe("full run (execute) over real SQLite with the D1 cap", () => {
    // Tables the run touches outside the unit under test (budget, notifications, users).
    const swallowAbsent = (_sql: string, e: Error) => /no such table/.test(e.message);

    async function run() {
      const env = {
        DB: d1FromSqlite(raw, { swallow: swallowAbsent, log }),
        CACHE: fakeKv(),
        AI_MODE: "rules_only",
      } as never;
      return strategistAgent.execute({ env, runId: "strat-run", agentName: "strategist", input: {}, triggeredBy: null });
    }

    it("reuses the existing campaign for a 40- and 53-byte registrar and finishes the run", async () => {
      addCampaign("c-nicenic", "NICENIC net", JSON.stringify({ type: "shared_registrar", registrar: LONG_REGISTRAR }));
      addCampaign("iran-irgc-retaliation-2026", "IRGC", "credential_harvesting,wiper,ddos,defacement,vishing");
      for (let i = 0; i < 5; i++) addThreat({ registrar: LONG_REGISTRAR });
      for (let i = 0; i < 5; i++) addThreat({ registrar: LONGER_REGISTRAR });
      for (let i = 0; i < 3; i++) addThreat({ ip_address: "203.0.113.7" });

      const result = await run();

      // Nothing the agent issued tripped the cap (or anything else).
      const errors = log.filter((e) => e.error && !e.swallowed);
      expect(errors).toEqual([]);
      expect(result.output.clusterErrors).toBe(0);
      expect(result.output.registrarClusters).toBe(2);
      expect(result.output.ipClusters).toBe(1);

      // NICENIC reused (no duplicate), Vantage + the IP created fresh.
      const reg = raw.prepare(
        `SELECT id, json_extract(attack_pattern, '$.registrar') AS r FROM campaigns
          WHERE json_valid(attack_pattern) AND json_extract(attack_pattern, '$.type') = 'shared_registrar'
          ORDER BY r`,
      ).all() as Array<{ id: string; r: string }>;
      expect(reg.map((x) => x.r)).toEqual([LONG_REGISTRAR, LONGER_REGISTRAR]);
      expect(reg.find((x) => x.r === LONG_REGISTRAR)!.id).toBe("c-nicenic");

      const linked = raw.prepare(
        `SELECT registrar, campaign_id FROM threats WHERE registrar = ?`,
      ).all(LONG_REGISTRAR) as Array<{ campaign_id: string | null }>;
      expect(linked.every((t) => t.campaign_id === "c-nicenic")).toBe(true);

      const unlinked = raw.prepare(`SELECT COUNT(*) AS n FROM threats WHERE campaign_id IS NULL`).all() as Array<{ n: number }>;
      expect(unlinked[0]!.n).toBe(0);
      expect(result.itemsUpdated).toBeGreaterThanOrEqual(1);
      expect(result.itemsCreated).toBe(2);
    });

    it("no statement binds a LIKE pattern from data", async () => {
      for (let i = 0; i < 5; i++) addThreat({ registrar: LONGER_REGISTRAR });
      await run();
      const strategistLikes = log.filter((e) => /\bLIKE\s+\?/i.test(e.sql) && /campaigns/i.test(e.sql));
      expect(strategistLikes).toEqual([]);
    });
  });
});

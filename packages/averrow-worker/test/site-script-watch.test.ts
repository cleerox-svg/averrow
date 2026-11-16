/**
 * Site Script Watch PR1 — pure diff logic, the threats IOC match and the
 * 0337 schema. The SQL tests run on a DB built by applying EVERY migration
 * (openMigratedDb), so the new tables, the threats columns and the indexes
 * the lookup relies on are the real ones.
 */

import { describe, it, expect } from "vitest";
import {
  SITE_SCRIPT_MATCH_CHUNK,
  SITE_SCRIPT_PATH_MAX,
  diffSiteScan,
  isFirstPartyHost,
  isSharedScriptHost,
  matchHostsAgainstThreats,
  normaliseScriptUrl,
  threatLookupKeys,
  threatMatchSql,
  type InventoryRow,
} from "../src/lib/site-script-watch";
import { hasSqlite, openMigratedDb, d1FromSqlite, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("normaliseScriptUrl", () => {
  it("lowercases the host, strips a trailing dot and the port", () => {
    expect(normaliseScriptUrl("https://CDN.Acme.COM.:8443/js/App.js")).toEqual({
      host: "cdn.acme.com",
      path_norm: "/js/App.js",
    });
  });

  it("drops the query string and fragment (cache-busters)", () => {
    expect(normaliseScriptUrl("https://acme.com/app.js?v=123&t=9#frag")).toEqual({ host: "acme.com", path_norm: "/app.js" });
  });

  it("resolves relative and protocol-relative srcs against the page URL", () => {
    expect(normaliseScriptUrl("/static/main.js?x=1", "https://www.acme.com/shop")).toEqual({
      host: "www.acme.com",
      path_norm: "/static/main.js",
    });
    expect(normaliseScriptUrl("//cdn.jsdelivr.net/npm/x.js", "https://acme.com/")).toEqual({
      host: "cdn.jsdelivr.net",
      path_norm: "/npm/x.js",
    });
  });

  it("rejects non-http(s) and unparseable input", () => {
    for (const bad of [
      "data:text/javascript,alert(1)",
      "javascript:alert(1)",
      "blob:https://acme.com/uuid",
      "ftp://acme.com/x.js",
      "not a url",
      "",
      "   ",
    ]) {
      expect(normaliseScriptUrl(bad), bad).toBeNull();
    }
    // A relative src with no base is not absolute.
    expect(normaliseScriptUrl("/app.js")).toBeNull();
  });

  it("truncates very long paths", () => {
    const n = normaliseScriptUrl(`https://acme.com/${"x".repeat(5000)}.js`);
    expect(n?.path_norm.length).toBe(SITE_SCRIPT_PATH_MAX);
  });
});

describe("isFirstPartyHost", () => {
  it("matches the canonical domain and its subdomains", () => {
    expect(isFirstPartyHost("acme.com", "acme.com")).toBe(true);
    expect(isFirstPartyHost("static.cdn.acme.com", "acme.com")).toBe(true);
    expect(isFirstPartyHost("ACME.com.", "acme.com")).toBe(true);
  });

  it("ignores a leading www. on the canonical domain", () => {
    expect(isFirstPartyHost("cdn.acme.com", "www.acme.com")).toBe(true);
  });

  it("does not match lookalikes or suffix collisions", () => {
    expect(isFirstPartyHost("notacme.com", "acme.com")).toBe(false);
    expect(isFirstPartyHost("acme.com.evil.net", "acme.com")).toBe(false);
    expect(isFirstPartyHost("acme-cdn.com", "acme.com")).toBe(false);
  });

  it("only matches exactly when the canonical domain is shared hosting", () => {
    expect(isFirstPartyHost("acme.myshopify.com", "acme.myshopify.com")).toBe(true);
    expect(isFirstPartyHost("evil.acme.github.io", "acme.github.io")).toBe(false);
    expect(isFirstPartyHost("someshop.myshopify.com", "myshopify.com")).toBe(false);
  });
});

describe("diffSiteScan", () => {
  const opts = { canonicalDomain: "acme.com", pageUrl: "https://www.acme.com/" };
  const inventory: InventoryRow[] = [
    { script_host: "www.acme.com", path_norm: "/app.js", last_sha256: SHA_A },
    { script_host: "widgets.vendor.io", path_norm: "/w.js", last_sha256: SHA_A },
  ];

  it("baseline (first-ever) scan inventories everything and produces no findings", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js?v=1", sha256: SHA_A },
        { url: "https://widgets.vendor.io/w.js", sha256: SHA_A },
        { url: "https://evil-skimmer.ru/s.js", sha256: SHA_B },
        { url: "https://cdn.jsdelivr.net/npm/lib.js", sha256: SHA_A },
        { url: "data:text/javascript,1", sha256: null },
      ],
      [],
      opts,
    );
    expect(d.baseline).toBe(true);
    expect(d.findings).toEqual([]);
    expect(d.rejected).toBe(1);
    expect(d.observed.map((o) => [o.host, o.path_norm, o.is_first_party, o.shared])).toEqual([
      ["www.acme.com", "/app.js", true, false],
      ["widgets.vendor.io", "/w.js", false, false],
      ["evil-skimmer.ru", "/s.js", false, false],
      ["cdn.jsdelivr.net", "/npm/lib.js", false, true],
    ]);
  });

  it("an explicit baseline flag wins over a non-empty inventory", () => {
    const d = diffSiteScan([{ url: "https://evil-skimmer.ru/s.js", sha256: SHA_B }], inventory, { ...opts, baseline: true });
    expect(d.findings).toEqual([]);
  });

  it("raises new_host once per never-seen external host", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js", sha256: SHA_A },
        { url: "https://evil-skimmer.ru/s.js?cb=1", sha256: SHA_B },
        { url: "https://evil-skimmer.ru/t.js", sha256: SHA_B },
      ],
      inventory,
      opts,
    );
    expect(d.baseline).toBe(false);
    expect(d.findings).toEqual([
      {
        kind: "new_host",
        host: "evil-skimmer.ru",
        path_norm: "/s.js",
        evidence: { url: "https://evil-skimmer.ru/s.js?cb=1", sha256: SHA_B },
      },
    ]);
  });

  it("does not raise new_host for new first-party hosts or new paths on known hosts", () => {
    const d = diffSiteScan(
      [
        { url: "https://static.acme.com/new.js", sha256: SHA_A },
        { url: "https://widgets.vendor.io/other.js", sha256: SHA_B },
      ],
      inventory,
      opts,
    );
    expect(d.findings).toEqual([]);
  });

  it("raises body_changed for the same host + path with a different hash (first- and third-party)", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js?v=2", sha256: SHA_B },
        { url: "https://widgets.vendor.io/w.js", sha256: SHA_B },
      ],
      inventory,
      opts,
    );
    expect(d.findings.map((f) => [f.kind, f.host, f.path_norm, f.evidence.prev_sha256, f.evidence.sha256])).toEqual([
      ["body_changed", "www.acme.com", "/app.js", SHA_A, SHA_B],
      ["body_changed", "widgets.vendor.io", "/w.js", SHA_A, SHA_B],
    ]);
  });

  it("does not raise body_changed when either hash is unknown or the hash is unchanged", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js", sha256: SHA_A },
        { url: "https://widgets.vendor.io/w.js", sha256: null },
      ],
      inventory,
      opts,
    );
    expect(d.findings).toEqual([]);
    const unknownPrev = diffSiteScan(
      [{ url: "/app.js", sha256: SHA_B }],
      [{ script_host: "www.acme.com", path_norm: "/app.js", last_sha256: null }],
      opts,
    );
    expect(unknownPrev.findings).toEqual([]);
  });

  it("CDN and shared-hosting hosts are inventoried but never raise new_host", () => {
    const d = diffSiteScan(
      [
        { url: "https://cdn.jsdelivr.net/npm/lib.js", sha256: SHA_A },
        { url: "https://cdnjs.cloudflare.com/ajax/libs/x.js", sha256: SHA_A },
        { url: "https://d111111abcdef8.cloudfront.net/x.js", sha256: SHA_A },
        { url: "https://someone.github.io/x.js", sha256: SHA_A },
      ],
      inventory,
      opts,
    );
    expect(d.findings).toEqual([]);
    expect(d.observed).toHaveLength(4);
    expect(d.observed.every((o) => o.shared)).toBe(true);
  });

  it("CDN scripts still raise body_changed once inventoried", () => {
    const d = diffSiteScan(
      [{ url: "https://cdn.jsdelivr.net/npm/lib.js", sha256: SHA_B }],
      [...inventory, { script_host: "cdn.jsdelivr.net", path_norm: "/npm/lib.js", last_sha256: SHA_A }],
      opts,
    );
    expect(d.findings.map((f) => f.kind)).toEqual(["body_changed"]);
  });

  it("de-duplicates cache-buster variants of the same script, keeping the first known hash", () => {
    const d = diffSiteScan(
      [
        { url: "/app.js?v=1", sha256: null },
        { url: "/app.js?v=2", sha256: SHA_A },
        { url: "/app.js?v=3", sha256: SHA_B },
      ],
      [],
      opts,
    );
    expect(d.observed).toHaveLength(1);
    expect(d.observed[0]!.sha256).toBe(SHA_A);
  });
});

describe("threatLookupKeys", () => {
  it("expands a host to its parents down to the registrable domain", () => {
    expect(threatLookupKeys("a.b.evil.com")).toEqual(["a.b.evil.com", "b.evil.com", "evil.com"]);
    expect(threatLookupKeys("cdn.evil.co.uk")).toEqual(["cdn.evil.co.uk", "evil.co.uk"]);
  });

  it("never goes above the registrable domain", () => {
    expect(threatLookupKeys("evil.com")).toEqual(["evil.com"]);
  });

  it("matches shared-hosting tenants exactly and never looks up the provider or a CDN", () => {
    expect(isSharedScriptHost("acme-pay.github.io")).toBe(true);
    expect(threatLookupKeys("acme-pay.github.io")).toEqual(["acme-pay.github.io"]);
    expect(threatLookupKeys("cdn.jsdelivr.net")).toEqual([]);
    expect(threatLookupKeys("github.io")).toEqual([]);
  });

  it("keeps an IP host as an exact key", () => {
    expect(threatLookupKeys("203.0.113.7")).toEqual(["203.0.113.7"]);
  });
});

describe("threatMatchSql", () => {
  it("binds every value and filters active threats on malicious_domain", () => {
    expect(threatMatchSql(3)).toBe(
      "SELECT malicious_domain AS matched_value, MIN(id) AS threat_id FROM threats " +
        "WHERE malicious_domain IN (?, ?, ?) AND +status = 'active' GROUP BY malicious_domain",
    );
  });
});

describe.skipIf(!hasSqlite())("migration 0337 + matchHostsAgainstThreats (all migrations applied)", () => {
  function seedThreat(raw: SqliteDb, id: string, cols: { malicious_domain?: string; ioc_value?: string; status?: string }): void {
    raw
      .prepare(
        "INSERT INTO threats (id, source_feed, threat_type, malicious_domain, ioc_value, status) VALUES (?, 'test', 'phishing', ?, ?, ?)",
      )
      .run(id, cols.malicious_domain ?? null, cols.ioc_value ?? null, cols.status ?? "active");
  }

  it("creates the four tables with the expected columns and constraints", () => {
    const raw = openMigratedDb();
    const cols = (t: string): string[] =>
      (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols("site_scans")).toEqual([
      "id", "brand_id", "url", "status", "scanned_at", "scripts_count", "hosts_count", "error", "capture_ref",
    ]);
    expect(cols("site_script_inventory")).toEqual([
      "brand_id", "script_host", "path_norm", "is_first_party", "first_seen", "last_seen", "last_sha256", "prev_sha256", "change_count",
    ]);
    expect(cols("site_contacted_hosts")).toEqual(["brand_id", "host", "first_seen", "last_seen", "request_count"]);
    expect(cols("site_script_findings")).toEqual([
      "id", "brand_id", "scan_id", "kind", "host", "path_norm", "threat_id", "evidence_json", "created_at", "status",
    ]);

    // kind CHECK
    expect(() =>
      raw.prepare("INSERT INTO site_script_findings (id, brand_id, scan_id, kind, host) VALUES ('f1','b','s','bogus','h')").run(),
    ).toThrow(/CHECK/);
    raw.prepare("INSERT INTO site_script_findings (id, brand_id, scan_id, kind, host) VALUES ('f2','b','s','ioc_match','h')").run();
    expect((raw.prepare("SELECT status FROM site_script_findings WHERE id = 'f2'").all() as Array<{ status: string }>)[0]!.status).toBe("open");

    // UNIQUE keys support ON CONFLICT upserts.
    const up = raw.prepare(
      "INSERT INTO site_script_inventory (brand_id, script_host, path_norm, last_sha256) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (brand_id, script_host, path_norm) DO UPDATE SET prev_sha256 = last_sha256, last_sha256 = excluded.last_sha256, change_count = change_count + 1",
    );
    up.run("b", "acme.com", "/app.js", SHA_A);
    up.run("b", "acme.com", "/app.js", SHA_B);
    expect(raw.prepare("SELECT last_sha256, prev_sha256, change_count FROM site_script_inventory").all()).toEqual([
      { last_sha256: SHA_B, prev_sha256: SHA_A, change_count: 1 },
    ]);
    const hostUp = raw.prepare(
      "INSERT INTO site_contacted_hosts (brand_id, host, request_count) VALUES (?, ?, 1) " +
        "ON CONFLICT (brand_id, host) DO UPDATE SET request_count = request_count + 1",
    );
    hostUp.run("b", "x.com");
    hostUp.run("b", "x.com");
    expect(raw.prepare("SELECT request_count FROM site_contacted_hosts").all()).toEqual([{ request_count: 2 }]);
  });

  it("matches exact hosts and parent domains on malicious_domain, active only", async () => {
    const raw = openMigratedDb();
    seedThreat(raw, "t-exact", { malicious_domain: "skimmer.evil.com" });
    seedThreat(raw, "t-parent", { malicious_domain: "evil.com" });
    seedThreat(raw, "t-pay", { malicious_domain: "pay-cdn.net" });
    // ioc_value is not probed (no index on threats.ioc_value) — see threatMatchSql.
    seedThreat(raw, "t-ioc-only", { ioc_value: "ioc-only.example" });
    seedThreat(raw, "t-down", { malicious_domain: "dead.example", status: "down" });
    seedThreat(raw, "t-cdn", { malicious_domain: "cdn.jsdelivr.net" });
    seedThreat(raw, "t-z", { malicious_domain: "evil.com" });
    const log: StatementLogEntry[] = [];
    const db = d1FromSqlite(raw, { log });

    const matches = await matchHostsAgainstThreats(db, [
      "Skimmer.Evil.com.",
      "static.pay-cdn.net",
      "dead.example",
      "cdn.jsdelivr.net",
      "clean.example",
      "ioc-only.example",
    ]);
    const view = matches.map((m) => [m.host, m.matched_value, m.match_kind, m.threat_id].join("|")).sort();
    expect(view).toEqual([
      "skimmer.evil.com|evil.com|parent|t-parent",
      "skimmer.evil.com|skimmer.evil.com|exact|t-exact",
      "static.pay-cdn.net|pay-cdn.net|parent|t-pay",
    ]);

    // Every value is bound — no host text inside the SQL.
    for (const e of log) {
      expect(e.error).toBeUndefined();
      expect(e.sql).not.toMatch(/evil|pay-cdn|example/);
    }
  });

  it("chunks lookup keys at ≤ 90 binds per statement and seeks idx_threats_domain", async () => {
    const raw = openMigratedDb();
    const hosts = Array.from({ length: 200 }, (_, i) => `h${i}.example.org`);
    seedThreat(raw, "t-150", { malicious_domain: "h150.example.org" });
    seedThreat(raw, "t-7", { malicious_domain: "h7.example.org" });
    const log: StatementLogEntry[] = [];
    const db = d1FromSqlite(raw, { log });

    const matches = await matchHostsAgainstThreats(db, hosts);
    expect(matches.map((m) => m.threat_id).sort()).toEqual(["t-150", "t-7"]);

    // 200 hosts + the shared parent example.org = 201 keys → 90 / 90 / 21.
    expect(log.map((e) => e.binds!.length)).toEqual([90, 90, 21]);
    for (const e of log) {
      expect(e.binds!.length).toBeLessThanOrEqual(SITE_SCRIPT_MATCH_CHUNK);
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...e.binds!) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" / ");
      // Seek idx_threats_domain for the bound values — never
      // idx_threats_status_created (walks every active threat) or a scan.
      expect(plan).toMatch(/SEARCH threats USING (COVERING )?INDEX idx_threats_domain \(/);
      expect(plan).not.toMatch(/idx_threats_status|SCAN threats/);
    }
  });

  it("issues no query when there is nothing to look up", async () => {
    const raw = openMigratedDb();
    const log: StatementLogEntry[] = [];
    expect(await matchHostsAgainstThreats(d1FromSqlite(raw, { log }), ["cdn.jsdelivr.net", "", "github.io"])).toEqual([]);
    expect(log).toHaveLength(0);
  });
});

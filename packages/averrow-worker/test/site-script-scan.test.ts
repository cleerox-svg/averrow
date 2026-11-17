/**
 * Site Script Watch PR2 — the scanner pipeline (lib/site-script-scan.ts),
 * the agent wrapper (agents/siteScriptWatch.ts) and the browser driver's
 * pure helpers, against the real migrated schema (openMigratedDb) and a
 * FAKE scan driver (no browser is launched).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../src/types";
import {
  SITE_SCAN_MIN_BUDGET_MS,
  SITE_SCRIPT_SWEEP_STAMP_PREFIX,
  SITE_SCRIPT_TICK_WINDOW_MS,
  claimScan,
  maybeDailySiteScriptSweep,
  pickDueBrand,
  reapStuckScans,
  runSiteScriptWatch,
  scannableCanonicalHost,
  siteScriptTickBudgetMs,
  type RawSiteScan,
  type SiteScanDriver,
} from "../src/lib/site-script-scan";
import { asScriptTags, scriptInitiatorUrl } from "../src/lib/site-script-browser";
import { siteScriptWatchAgent } from "../src/agents/siteScriptWatch";
import { d1Ts } from "../src/lib/page-capture";
import { d1FromSqlite, fakeKv, hasSqlite, openMigratedDb, type SqliteDb } from "./sqlite-d1-harness";

const PUBLIC_IP = "93.184.216.34";
const resolveHost = async (host: string): Promise<string[]> => (host.startsWith("private-") ? ["10.0.0.7"] : [PUBLIC_IP]);
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const T0 = new Date("2026-11-17T12:00:00Z");
const hoursLater = (h: number): Date => new Date(T0.getTime() + h * 3_600_000);

function setup(opts: { browser?: boolean } = {}) {
  const raw = openMigratedDb();
  const db = d1FromSqlite(raw);
  (db as unknown as { withSession: () => D1Database }).withSession = () => db;
  const cache = fakeKv();
  const env = { DB: db, CACHE: cache, ...(opts.browser === false ? {} : { BROWSER: {} }) } as unknown as Env;
  return { raw, db, env, cache };
}

function addBrand(raw: SqliteDb, id: string, domain: string, o: { tier?: string; source?: string } = {}): void {
  raw
    .prepare("INSERT INTO brands (id, name, canonical_domain, tier, source) VALUES (?, ?, ?, ?, ?)")
    .run(id, id, domain, o.tier ?? "customer", o.source ?? "manual");
}

function addThreat(raw: SqliteDb, id: string, o: { domain?: string; url?: string; feed?: string; status?: string }): void {
  raw
    .prepare("INSERT INTO threats (id, source_feed, threat_type, malicious_domain, malicious_url, status) VALUES (?, ?, 'phishing', ?, ?, ?)")
    .run(id, o.feed ?? "urlhaus", o.domain ?? null, o.url ?? null, o.status ?? "active");
}

function scan(o: Partial<RawSiteScan> = {}): RawSiteScan {
  return {
    finalUrl: "https://acme.com/",
    httpStatus: 200,
    scripts: [],
    requests: [],
    blockedNavigation: null,
    hostCapHit: false,
    requestsDropped: 0,
    bodiesHashed: 0,
    bodiesSkipped: 0,
    inlineCut: 0,
    ...o,
  };
}

function fakeDriver(next: () => RawSiteScan | Promise<RawSiteScan>) {
  const seen: string[] = [];
  let closed = 0;
  const driver: SiteScanDriver = {
    async open() {
      return {
        scan: async (req) => {
          seen.push(req.targetUrl);
          return next();
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  return { driver, seen, closed: () => closed };
}

const BASE_SCRIPTS = [
  { url: "https://acme.com/app.js", sha256: SHA_A, integrity: "sha384-abc" },
  { url: "https://www.googletagmanager.com/gtm.js?id=GTM-1", sha256: null, integrity: null },
  { url: "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js", sha256: null, integrity: null },
];
const BASE_REQUESTS = [
  { url: "https://acme.com/app.js" },
  { url: "https://www.googletagmanager.com/gtm.js?id=GTM-1" },
  { url: "https://www.google-analytics.com/g/collect?v=2", initiator_url: "https://www.googletagmanager.com/gtm.js?id=GTM-1" },
];

function rows<T>(raw: SqliteDb, sql: string, ...p: unknown[]): T[] {
  return raw.prepare(sql).all(...p) as T[];
}

describe("pure helpers", () => {
  it("siteScriptTickBudgetMs measures what is left of the tick window", () => {
    expect(siteScriptTickBudgetMs(0, 0)).toBe(SITE_SCRIPT_TICK_WINDOW_MS);
    expect(siteScriptTickBudgetMs(0, 60_000)).toBe(SITE_SCRIPT_TICK_WINDOW_MS - 60_000);
    // Clock skew (now before scheduledTime) never inflates the budget.
    expect(siteScriptTickBudgetMs(60_000, 0)).toBe(SITE_SCRIPT_TICK_WINDOW_MS);
    expect(siteScriptTickBudgetMs(0, SITE_SCRIPT_TICK_WINDOW_MS - SITE_SCAN_MIN_BUDGET_MS + 1)).toBeLessThan(SITE_SCAN_MIN_BUDGET_MS);
  });

  it("scannableCanonicalHost refuses shared hosting, IPs and garbage", () => {
    expect(scannableCanonicalHost("Acme.com")).toBe("acme.com");
    expect(scannableCanonicalHost("www.acme.com")).toBe("acme.com");
    expect(scannableCanonicalHost("bücher.de")).toBe("xn--bcher-kva.de");
    expect(scannableCanonicalHost("acme.github.io")).toBeNull();
    expect(scannableCanonicalHost("acme.myshopify.com")).toBeNull();
    expect(scannableCanonicalHost("10.0.0.1")).toBeNull();
    expect(scannableCanonicalHost("localhost")).toBeNull();
    expect(scannableCanonicalHost("acme .com")).toBeNull();
  });

  it("scriptInitiatorUrl reads the first http(s) call frame of a script initiator only", () => {
    expect(scriptInitiatorUrl({ type: "parser", url: "https://acme.com/" })).toBeNull();
    expect(scriptInitiatorUrl({ type: "script", stack: { callFrames: [{ url: "" }, { url: "https://evil.example/s.js" }] } })).toBe(
      "https://evil.example/s.js",
    );
    expect(scriptInitiatorUrl({ type: "script", stack: { callFrames: [], parent: { callFrames: [{ url: "https://x.example/a.js" }] } } })).toBe(
      "https://x.example/a.js",
    );
    expect(scriptInitiatorUrl({ type: "script", stack: { callFrames: [{ url: "javascript:void(0)" }] } })).toBeNull();
    expect(scriptInitiatorUrl(null)).toBeNull();
  });

  it("asScriptTags validates the in-page result as untrusted data", () => {
    expect(asScriptTags("nope")).toEqual([]);
    expect(asScriptTags([{ src: "https://a/x.js", type: 5, integrity: null, text: null, cut: "yes" }, null])).toEqual([
      { src: "https://a/x.js", type: null, integrity: null, text: null, cut: false },
      { src: null, type: null, integrity: null, text: null, cut: false },
    ]);
  });
});

describe.skipIf(!hasSqlite())("site script watch pipeline (real SQLite)", () => {
  it("no BROWSER binding → clean no-op (nothing claimed, nothing written)", async () => {
    const { raw, env } = setup({ browser: false });
    addBrand(raw, "b_acme", "acme.com");
    const stats = await runSiteScriptWatch(env, { now: () => T0 });
    expect(stats.skipped).toBe("bindings_absent:BROWSER");
    expect(rows(raw, "SELECT * FROM site_scans")).toEqual([]);
  });

  it("picks one due customer brand: trusted, not shared hosting, never-scanned first, then oldest scan", async () => {
    const { raw, db } = setup();
    addBrand(raw, "b_recent", "recent.com");
    addBrand(raw, "b_old", "old.com");
    addBrand(raw, "b_never", "never.com");
    addBrand(raw, "b_shared", "acme.github.io");
    addBrand(raw, "b_untrusted", "untrusted.com", { source: "self_service" });
    addBrand(raw, "b_monitored", "monitored.com", { tier: "monitored" });
    const ins = raw.prepare("INSERT INTO site_scans (id, brand_id, url, status, scanned_at) VALUES (?, ?, 'u', 'complete', ?)");
    ins.run("s1", "b_recent", d1Ts(hoursLater(-2)));
    ins.run("s2", "b_old", d1Ts(hoursLater(-8)));

    expect((await pickDueBrand(db, T0))?.id).toBe("b_never");
    ins.run("s3", "b_never", d1Ts(T0));
    expect((await pickDueBrand(db, T0))?.id).toBe("b_old");
    ins.run("s4", "b_old", d1Ts(T0));
    expect(await pickDueBrand(db, T0)).toBeNull();
  });

  it("claimScan is guarded: a second claim inside the interval is refused", async () => {
    const { raw, db } = setup();
    addBrand(raw, "b_acme", "acme.com");
    expect(await claimScan(db, "ssc_1", "b_acme", "https://acme.com/", T0)).toBe(true);
    expect(await claimScan(db, "ssc_2", "b_acme", "https://acme.com/", hoursLater(1))).toBe(false);
    expect(await claimScan(db, "ssc_3", "b_acme", "https://acme.com/", hoursLater(7))).toBe(true);
  });

  it("baseline scan: builds inventory + contacted hosts, no diff findings; the next scan diffs", async () => {
    const { raw, env } = setup();
    addBrand(raw, "b_acme", "acme.com");
    let next = scan({ scripts: BASE_SCRIPTS, requests: BASE_REQUESTS });
    const fd = fakeDriver(() => next);

    const s1 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => T0, resolve: resolveHost });
    expect(fd.seen).toEqual(["https://acme.com/"]);
    expect(fd.closed()).toBe(1);
    expect(s1).toMatchObject({ scan_status: "complete", baseline: true, scripts: 3, findings_found: 0, findings_inserted: 0 });
    expect(rows(raw, "SELECT status, scripts_count, hosts_count FROM site_scans")).toEqual([
      { status: "complete", scripts_count: 3, hosts_count: 2 },
    ]);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM site_script_inventory")).toEqual([{ n: 3 }]);
    expect(rows(raw, "SELECT host FROM site_contacted_hosts ORDER BY host").map((r) => (r as { host: string }).host)).toEqual([
      "acme.com",
      "www.google-analytics.com",
      "www.googletagmanager.com",
    ]);

    // Not due again inside 6 h.
    const early = await runSiteScriptWatch(env, { driver: fd.driver, now: () => hoursLater(1), resolve: resolveHost });
    expect(early.skipped).toBe("no_due_brand");

    // Second scan: a new third-party script host and a new exfil endpoint.
    next = scan({
      scripts: [...BASE_SCRIPTS, { url: "https://skim.example/x.js", sha256: SHA_B, integrity: null }],
      requests: [
        ...BASE_REQUESTS,
        { url: "https://skim.example/x.js" },
        { url: "https://exfil.example/collect", initiator_url: "https://skim.example/x.js" },
      ],
    });
    const s2 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => hoursLater(7), resolve: resolveHost });
    expect(s2).toMatchObject({ scan_status: "complete", baseline: false, findings_inserted: 2 });
    expect(s2.by_kind).toEqual({ new_host: 1, new_contacted_host: 1 });
    const f = rows<{ kind: string; host: string; evidence_json: string }>(
      raw,
      "SELECT kind, host, evidence_json FROM site_script_findings ORDER BY kind",
    );
    // The script host is new_host only — never also new_contacted_host.
    expect(f.map((x) => [x.kind, x.host])).toEqual([
      ["new_contacted_host", "exfil.example"],
      ["new_host", "skim.example"],
    ]);
    expect(JSON.parse(f[0]!.evidence_json).initiator_url).toBe("https://skim.example/x.js");
    expect(rows(raw, "SELECT initiator_host, initiator_path FROM site_contacted_hosts WHERE host = 'exfil.example'")).toEqual([
      { initiator_host: "skim.example", initiator_path: "/x.js" },
    ]);
  });

  it("body_changed + sri_removed update the inventory (prev hash kept, integrity cleared)", async () => {
    const { raw, env } = setup();
    addBrand(raw, "b_acme", "acme.com");
    let next = scan({ scripts: BASE_SCRIPTS, requests: BASE_REQUESTS });
    const fd = fakeDriver(() => next);
    await runSiteScriptWatch(env, { driver: fd.driver, now: () => T0, resolve: resolveHost });

    next = scan({
      scripts: [{ url: "https://acme.com/app.js", sha256: SHA_B, integrity: null }, ...BASE_SCRIPTS.slice(1)],
      requests: BASE_REQUESTS,
    });
    const s2 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => hoursLater(7), resolve: resolveHost });
    expect(s2.by_kind).toEqual({ body_changed: 1, sri_removed: 1 });
    expect(
      rows(raw, "SELECT last_sha256, prev_sha256, integrity, change_count FROM site_script_inventory WHERE path_norm = '/app.js'"),
    ).toEqual([{ last_sha256: SHA_B, prev_sha256: SHA_A, integrity: null, change_count: 1 }]);
  });

  it("ioc_match from a script host and from a contacted host (also on a baseline); open findings dedupe", async () => {
    const { raw, env } = setup();
    addBrand(raw, "b_acme", "acme.com");
    addThreat(raw, "t_script", { domain: "evil-cdn.example", feed: "urlhaus" });
    addThreat(raw, "t_exfil", { domain: "drop.example", feed: "threatfox" });
    addThreat(raw, "t_inactive", { domain: "old.example", status: "remediated" });
    const next = scan({
      scripts: [...BASE_SCRIPTS, { url: "https://evil-cdn.example/lib.js", sha256: SHA_B, integrity: null }],
      requests: [
        ...BASE_REQUESTS,
        { url: "https://evil-cdn.example/lib.js" },
        { url: "https://api.drop.example/c", initiator_url: "https://evil-cdn.example/lib.js" },
        { url: "https://old.example/p" },
      ],
    });
    const fd = fakeDriver(() => next);

    const s1 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => T0, resolve: resolveHost });
    expect(s1).toMatchObject({ baseline: true, ioc_matches: 2, findings_inserted: 2 });
    const f = rows<{ kind: string; host: string; threat_id: string; evidence_json: string; scan_id: string }>(
      raw,
      "SELECT kind, host, threat_id, evidence_json, scan_id FROM site_script_findings ORDER BY host",
    );
    expect(f.map((x) => [x.kind, x.host, x.threat_id])).toEqual([
      ["ioc_match", "api.drop.example", "t_exfil"],
      ["ioc_match", "evil-cdn.example", "t_script"],
    ]);
    const exfil = JSON.parse(f[0]!.evidence_json);
    expect(exfil).toMatchObject({
      matched_value: "drop.example",
      match_kind: "parent",
      matched_on: "contacted_host",
      source_feed: "threatfox",
      url: "https://api.drop.example/c",
      initiator_url: "https://evil-cdn.example/lib.js",
    });
    expect(JSON.parse(f[1]!.evidence_json)).toMatchObject({
      matched_value: "evil-cdn.example",
      match_kind: "exact",
      matched_on: "script_host",
      source_feed: "urlhaus",
      url: "https://evil-cdn.example/lib.js",
    });

    // Next scan sees the same IOCs: found again, but the open findings dedupe.
    const s2 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => hoursLater(7), resolve: resolveHost });
    expect(s2).toMatchObject({ baseline: false, ioc_matches: 2, findings_inserted: 0 });
    expect(rows(raw, "SELECT COUNT(*) AS n FROM site_script_findings")).toEqual([{ n: 2 }]);

    // Once closed, the same key opens a NEW row.
    raw.prepare("UPDATE site_script_findings SET status = 'resolved' WHERE threat_id = 't_script'").run();
    const s3 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => hoursLater(14), resolve: resolveHost });
    expect(s3.findings_inserted).toBe(1);
    expect(rows(raw, "SELECT status FROM site_script_findings WHERE threat_id = 't_script' ORDER BY status")).toEqual([
      { status: "open" },
      { status: "resolved" },
    ]);
  });

  it("ioc_match on a script URL (malicious_url) even for a first-party script", async () => {
    const { raw, env } = setup();
    addBrand(raw, "b_acme", "acme.com");
    addThreat(raw, "t_url", { url: "https://acme.com/app.js", feed: "phishtank" });
    const fd = fakeDriver(() => scan({ scripts: BASE_SCRIPTS.map((s) => ({ ...s, url: `${s.url}${s.url.includes("?") ? "&" : "?"}v=9` })), requests: BASE_REQUESTS }));
    const s = await runSiteScriptWatch(env, { driver: fd.driver, now: () => T0, resolve: resolveHost });
    expect(s.ioc_matches).toBe(1);
    const f = rows<{ host: string; path_norm: string; evidence_json: string }>(raw, "SELECT host, path_norm, evidence_json FROM site_script_findings");
    expect(f[0]!.host).toBe("acme.com");
    expect(f[0]!.path_norm).toBe("/app.js");
    expect(JSON.parse(f[0]!.evidence_json)).toMatchObject({ match_kind: "url", matched_on: "script_url", source_feed: "phishtank" });
  });

  it("an implausibly small scan is `skipped`: nothing else is written", async () => {
    const { raw, env } = setup();
    addBrand(raw, "b_acme", "acme.com");
    const many = Array.from({ length: 5 }, (_, i) => ({ url: `https://acme.com/s${i}.js`, sha256: SHA_A, integrity: null }));
    let next = scan({ scripts: many, requests: BASE_REQUESTS });
    const fd = fakeDriver(() => next);
    await runSiteScriptWatch(env, { driver: fd.driver, now: () => T0, resolve: resolveHost });
    const invBefore = rows(raw, "SELECT * FROM site_script_inventory ORDER BY path_norm");
    const hostsBefore = rows(raw, "SELECT * FROM site_contacted_hosts ORDER BY host");

    next = scan({ scripts: [], requests: [{ url: "https://wall.example/challenge" }] });
    const s2 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => hoursLater(7), resolve: resolveHost });
    expect(s2.scan_status).toBe("skipped");
    expect(rows(raw, "SELECT status, scripts_count, error FROM site_scans ORDER BY scanned_at")).toEqual([
      { status: "complete", scripts_count: 5, error: null },
      { status: "skipped", scripts_count: 0, error: "0 scripts; previous complete scan had 5" },
    ]);
    expect(rows(raw, "SELECT * FROM site_script_inventory ORDER BY path_norm")).toEqual(invBefore);
    expect(rows(raw, "SELECT * FROM site_contacted_hosts ORDER BY host")).toEqual(hostsBefore);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM site_script_findings")).toEqual([{ n: 0 }]);

    // A skipped scan is not history: the next real scan still diffs (not baseline).
    next = scan({ scripts: many, requests: BASE_REQUESTS });
    const s3 = await runSiteScriptWatch(env, { driver: fd.driver, now: () => hoursLater(14), resolve: resolveHost });
    expect(s3).toMatchObject({ scan_status: "complete", baseline: false, findings_found: 0 });
  });

  it("a failed render marks the scan failed; a refused target is never rendered", async () => {
    const { raw, env } = setup();
    addBrand(raw, "b_acme", "acme.com");
    const boom = fakeDriver(() => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    });
    const s = await runSiteScriptWatch(env, { driver: boom.driver, now: () => T0, resolve: resolveHost });
    expect(s.scan_status).toBe("failed");
    expect(rows(raw, "SELECT status, error FROM site_scans")).toEqual([{ status: "failed", error: "net::ERR_NAME_NOT_RESOLVED" }]);

    const { raw: raw2, env: env2 } = setup();
    addBrand(raw2, "b_priv", "private-acme.com");
    const fd = fakeDriver(() => scan());
    const s2 = await runSiteScriptWatch(env2, { driver: fd.driver, now: () => T0, resolve: resolveHost });
    expect(s2.scan_status).toBe("failed");
    expect(fd.seen).toEqual([]);
    expect((rows<{ error: string }>(raw2, "SELECT error FROM site_scans")[0]!).error).toMatch(/^refused target:/);
  });

  it("no budget → skipped before any claim", async () => {
    const { raw, env } = setup();
    addBrand(raw, "b_acme", "acme.com");
    const fd = fakeDriver(() => scan());
    const s = await runSiteScriptWatch(env, { driver: fd.driver, now: () => T0, resolve: resolveHost, budgetMs: SITE_SCAN_MIN_BUDGET_MS - 1 });
    expect(s.skipped).toBe("budget");
    expect(fd.seen).toEqual([]);
    expect(rows(raw, "SELECT * FROM site_scans")).toEqual([]);
  });

  it("reaps a `running` scan a dead worker left behind", async () => {
    const { raw, db } = setup();
    raw.prepare("INSERT INTO site_scans (id, brand_id, url, status, scanned_at) VALUES ('old', 'b', 'u', 'running', ?)").run(d1Ts(hoursLater(-1)));
    raw.prepare("INSERT INTO site_scans (id, brand_id, url, status, scanned_at) VALUES ('new', 'b', 'u', 'running', ?)").run(d1Ts(T0));
    expect(await reapStuckScans(db, T0)).toBe(1);
    expect(rows(raw, "SELECT id, status FROM site_scans ORDER BY id")).toEqual([
      { id: "new", status: "running" },
      { id: "old", status: "failed" },
    ]);
  });

  it("retention sweep: hour 0 only, once a day (KV stamp), keeps each brand's latest complete scan and open findings", async () => {
    const { raw, env, cache } = setup();
    const old = d1Ts(new Date(T0.getTime() - 100 * 86_400_000));
    const older = d1Ts(new Date(T0.getTime() - 120 * 86_400_000));
    const veryOld = d1Ts(new Date(T0.getTime() - 200 * 86_400_000));
    const recent = d1Ts(T0);
    const scanIns = raw.prepare("INSERT INTO site_scans (id, brand_id, url, status, scanned_at) VALUES (?, ?, 'u', ?, ?)");
    scanIns.run("a_latest_complete", "b_a", "complete", old); // brand a: only old scans — latest complete kept
    scanIns.run("a_older_complete", "b_a", "complete", older);
    scanIns.run("a_old_failed", "b_a", "failed", old);
    scanIns.run("b_old_complete", "b_b", "complete", old); // brand b: has a recent complete
    scanIns.run("b_recent_complete", "b_b", "complete", recent);
    raw.prepare("INSERT INTO site_contacted_hosts (brand_id, host, last_seen) VALUES ('b_a', 'gone.example', ?), ('b_a', 'live.example', ?)").run(old, recent);
    raw.prepare("INSERT INTO site_script_inventory (brand_id, script_host, path_norm, last_seen) VALUES ('b_a', 'x', '/gone.js', ?), ('b_a', 'x', '/live.js', ?)").run(old, recent);
    const fIns = raw.prepare("INSERT INTO site_script_findings (id, brand_id, scan_id, kind, host, dedupe_key, created_at, status) VALUES (?, 'b_a', 's', 'new_host', 'h', ?, ?, ?)");
    fIns.run("f_closed_old", "k1", veryOld, "resolved");
    fIns.run("f_open_old", "k2", veryOld, "open");
    fIns.run("f_closed_recent", "k3", recent, "dismissed");

    const notMidnight = await maybeDailySiteScriptSweep(env, new Date("2026-11-17T05:10:00Z"));
    expect(notMidnight.ran).toBe(false);
    expect(rows(raw, "SELECT COUNT(*) AS n FROM site_scans")).toEqual([{ n: 5 }]);

    const midnight = new Date("2026-11-17T00:10:00Z");
    const r = await maybeDailySiteScriptSweep(env, midnight);
    expect(r).toEqual({ ran: true, scans: 3, contacted: 1, findings: 1, inventory: 1 });
    expect(cache.store.has(`${SITE_SCRIPT_SWEEP_STAMP_PREFIX}2026-11-17`)).toBe(true);
    expect(rows(raw, "SELECT id FROM site_scans ORDER BY id").map((x) => (x as { id: string }).id)).toEqual([
      "a_latest_complete",
      "b_recent_complete",
    ]);
    expect(rows(raw, "SELECT host FROM site_contacted_hosts")).toEqual([{ host: "live.example" }]);
    expect(rows(raw, "SELECT path_norm FROM site_script_inventory")).toEqual([{ path_norm: "/live.js" }]);
    expect(rows(raw, "SELECT id FROM site_script_findings ORDER BY id").map((x) => (x as { id: string }).id)).toEqual([
      "f_closed_recent",
      "f_open_old",
    ]);

    // Second hour-0 tick the same day: stamped → no-op.
    expect((await maybeDailySiteScriptSweep(env, new Date("2026-11-17T00:20:00Z"))).ran).toBe(false);
  });

  it("agent wrapper: no-op without BROWSER, still writes the telemetry event", async () => {
    const { raw, env } = setup({ browser: false });
    const res = await siteScriptWatchAgent.execute({ env, runId: "run_1", agentName: "site_script_watch", input: {}, triggeredBy: "test" });
    expect(res.itemsProcessed).toBe(0);
    expect((res.output as { skipped: string }).skipped).toBe("bindings_absent:BROWSER");
    const ev = rows<{ event_type: string; source_agent: string; target_agent: string | null; payload_json: string }>(
      raw,
      "SELECT event_type, source_agent, target_agent, payload_json FROM agent_events",
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_type: "site_scripts_scanned", source_agent: "site_script_watch", target_agent: null });
    expect(JSON.parse(ev[0]!.payload_json)).toMatchObject({ run_id: "run_1", skipped: "bindings_absent:BROWSER" });
  });

  it("the agent is registered, active, AI-free and schedule-owned", async () => {
    const { agentModules } = await import("../src/agents/index");
    const { SCHEDULE_OWNED_AGENTS } = await import("../src/agents/flightControl");
    expect(agentModules["site_script_watch"]).toBe(siteScriptWatchAgent);
    expect(siteScriptWatchAgent).toMatchObject({ status: "active", trigger: "scheduled", budget: { monthlyTokenCap: 0 } });
    expect(SCHEDULE_OWNED_AGENTS.has("site_script_watch")).toBe(true);
  });
});

describe("cron-audit: no minute gate in the site-script path", () => {
  const src = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  it("no minute arithmetic anywhere in the scan code", () => {
    for (const f of ["../src/lib/site-script-scan.ts", "../src/lib/site-script-browser.ts", "../src/agents/siteScriptWatch.ts"]) {
      expect(src(f)).not.toMatch(/getUTCMinutes|getMinutes|minute\s*===/);
    }
  });
});

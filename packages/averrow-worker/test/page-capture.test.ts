// Phishing page capture (docs/PHISH_PAGE_CAPTURE_SPEC_2026-10.md):
// queue / claim / reaper / capture / store / sweep / evidence-link logic in
// lib/page-capture.ts, the staff routes in handlers/pageCaptures.ts, and the
// sandbox-CSP preservation in middleware/security.ts.
//
// Runs the real SQL against an in-memory SQLite whose schema is derived from
// migrations/ (and whose page_captures indexes — incl. the partial unique
// "one open row per threat" index — are replayed from migration 0290), so a
// wrong column, a bind-arity mismatch or a broken guard fails here. No
// browser is ever launched: the capture driver is an injected fake.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb, type StatementLogEntry } from "./sqlite-d1-harness";
import { splitStatements } from "./migration-schema";
import {
  CAPTURE_HTML_MAX_BYTES,
  CAPTURE_MAX_ATTEMPTS,
  CAPTURE_RUN_BUDGET_MS,
  CaptureRefusedError,
  SWEEP_STAMP_PREFIX,
  captureTargetUrl,
  claimCaptures,
  d1Ts,
  detectAntiBotWall,
  enqueueAutoCaptures,
  enqueueManualCapture,
  failCapture,
  formActionHosts,
  linkCaptureEvidence,
  maybeDailySweep,
  reapStuckCaptures,
  runPageCapture,
  sweepExpiredCaptures,
  type CaptureDriver,
  type CaptureRequest,
  type RawCapture,
} from "../src/lib/page-capture";
import { registerThreatRoutes } from "../src/routes/threats";
import { applySecurityHeaders } from "../src/middleware/security";
import { signJWT } from "../src/lib/jwt";
import { pageCaptureAgent } from "../src/agents/pageCapture";
import { bulkInsertThreats, insertThreat as feedInsertThreat } from "../src/lib/feedRunner";
import type { ThreatRow } from "../src/feeds/types";
import type { Env, JWTPayload, UserRole } from "../src/types";

const TABLES = ["page_captures", "threats", "takedown_requests", "takedown_evidence", "brands"];
const MIGRATION = resolve(__dirname, "..", "migrations", "0290_page_captures.sql");
const NOW = new Date("2026-10-12T00:05:00Z");
const PNG_D = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_M = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
const PUBLIC_IP = "93.184.216.34";

function replayCaptureIndexes(db: SqliteDb): void {
  for (const stmt of splitStatements(readFileSync(MIGRATION, "utf8"))) {
    if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt)) db.exec(stmt);
  }
}

async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface FakeR2 {
  store: Map<string, { bytes: Uint8Array; contentType?: string; custom?: Record<string, string> }>;
  deleted: string[];
  bucket: R2Bucket;
}

function fakeR2(): FakeR2 {
  const store: FakeR2["store"] = new Map();
  const deleted: string[] = [];
  const toBytes = (v: unknown): Uint8Array =>
    typeof v === "string" ? new TextEncoder().encode(v) : (v as Uint8Array);
  const bucket = {
    put: async (key: string, value: unknown, opts?: R2PutOptions) => {
      const ct = opts?.httpMetadata && "contentType" in opts.httpMetadata ? opts.httpMetadata.contentType : undefined;
      store.set(key, { bytes: toBytes(value), contentType: ct, custom: opts?.customMetadata });
      return {};
    },
    get: async (key: string) => {
      const o = store.get(key);
      return o ? { body: new Response(o.bytes).body } : null;
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        deleted.push(k);
        store.delete(k);
      }
    },
  } as unknown as R2Bucket;
  return { store, deleted, bucket };
}

function raw(over: Partial<RawCapture> = {}): RawCapture {
  return {
    finalUrl: "https://acme-sso-login.com/signin",
    httpStatus: 200,
    redirectChain: ["https://acme-sso-login.com/", "https://acme-sso-login.com/signin"],
    title: "Sign in to Acme",
    formActions: ["https://collector.evil-kit.net/post.php", ""],
    bodyText: "Sign in with your Acme account",
    html: "<html><title>Sign in to Acme</title><form action=\"https://collector.evil-kit.net/post.php\"></form></html>",
    desktopPng: PNG_D,
    mobilePng: PNG_M,
    blockedNavigation: null,
    ...over,
  };
}

type Outcome = RawCapture | Error | ((req: CaptureRequest) => Promise<RawCapture>);

function fakeDriver(outcomes: Record<string, Outcome>, opts: { openFails?: boolean } = {}) {
  const calls: string[] = [];
  let opened = 0;
  let closed = 0;
  const driver: CaptureDriver = {
    async open() {
      opened++;
      if (opts.openFails) throw new Error("429 too many browsers");
      return {
        async capture(req) {
          calls.push(req.targetUrl);
          const o = outcomes[req.targetUrl] ?? raw();
          if (o instanceof Error) throw o;
          if (typeof o === "function") return o(req);
          return o;
        },
        async close() {
          closed++;
        },
      };
    },
  };
  return { driver, calls, counts: () => ({ opened, closed }) };
}

const resolveHost = async (host: string): Promise<string[]> => (host.startsWith("private-") ? ["10.0.0.7"] : [PUBLIC_IP]);

describe.skipIf(!hasSqlite())("page capture pipeline (real SQLite)", () => {
  let rawDb: SqliteDb;
  let log: StatementLogEntry[];
  let db: D1Database;
  let r2: FakeR2;
  let env: Env;

  const insertThreat = (id: string, opts: { technique?: string | null; url?: string | null; domain?: string; created?: string } = {}): void => {
    rawDb.prepare(
      `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, malicious_url, technique, status, created_at)
       VALUES (?, 'openphish', 'phishing', ?, ?, ?, 'active', ?)`,
    ).run(id, opts.domain ?? `${id}.example-phish.com`, opts.url === undefined ? `https://${id}.example-phish.com/login` : opts.url,
      opts.technique === undefined ? "idp_lookalike" : opts.technique, opts.created ?? d1Ts(NOW));
  };
  const rows = (sql: string, ...p: unknown[]): Array<Record<string, unknown>> =>
    rawDb.prepare(sql).all(...p) as Array<Record<string, unknown>>;
  const capRow = (id: string): Record<string, unknown> => rows(`SELECT * FROM page_captures WHERE id = ?`, id)[0]!;

  beforeEach(() => {
    rawDb = openDerivedDb(TABLES);
    replayCaptureIndexes(rawDb);
    log = [];
    db = d1FromSqlite(rawDb, { log });
    r2 = fakeR2();
    env = {
      DB: Object.assign(db, { withSession: () => db }),
      CACHE: fakeKv(),
      BROWSER: { fetch: async () => new Response("") } as unknown as Fetcher,
      PHISH_CAPTURES: r2.bucket,
    } as unknown as Env;
  });

  // ─── Enqueue ──────────────────────────────────────────────────────
  describe("enqueue", () => {
    it("auto-enqueue is idempotent: one row per threat, ever", async () => {
      const items = [{ threatId: "t1", maliciousUrl: "https://acme-okta.com/x" }];
      expect(await enqueueAutoCaptures(db, items, NOW)).toBe(1);
      expect(await enqueueAutoCaptures(db, items, NOW)).toBe(0);
      rawDb.exec(`UPDATE page_captures SET status = 'captured'`);
      // A re-pulled, already-captured threat is NOT re-queued automatically.
      expect(await enqueueAutoCaptures(db, items, NOW)).toBe(0);
      expect(rows(`SELECT COUNT(*) AS n FROM page_captures`)[0]!["n"]).toBe(1);
    });

    it("dedups within one call and skips items with no capturable URL", async () => {
      const n = await enqueueAutoCaptures(db, [
        { threatId: "t1", maliciousDomain: "acme-okta.com" },
        { threatId: "t1", maliciousDomain: "acme-okta.com" },
        { threatId: "t2", maliciousUrl: "javascript:alert(1)", maliciousDomain: null },
        { threatId: "t3", maliciousUrl: null, maliciousDomain: null },
      ], NOW);
      expect(n).toBe(1);
      expect(rows(`SELECT threat_id, target_url, status, attempts FROM page_captures`)).toEqual([
        { threat_id: "t1", target_url: "https://acme-okta.com/", status: "queued", attempts: 0 },
      ]);
    });

    it("manual enqueue: one OPEN row per threat; allowed again once settled", async () => {
      const first = await enqueueManualCapture(db, "t1", "https://acme-okta.com/", "u1", NOW);
      expect(first).toMatch(/^pc_/);
      expect(await enqueueManualCapture(db, "t1", "https://acme-okta.com/", "u2", NOW)).toBeNull();
      rawDb.exec(`UPDATE page_captures SET status = 'capturing'`);
      expect(await enqueueManualCapture(db, "t1", "https://acme-okta.com/", "u2", NOW)).toBeNull();
      rawDb.exec(`UPDATE page_captures SET status = 'captured'`);
      const again = await enqueueManualCapture(db, "t1", "https://acme-okta.com/", "u2", NOW);
      expect(again).toMatch(/^pc_/);
      expect(capRow(again!)["requested_by"]).toBe("u2");
    });

    it("the partial unique index forbids a second open row even on a raw insert", () => {
      rawDb.exec(`INSERT INTO page_captures (id, threat_id, target_url, status) VALUES ('a', 't1', 'https://x.com/', 'queued')`);
      expect(() => rawDb.exec(`INSERT INTO page_captures (id, threat_id, target_url, status) VALUES ('b', 't1', 'https://x.com/', 'capturing')`)).toThrow();
      // Settled rows don't count.
      rawDb.exec(`INSERT INTO page_captures (id, threat_id, target_url, status) VALUES ('c', 't1', 'https://x.com/', 'captured')`);
    });

    it("feed writers enqueue NEW IdP-family threats only — never non-family rows or re-pulled duplicates", async () => {
      const idpRow: ThreatRow = { id: "f_idp", source_feed: "openphish", threat_type: "phishing",
        malicious_url: "https://acme.okta-verify-login.com/signin", malicious_domain: "acme.okta-verify-login.com" };
      const plain: ThreatRow = { id: "f_plain", source_feed: "openphish", threat_type: "phishing",
        malicious_url: "https://example-shop-deals.com/", malicious_domain: "example-shop-deals.com" };
      await bulkInsertThreats(db, [idpRow, plain]);
      expect(rows(`SELECT technique FROM threats WHERE id = 'f_idp'`)[0]!["technique"]).toBeTruthy();
      expect(rows(`SELECT threat_id, target_url FROM page_captures`)).toEqual([
        { threat_id: "f_idp", target_url: "https://acme.okta-verify-login.com/signin" },
      ]);
      // Re-pull: INSERT OR IGNORE no-op → no enqueue statement at all.
      const before = log.filter((l) => l.sql.includes("INTO page_captures")).length;
      await bulkInsertThreats(db, [idpRow, plain]);
      await feedInsertThreat(db, idpRow);
      expect(log.filter((l) => l.sql.includes("INTO page_captures")).length).toBe(before);
      // Single-row path enqueues a new IdP row too.
      await feedInsertThreat(db, { ...idpRow, id: "f_idp2" });
      expect(rows(`SELECT COUNT(*) AS n FROM page_captures`)[0]!["n"]).toBe(2);
    });

    it("captureTargetUrl prefers an http(s) URL, else the domain", () => {
      expect(captureTargetUrl("https://a.com/login?x=1", "b.com")).toBe("https://a.com/login?x=1");
      expect(captureTargetUrl("ftp://a.com/", "b.com")).toBe("https://b.com/");
      expect(captureTargetUrl(null, "B.com.")).toBe("https://b.com/");
      expect(captureTargetUrl(null, "bad host/x")).toBeNull();
      expect(captureTargetUrl("not a url", null)).toBeNull();
    });
  });

  // ─── Claim / reaper / attempt cap ─────────────────────────────────
  describe("claim + reaper", () => {
    const seed = (id: string, threat: string, queuedAt: string, requestedBy: string | null = null, status = "queued", attempts = 0, claimedAt: string | null = null): void => {
      rawDb.prepare(
        `INSERT INTO page_captures (id, threat_id, target_url, status, attempts, requested_by, queued_at, claimed_at, created_at)
         VALUES (?, ?, 'https://x.example-phish.com/', ?, ?, ?, ?, ?, ?)`,
      ).run(id, threat, status, attempts, requestedBy, queuedAt, claimedAt, queuedAt);
    };

    it("claims manual requests first, then newest first, and stamps attempts + claimed_at", async () => {
      seed("old", "t1", "2026-10-11 10:00:00");
      seed("new", "t2", "2026-10-11 23:00:00");
      seed("mid", "t3", "2026-10-11 12:00:00");
      seed("manual", "t4", "2026-10-10 01:00:00", "u1");
      seed("done", "t5", "2026-10-11 23:30:00", null, "captured");
      const claimed = await claimCaptures(db, 3, NOW);
      expect(claimed.map((c) => c.id).sort()).toEqual(["manual", "mid", "new"].sort());
      for (const id of ["manual", "mid", "new"]) {
        expect(capRow(id)).toMatchObject({ status: "capturing", attempts: 1, claimed_at: d1Ts(NOW) });
      }
      expect(capRow("old")["status"]).toBe("queued");
      expect(await claimCaptures(db, 5, NOW)).toHaveLength(1); // only "old" left
      expect(await claimCaptures(db, 5, NOW)).toHaveLength(0);
    });

    it("reaper re-queues stuck rows, fails them at the attempt cap, and parks stale queue rows", async () => {
      const stuck = d1Ts(new Date(NOW.getTime() - 20 * 60_000));
      const fresh = d1Ts(new Date(NOW.getTime() - 2 * 60_000));
      seed("stuck1", "t1", stuck, null, "capturing", 1, stuck);
      seed("stuck3", "t2", stuck, null, "capturing", CAPTURE_MAX_ATTEMPTS, stuck);
      seed("running", "t3", fresh, null, "capturing", 1, fresh);
      seed("stale", "t4", "2026-10-01 00:00:00");
      seed("recent", "t5", fresh);
      const r = await reapStuckCaptures(db, NOW);
      expect(r).toEqual({ requeued: 1, failed: 1, stale: 1 });
      expect(capRow("stuck1")).toMatchObject({ status: "queued", claimed_at: null });
      expect(capRow("stuck3")).toMatchObject({ status: "failed" });
      expect(String(capRow("stuck3")["error"])).toMatch(/attempt cap/);
      expect(capRow("running")["status"]).toBe("capturing");
      expect(capRow("stale")["status"]).toBe("failed");
      expect(capRow("recent")["status"]).toBe("queued");
    });

    it("failCapture: retryable below the cap → queued; at the cap or a refusal → failed", async () => {
      seed("a", "t1", d1Ts(NOW), null, "capturing", 1, d1Ts(NOW));
      seed("b", "t2", d1Ts(NOW), null, "capturing", CAPTURE_MAX_ATTEMPTS, d1Ts(NOW));
      seed("c", "t3", d1Ts(NOW), null, "capturing", 1, d1Ts(NOW));
      expect(await failCapture(db, { id: "a", attempts: 1 }, "net::ERR", true)).toBe("queued");
      expect(await failCapture(db, { id: "b", attempts: CAPTURE_MAX_ATTEMPTS }, "net::ERR", true)).toBe("failed");
      expect(await failCapture(db, { id: "c", attempts: 1 }, "refused", false)).toBe("failed");
      expect(capRow("a")).toMatchObject({ status: "queued", error: "net::ERR" });
    });
  });

  // ─── Full run with a fake driver ──────────────────────────────────
  describe("runPageCapture", () => {
    it("is a clean no-op when the BROWSER / PHISH_CAPTURES bindings are absent", async () => {
      insertThreat("t1");
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousDomain: "acme-okta.com" }], NOW);
      const before = log.length;
      const fd = fakeDriver({});
      const stats = await runPageCapture({ ...env, BROWSER: undefined, PHISH_CAPTURES: undefined } as Env, { driver: fd.driver, now: () => NOW });
      expect(stats.skipped).toBe("bindings_absent:BROWSER,PHISH_CAPTURES");
      expect(fd.counts().opened).toBe(0);
      expect(log.length).toBe(before); // not a single statement
      const onlyBucket = await runPageCapture({ ...env, BROWSER: undefined } as Env, { driver: fd.driver, now: () => NOW });
      expect(onlyBucket.skipped).toBe("bindings_absent:BROWSER");
      expect(capRow(rows(`SELECT id FROM page_captures`)[0]!["id"] as string)["status"]).toBe("queued");
    });

    it("captures, stores hashed objects + meta.json, finalizes the row and links takedown evidence", async () => {
      insertThreat("t1");
      rawDb.exec(`INSERT INTO takedown_requests (id, brand_id, target_type, target_value, evidence_summary, source_type, source_id, status, created_at)
        VALUES ('td1', 'b1', 'domain', 'x', 'x', 'threat', 't1', 'draft', '2026-10-11 00:00:00'),
               ('td_alert', 'b1', 'domain', 'x', 'x', 'alert', 't1', 'draft', '2026-10-11 00:00:00')`);
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousUrl: "https://acme-sso-login.com/" }], NOW);
      const fd = fakeDriver({ "https://acme-sso-login.com/": raw() });

      const stats = await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
      expect(stats).toMatchObject({ claimed: 1, captured: 1, blocked: 0, failed: 0, evidence_linked: 1, skipped: null });
      expect(fd.counts()).toEqual({ opened: 1, closed: 1 });

      const row = rows(`SELECT * FROM page_captures`)[0]!;
      const id = String(row["id"]);
      const prefix = `captures/2026/10/${id}`;
      expect(row).toMatchObject({
        status: "captured",
        attempts: 1,
        final_url: "https://acme-sso-login.com/signin",
        http_status: 200,
        page_title: "Sign in to Acme",
        desktop_key: `${prefix}/desktop.png`,
        mobile_key: `${prefix}/mobile.png`,
        html_key: `${prefix}/page.html`,
        desktop_sha256: await sha(PNG_D),
        mobile_sha256: await sha(PNG_M),
        anti_bot_wall: null,
        error: null,
        captured_at: d1Ts(NOW),
        expires_at: "2027-04-10 00:05:00",
      });
      expect(JSON.parse(String(row["form_action_hosts_json"]))).toEqual(["collector.evil-kit.net", "acme-sso-login.com"]);
      expect(JSON.parse(String(row["redirect_chain_json"]))).toHaveLength(2);

      // Objects: bytes hash to what D1 recorded; customMetadata carries threat_id.
      expect([...r2.store.keys()].sort()).toEqual([`${prefix}/desktop.png`, `${prefix}/meta.json`, `${prefix}/mobile.png`, `${prefix}/page.html`]);
      const html = r2.store.get(`${prefix}/page.html`)!;
      expect(await sha(html.bytes)).toBe(row["html_sha256"]);
      expect(html.contentType).toBe("application/octet-stream");
      expect(r2.store.get(`${prefix}/desktop.png`)!.custom).toMatchObject({ threat_id: "t1", capture_id: id, sha256: await sha(PNG_D) });
      const meta = JSON.parse(new TextDecoder().decode(r2.store.get(`${prefix}/meta.json`)!.bytes)) as Record<string, unknown>;
      expect(meta).toMatchObject({ capture_id: id, threat_id: "t1", target_url: "https://acme-sso-login.com/", status: "captured" });
      expect((meta["objects"] as Record<string, { sha256: string }>)["desktop"]!.sha256).toBe(await sha(PNG_D));

      // Evidence: only the threat-sourced takedown, API path not a public URL.
      expect(rows(`SELECT takedown_id, evidence_type, storage_key, storage_url FROM takedown_evidence`)).toEqual([
        { takedown_id: "td1", evidence_type: "screenshot", storage_key: `${prefix}/desktop.png`, storage_url: `/api/intel/captures/${id}/screenshot?variant=desktop` },
      ]);
      expect(rows(`SELECT id, screenshot_url FROM takedown_requests ORDER BY id`)).toEqual([
        { id: "td1", screenshot_url: `/api/intel/captures/${id}/screenshot?variant=desktop` },
        { id: "td_alert", screenshot_url: null },
      ]);
    });

    it("evidence linking is idempotent and never overwrites an existing screenshot_url", async () => {
      rawDb.exec(`INSERT INTO takedown_requests (id, brand_id, target_type, target_value, evidence_summary, source_type, source_id, status, screenshot_url)
        VALUES ('td1', 'b1', 'domain', 'x', 'x', 'threat', 't1', 'draft', NULL),
               ('td2', 'b1', 'domain', 'x', 'x', 'threat', 't1', 'draft', '/existing.png')`);
      const stored = { status: "captured" as const, desktopKey: null, mobileKey: "k/mobile.png", desktopSha: null, mobileSha: "m", htmlSha: "h", finalUrl: null, antiBotWall: null };
      expect(await linkCaptureEvidence(db, "pc_x", "t1", stored, NOW)).toBe(2);
      expect(await linkCaptureEvidence(db, "pc_x", "t1", stored, NOW)).toBe(0);
      expect(rows(`SELECT id, screenshot_url FROM takedown_requests ORDER BY id`)).toEqual([
        { id: "td1", screenshot_url: "/api/intel/captures/pc_x/screenshot?variant=mobile" },
        { id: "td2", screenshot_url: "/existing.png" },
      ]);
      expect(await linkCaptureEvidence(db, "pc_y", null, stored, NOW)).toBe(0);
    });

    it("records an anti-bot wall as blocked but still stores the screenshot", async () => {
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousUrl: "https://acme-sso-login.com/" }], NOW);
      const fd = fakeDriver({ "https://acme-sso-login.com/": raw({ title: "Just a moment...", formActions: [] }) });
      const stats = await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
      expect(stats.blocked).toBe(1);
      const row = rows(`SELECT status, anti_bot_wall, desktop_key FROM page_captures`)[0]!;
      expect(row).toMatchObject({ status: "blocked", anti_bot_wall: "cf_challenge" });
      expect(row["desktop_key"]).toBeTruthy();
    });

    it("refuses private / loopback targets before the browser sees them (no retry)", async () => {
      await enqueueAutoCaptures(db, [
        { threatId: "t1", maliciousUrl: "https://private-kit.example-phish.com/" },
        { threatId: "t2", maliciousUrl: "http://127.0.0.1/admin" },
      ], NOW);
      const fd = fakeDriver({});
      const stats = await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
      expect(fd.calls).toEqual([]);
      expect(stats.failed).toBe(2);
      for (const r of rows(`SELECT status, error, attempts FROM page_captures`)) {
        expect(r["status"]).toBe("failed");
        expect(String(r["error"])).toMatch(/^refused target/);
        expect(r["attempts"]).toBe(1);
      }
      expect(r2.store.size).toBe(0);
    });

    it("a redirect hop the guard refused with nothing rendered fails without retry", async () => {
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousUrl: "https://acme-sso-login.com/" }], NOW);
      const fd = fakeDriver({
        "https://acme-sso-login.com/": async (req) => {
          const v = await req.guard("http://private-hop.example-phish.com/");
          expect(v.ok).toBe(false);
          return raw({ desktopPng: null, mobilePng: null, blockedNavigation: "private-hop" });
        },
      });
      await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
      expect(rows(`SELECT status, error FROM page_captures`)[0]).toMatchObject({ status: "failed" });
      expect(String(rows(`SELECT error FROM page_captures`)[0]!["error"])).toMatch(/refused navigation/);
    });

    it("transient errors re-queue until the attempt cap, then fail", async () => {
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousUrl: "https://acme-sso-login.com/" }], NOW);
      const fd = fakeDriver({ "https://acme-sso-login.com/": new Error("net::ERR_CONNECTION_RESET") });
      for (let i = 1; i <= CAPTURE_MAX_ATTEMPTS; i++) {
        await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
        const r = rows(`SELECT status, attempts FROM page_captures`)[0]!;
        expect(r["attempts"]).toBe(i);
        expect(r["status"]).toBe(i < CAPTURE_MAX_ATTEMPTS ? "queued" : "failed");
      }
      // Nothing left to claim — the driver is not even opened.
      await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
      expect(fd.counts().opened).toBe(CAPTURE_MAX_ATTEMPTS);
    });

    it("a capture that never returns is cut off by the hard per-page timeout", async () => {
      vi.useFakeTimers();
      try {
        await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousUrl: "https://acme-sso-login.com/" }], NOW);
        const fd = fakeDriver({ "https://acme-sso-login.com/": () => new Promise<RawCapture>(() => undefined) });
        const p = runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
        await vi.advanceTimersByTimeAsync(20_001);
        const stats = await p;
        expect(stats.requeued).toBe(1);
        expect(String(rows(`SELECT error FROM page_captures`)[0]!["error"])).toMatch(/timed out after 20000ms/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases claimed rows without spending an attempt when the browser session can't open", async () => {
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousDomain: "acme-okta.com" }], NOW);
      const fd = fakeDriver({}, { openFails: true });
      await expect(runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost })).rejects.toThrow(/browser session unavailable/);
      expect(rows(`SELECT status, attempts, claimed_at FROM page_captures`)[0]).toEqual({ status: "queued", attempts: 0, claimed_at: null });
    });

    it("releases the rest of the batch when the run budget is spent", async () => {
      await enqueueAutoCaptures(db, [1, 2, 3].map((i) => ({ threatId: `t${i}`, maliciousUrl: `https://kit${i}.example-phish.com/` })), NOW);
      let t = NOW.getTime();
      const fd = fakeDriver({});
      const stats = await runPageCapture(env, {
        driver: fd.driver,
        resolve: resolveHost,
        // Each clock read after the first jumps past the budget.
        now: () => { const d = new Date(t); t += CAPTURE_RUN_BUDGET_MS; return d; },
      });
      expect(fd.calls).toHaveLength(0);
      expect(stats.released).toBe(3);
      expect(rows(`SELECT DISTINCT status, attempts FROM page_captures`)).toEqual([{ status: "queued", attempts: 0 }]);
    });

    it("caps stored HTML at 2 MB", async () => {
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousUrl: "https://acme-sso-login.com/" }], NOW);
      const fd = fakeDriver({ "https://acme-sso-login.com/": raw({ html: "a".repeat(CAPTURE_HTML_MAX_BYTES + 10) }) });
      await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
      expect(rows(`SELECT html_bytes FROM page_captures`)[0]!["html_bytes"]).toBe(CAPTURE_HTML_MAX_BYTES);
    });

    it("the agent emits a telemetry agent_events row (target_agent NULL) and no-ops cleanly without bindings", async () => {
      const events: unknown[][] = [];
      const fakeDb = {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => { if (sql.includes("INSERT INTO agent_events")) events.push([sql, ...args]); return { meta: { changes: 1 } }; },
          }),
        }),
      };
      const res = await pageCaptureAgent.execute({
        env: { DB: fakeDb, CACHE: fakeKv() } as unknown as Env,
        runId: "run-1", agentName: "page_capture", input: {}, triggeredBy: "cron",
      });
      expect(res.itemsProcessed).toBe(0);
      expect(res.output["skipped"]).toBe("bindings_absent:BROWSER,PHISH_CAPTURES");
      expect(events).toHaveLength(1);
      const [sql, , payload] = events[0] as [string, string, string];
      expect(sql).toMatch(/'pages_captured', 'page_capture', NULL/);
      expect(JSON.parse(payload)).toMatchObject({ run_id: "run-1", skipped: "bindings_absent:BROWSER,PHISH_CAPTURES" });
    });
  });

  // ─── Retention sweep ──────────────────────────────────────────────
  describe("retention sweep", () => {
    const seedStored = (id: string, status: string, expiresAt: string): void => {
      rawDb.prepare(
        `INSERT INTO page_captures (id, threat_id, target_url, status, desktop_key, mobile_key, html_key, desktop_sha256, expires_at)
         VALUES (?, 't', 'https://x.com/', ?, ?, ?, ?, 'd', ?)`,
      ).run(id, status, `captures/2026/04/${id}/desktop.png`, `captures/2026/04/${id}/mobile.png`, `captures/2026/04/${id}/page.html`, expiresAt);
    };

    it("expires past-due rows: keys nulled, hashes kept, objects (incl. meta.json) deleted", async () => {
      seedStored("old", "captured", "2026-10-11 00:00:00");
      seedStored("oldblk", "blocked", "2026-10-11 00:00:00");
      seedStored("live", "captured", "2027-01-01 00:00:00");
      const r = await sweepExpiredCaptures(db, r2.bucket, NOW);
      expect(r).toMatchObject({ expired: 2, objectsDeleted: 8 });
      expect(capRow("old")).toMatchObject({ status: "expired", desktop_key: null, mobile_key: null, html_key: null, desktop_sha256: "d" });
      expect(capRow("live")).toMatchObject({ status: "captured" });
      expect(r2.deleted).toContain("captures/2026/04/old/meta.json");
      // The sweep's SELECT is an index range, not a walk of every stored row.
      const plan = rawDb.prepare(`EXPLAIN QUERY PLAN SELECT id FROM page_captures WHERE status IN ('captured', 'blocked') AND expires_at < ? LIMIT 90`).all(d1Ts(NOW))
        .map((x) => String((x as { detail: string }).detail)).join(" | ");
      expect(plan).toMatch(/USING INDEX idx_page_captures_status_expiry \(status=\? AND expires_at<\?\)/);
    });

    it("runs only in UTC hour 0, once per day (KV stamp) — no minute gate", async () => {
      seedStored("old", "captured", "2026-10-11 00:00:00");
      const kv = fakeKv();
      const e = { DB: db, CACHE: kv, PHISH_CAPTURES: r2.bucket };
      expect((await maybeDailySweep(e, new Date("2026-10-12T01:00:00Z"))).ran).toBe(false);
      expect(capRow("old")["status"]).toBe("captured");
      expect((await maybeDailySweep(e, new Date("2026-10-12T00:40:00Z"))).ran).toBe(true);
      expect(kv.store.has(`${SWEEP_STAMP_PREFIX}2026-10-12`)).toBe(true);
      expect((await maybeDailySweep(e, new Date("2026-10-12T00:50:00Z"))).ran).toBe(false);
      expect(capRow("old")["status"]).toBe("expired");
    });
  });

  // ─── Routes: auth + response headers ──────────────────────────────
  describe("routes", () => {
    const SECRET = "test-secret-page-capture";
    let audits: unknown[][];

    const stubStmt = (row: Record<string, unknown>) => {
      const s = {
        bind: () => s,
        first: async () => row,
        all: async () => ({ results: [row] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
      return s;
    };
    const routeEnv = (): Env => {
      audits = [];
      const wrapped = {
        prepare: (sql: string) => (/\busers\b/.test(sql) ? stubStmt({ status: "active" }) : db.prepare(sql)),
        batch: (s: D1PreparedStatement[]) => db.batch(s),
        withSession: () => wrapped,
      };
      return {
        ...env,
        JWT_SECRET: SECRET,
        DB: wrapped,
        AUDIT_DB: { prepare: () => ({ bind: (...a: unknown[]) => ({ run: async () => { audits.push(a); return {}; } }) }) },
      } as unknown as Env;
    };
    const bearer = async (role: UserRole, sub = `u-${role}`): Promise<string> => {
      const payload: Omit<JWTPayload, "iat" | "exp"> = { sub, email: `${role}@averrow.com`, role };
      return `Bearer ${await signJWT(payload, SECRET, 300)}`;
    };
    const call = async (e: Env, method: string, path: string, auth?: string): Promise<Response> => {
      const router = Router();
      registerThreatRoutes(router);
      const headers: Record<string, string> = auth ? { Authorization: auth } : {};
      const res = (await router.fetch(new Request(`https://averrow.com${path}`, { method, headers }), e)) as Response | undefined;
      if (!res) throw new Error(`no route for ${method} ${path}`);
      return res;
    };

    async function seedStoredCapture(): Promise<string> {
      insertThreat("t1");
      await enqueueAutoCaptures(db, [{ threatId: "t1", maliciousUrl: "https://acme-sso-login.com/" }], NOW);
      const fd = fakeDriver({ "https://acme-sso-login.com/": raw({ mobilePng: null }) });
      await runPageCapture(env, { driver: fd.driver, now: () => NOW, resolve: resolveHost });
      return String(rows(`SELECT id FROM page_captures`)[0]!["id"]);
    }

    it("screenshot: staff only; PNG with private cache + nosniff; variant validated", async () => {
      const id = await seedStoredCapture();
      const e = routeEnv();
      const path = `/api/intel/captures/${id}/screenshot?variant=desktop`;
      expect((await call(e, "GET", path)).status).toBe(401);
      expect((await call(e, "GET", path, await bearer("client"))).status).toBe(403);
      const ok = await call(e, "GET", path, await bearer("auditor"));
      expect(ok.status).toBe(200);
      expect(ok.headers.get("Content-Type")).toBe("image/png");
      expect(ok.headers.get("Cache-Control")).toBe("private, max-age=3600");
      expect(ok.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG_D);
      // Mobile not stored → 404; unknown variant → 400; malformed id → 404.
      expect((await call(e, "GET", `/api/intel/captures/${id}/screenshot?variant=mobile`, await bearer("analyst"))).status).toBe(404);
      expect((await call(e, "GET", `/api/intel/captures/${id}/screenshot?variant=html`, await bearer("analyst"))).status).toBe(400);
      expect((await call(e, "GET", `/api/intel/captures/..%2Fx/screenshot`, await bearer("analyst"))).status).toBe(404);
    });

    it("html: download-only attachment, never text/html, sandbox CSP + nosniff (survives the security-header pass)", async () => {
      const id = await seedStoredCapture();
      const e = routeEnv();
      const path = `/api/intel/captures/${id}/html`;
      expect((await call(e, "GET", path)).status).toBe(401);
      expect((await call(e, "GET", path, await bearer("client"))).status).toBe(403);
      const res = applySecurityHeaders(await call(e, "GET", path, await bearer("analyst")), path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(res.headers.get("Content-Type")).not.toMatch(/html/);
      expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="capture-${id}.html.txt"`);
      expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await res.text()).toContain("<form");
    });

    it("routes 503 when the bucket binding is absent", async () => {
      const e = { ...routeEnv(), PHISH_CAPTURES: undefined } as Env;
      const res = await call(e, "GET", `/api/intel/captures/pc_00000000-0000-0000-0000-000000000000/html`, await bearer("analyst"));
      expect(res.status).toBe(503);
    });

    it("POST capture: edit_alerts only, audited, 409 while open, 404 for non-IdP threats", async () => {
      insertThreat("t1");
      insertThreat("t_plain", { technique: null });
      const e = routeEnv();
      const path = "/api/intel/identity-threats/detections/t1/capture";
      expect((await call(e, "POST", path)).status).toBe(401);
      for (const role of ["client", "auditor", "sales", "billing"] as const) {
        expect((await call(e, "POST", path, await bearer(role))).status).toBe(403);
      }
      const ok = await call(e, "POST", path, await bearer("analyst"));
      expect(ok.status).toBe(202);
      const body = await ok.json() as { success: boolean; data: { id: string; status: string } };
      expect(body.data.status).toBe("queued");
      expect(capRow(body.data.id)).toMatchObject({ threat_id: "t1", requested_by: "u-analyst", status: "queued" });
      expect(audits.map((a) => a[2])).toEqual(["page_capture_requested"]);

      expect((await call(e, "POST", path, await bearer("support"))).status).toBe(409);
      expect((await call(e, "POST", "/api/intel/identity-threats/detections/t_plain/capture", await bearer("analyst"))).status).toBe(404);
      expect((await call(e, "POST", "/api/intel/identity-threats/detections/nope/capture", await bearer("analyst"))).status).toBe(404);
    });

    it("POST capture: 20/hour per-user rate limit", async () => {
      insertThreat("t1");
      const e = routeEnv();
      const windowKey = Math.floor(Date.now() / 3_600_000);
      await e.CACHE.put(`rl:page_capture:u-analyst:${windowKey}`, "20");
      const res = await call(e, "POST", "/api/intel/identity-threats/detections/t1/capture", await bearer("analyst"));
      expect(res.status).toBe(429);
      expect(rows(`SELECT COUNT(*) AS n FROM page_captures`)[0]!["n"]).toBe(0);
    });
  });
});

// ─── Pure helpers ──────────────────────────────────────────────────
describe("page capture pure helpers", () => {
  it("formActionHosts resolves relative / empty actions against the final URL, http(s) only", () => {
    expect(formActionHosts(["", "/post", "https://Collector.Evil.net/x", "javascript:void(0)", "mailto:a@b.c"], "https://kit.example.com/login"))
      .toEqual(["kit.example.com", "collector.evil.net"]);
  });

  it("detectAntiBotWall: challenge phrases, blank decoys, and normal pages", () => {
    expect(detectAntiBotWall({ title: "Attention Required! | Cloudflare", bodyText: "", formActions: [] })).toBe("cf_challenge");
    expect(detectAntiBotWall({ title: "", bodyText: "Verifying you are human. This may take a few seconds.", formActions: [] })).toBe("cf_challenge");
    expect(detectAntiBotWall({ title: "", bodyText: "   ", formActions: [] })).toBe("blank_page");
    expect(detectAntiBotWall({ title: "Sign in", bodyText: "Email", formActions: [""] })).toBeNull();
  });

  it("CaptureRefusedError is distinguishable from transient errors", () => {
    expect(new CaptureRefusedError("x")).toBeInstanceOf(Error);
    expect(new CaptureRefusedError("x").name).toBe("CaptureRefusedError");
  });

  it("applySecurityHeaders keeps a handler's sandbox CSP and sets the site CSP otherwise", () => {
    const sandboxed = applySecurityHeaders(new Response("x", { headers: { "Content-Security-Policy": "sandbox" } }), "/api/x");
    expect(sandboxed.headers.get("Content-Security-Policy")).toBe("sandbox");
    const plain = applySecurityHeaders(new Response("x"), "/api/x");
    expect(plain.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
    const loose = applySecurityHeaders(new Response("x", { headers: { "Content-Security-Policy": "default-src *" } }), "/api/x");
    expect(loose.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
  });
});

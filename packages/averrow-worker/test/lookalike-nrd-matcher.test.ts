/**
 * NRD <-> lookalike matching (lib/lookalike-nrd-matcher.ts, migration 0282)
 * and the confirmed-new-registration alert it feeds, against real SQLite
 * with the schema and index set DERIVED from migrations/.
 *
 * Pins:
 *   - query plans: the window probe and the join are range seeks on
 *     idx_nrd_domains_created, the lookalike probe uses idx_lookalike_domain,
 *     and the two public-proof counts are index-served;
 *   - claim semantics: an unchecked row is dated from the NRD list and
 *     moved to the front of the queue; a row already observed registered
 *     BEFORE the NRD date, a row with a first_seen, and a stale listing are
 *     not claimed;
 *   - the keyset cursor pages correctly through a created_at tie group and
 *     never re-claims;
 *   - nrd-retention holds at the lookalike cursor;
 *   - end to end: an NRD-matched UNCHECKED row is resolved by the checker
 *     as an observed registration with ONE MEDIUM alert; an unmatched first
 *     contact stays baseline-only with no alert; a re-check files nothing
 *     more;
 *   - the cadence split and the policy exemption.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  hasSqlite,
  openDerivedDb,
  d1FromSqlite,
  fakeKv,
  type SqliteDb,
} from "./sqlite-d1-harness";
import { liveIndexDdl } from "./migration-indexes";
import type { Env } from "../src/types";

// ─── Collaborator mocks (the checker's network edges) ──────────────
const { checkDomainSpy, checkBIMISpy, createAlertSpy, pageAnalysisSpy } = vi.hoisted(() => ({
  checkDomainSpy: vi.fn(),
  checkBIMISpy: vi.fn(),
  createAlertSpy: vi.fn(),
  pageAnalysisSpy: vi.fn(),
}));
vi.mock("../src/lib/domain-checker", () => ({ checkDomain: checkDomainSpy }));
vi.mock("../src/email-security", () => ({ checkBIMIExists: checkBIMISpy }));
vi.mock("../src/lib/alerts", () => ({ createAlert: createAlertSpy }));
vi.mock("../src/scanners/lookalike-page-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/scanners/lookalike-page-analysis")>();
  return { ...actual, runPageAnalysisForDomain: pageAnalysisSpy };
});

const {
  runLookalikeNrdMatch,
  parseNrdCursor,
  LOOKALIKE_NRD_CURSOR_KEY,
  NRD_WINDOW_END_SQL,
  NRD_LOOKALIKE_JOIN_SQL,
  NRD_MATCH_PRIORITY_DUE_AT,
} = await import("../src/lib/lookalike-nrd-matcher");
const { checkLookalikeBatch, checkCadenceFor } = await import("../src/scanners/lookalike-domains");
const { purgeNrdDomains, toSqliteUtc, NRD_RETENTION_UNSCANNED_SQL } = await import("../src/lib/nrd-retention");
const { PHANTOM_MATCHER_NRD_CURSOR_KEY } = await import("../src/lib/phantom-matcher");
const {
  newRegistrationAlertSeverity,
  NEW_REGISTRATION_ALERT_SEVERITY,
  clearsLookalikeAlertFloor,
} = await import("../src/lib/lookalike-alert-policy");

// ─── Fixture ───────────────────────────────────────────────────────

const NOW_MS = Date.now();
const daysAgoDate = (d: number) => new Date(NOW_MS - d * 86_400_000).toISOString().slice(0, 10);
const hoursAgo = (h: number) => toSqliteUtc(NOW_MS - h * 3_600_000);

function openDb(): SqliteDb {
  const raw = openDerivedDb(["nrd_domains", "lookalike_domains", "brands"]);
  for (const t of ["nrd_domains", "lookalike_domains"]) {
    for (const ddl of liveIndexDdl(t).values()) raw.exec(ddl);
  }
  raw.prepare(
    "INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1', 'Tp Link', 'tp-link.com', 'monitored')",
  ).run();
  return raw;
}

function nrd(raw: SqliteDb, domain: string, registeredDate: string, createdAt = hoursAgo(1)): void {
  raw.prepare("INSERT INTO nrd_domains (domain, registered_date, created_at) VALUES (?, ?, ?)")
    .run(domain, registeredDate, createdAt);
}

let seq = 0;
function lookalike(raw: SqliteDb, domain: string, over: Record<string, unknown> = {}): string {
  seq += 1;
  const row: Record<string, unknown> = {
    id: `l${seq}`,
    brand_id: "b1",
    domain,
    permutation_type: "hyphenation",
    check_due_at: "2099-01-01 00:00:00", // NOT due unless the matcher prioritises it
    ...over,
  };
  const cols = Object.keys(row);
  raw.prepare(`INSERT INTO lookalike_domains (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => row[c] as null));
  return row.id as string;
}

function get(raw: SqliteDb, id: string): Record<string, unknown> {
  return (raw.prepare("SELECT * FROM lookalike_domains WHERE id = ?").all(id) as Array<Record<string, unknown>>)[0]!;
}

function envFor(raw: SqliteDb, kv = fakeKv()): Env & { CACHE: ReturnType<typeof fakeKv> } {
  return { DB: d1FromSqlite(raw), CACHE: kv } as unknown as Env & { CACHE: ReturnType<typeof fakeKv> };
}

function plan(raw: SqliteDb, sql: string): string {
  return (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((r) => r.detail).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  checkBIMISpy.mockResolvedValue(false);
  createAlertSpy.mockResolvedValue("alert_1");
  pageAnalysisSpy.mockResolvedValue({ result: { ok: false }, phishing: null });
});

// ─── Plans ─────────────────────────────────────────────────────────

describe.skipIf(!hasSqlite())("NRD matcher — query plans (migration-derived indexes)", () => {
  it("the window probe is a range seek on idx_nrd_domains_created with no temp b-tree", () => {
    const raw = openDb();
    const p = plan(raw, NRD_WINDOW_END_SQL);
    expect(p).toMatch(/SEARCH nrd_domains USING (COVERING )?INDEX idx_nrd_domains_created/);
    expect(p).not.toMatch(/TEMP B-TREE/);
    expect(p).not.toMatch(/SCAN nrd_domains/);
  });

  it("the join drives from the NRD window and probes lookalike_domains by idx_lookalike_domain", () => {
    const raw = openDb();
    const p = plan(raw, NRD_LOOKALIKE_JOIN_SQL);
    expect(p).toMatch(/SEARCH n USING INDEX idx_nrd_domains_created/);
    expect(p).toMatch(/SEARCH l USING (COVERING )?INDEX idx_lookalike_domain \(domain=\?\)/);
    expect(p).not.toMatch(/SCAN/);
  });

  it("the public-proof counts are index-served", async () => {
    const raw = openDb();
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "..", "src", "lib", "public-proof.ts"), "utf8");
    const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
    const newRegs = literals.find((t) => t.includes("registration_evidence IN"))!;
    const found = literals.find((t) => t.includes("COALESCE(first_seen, baseline_established_at)"))!;
    expect(plan(raw, newRegs)).toMatch(/USING INDEX idx_lookalike_first_seen/);
    expect(plan(raw, found)).toMatch(/USING INDEX idx_lookalike_registered/);
  });
});

// ─── Claim semantics ───────────────────────────────────────────────

describe.skipIf(!hasSqlite())("NRD matcher — claims", () => {
  it("dates an UNCHECKED row from the NRD list, prioritises it, and marks the NRD row (the tp-ink.com path)", async () => {
    const raw = openDb();
    const reg = daysAgoDate(2);
    nrd(raw, "tp-ink.com", reg);
    nrd(raw, "unrelated.example", reg);
    const id = lookalike(raw, "tp-ink.com");
    const env = envFor(raw);

    const r = await runLookalikeNrdMatch(env);

    expect(r.hits).toBe(1);
    expect(r.claimed).toBe(1);
    const row = get(raw, id);
    expect(row.first_seen).toBe(`${reg} 00:00:00`);
    expect(row.registration_evidence).toBe("nrd");
    expect(row.check_due_at).toBe(NRD_MATCH_PRIORITY_DUE_AT);
    expect(row.baseline_established_at).toBeNull();
    const marks = raw.prepare("SELECT domain, brand_matched FROM nrd_domains ORDER BY domain").all();
    expect(marks).toEqual([
      { domain: "tp-ink.com", brand_matched: 1 },
      { domain: "unrelated.example", brand_matched: 0 },
    ]);
    // The cursor advanced to the last NRD row's key.
    expect(parseNrdCursor(env.CACHE.store.get(LOOKALIKE_NRD_CURSOR_KEY) ?? null)).not.toBeNull();
  });

  it("does not claim a row already observed registered BEFORE the NRD date, nor overwrite a first_seen", async () => {
    const raw = openDb();
    const reg = daysAgoDate(1);
    nrd(raw, "old-squat.com", reg);
    nrd(raw, "seen.com", reg);
    nrd(raw, "baselined-after.com", reg);
    const before = lookalike(raw, "old-squat.com", {
      registered: 1, baseline_established_at: hoursAgo(24 * 20),
    });
    const seen = lookalike(raw, "seen.com", {
      registered: 1, baseline_established_at: hoursAgo(24 * 5),
      first_seen: "2026-01-02 03:04:05", registration_evidence: "observed",
    });
    // Baselined registered AFTER the registration date: the first-contact
    // path saw it and could not date it — exactly what NRD fixes.
    const after = lookalike(raw, "baselined-after.com", {
      registered: 1, baseline_established_at: hoursAgo(1),
    });

    const r = await runLookalikeNrdMatch(envFor(raw));

    expect(r.hits).toBe(3);
    expect(r.claimed).toBe(1);
    expect(get(raw, before).first_seen).toBeNull();
    expect(get(raw, seen).first_seen).toBe("2026-01-02 03:04:05");
    expect(get(raw, seen).registration_evidence).toBe("observed");
    expect(get(raw, after).registration_evidence).toBe("nrd");
    expect(get(raw, after).first_seen).toBe(`${reg} 00:00:00`);
  });

  it("does not claim a listing older than the max age", async () => {
    const raw = openDb();
    nrd(raw, "ancient.com", daysAgoDate(60));
    const id = lookalike(raw, "ancient.com");
    const r = await runLookalikeNrdMatch(envFor(raw));
    expect(r.stale).toBe(1);
    expect(r.claimed).toBe(0);
    expect(get(raw, id).first_seen).toBeNull();
  });

  it("pages through a created_at TIE GROUP by rowid, finds every hit once, and is idempotent", async () => {
    const raw = openDb();
    const reg = daysAgoDate(1);
    const sameSecond = hoursAgo(2);
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      nrd(raw, `perm-${i}.com`, reg, sameSecond);
      if (i % 4 === 0) ids.push(lookalike(raw, `perm-${i}.com`));
    }
    const env = envFor(raw);

    const r1 = await runLookalikeNrdMatch(env, { windowRows: 5, maxWindows: 100 });
    expect(r1.windows).toBe(5); // 4 full windows of 5 + the partial tail of 3
    expect(r1.hits).toBe(ids.length);
    expect(r1.claimed).toBe(ids.length);
    for (const id of ids) expect(get(raw, id).registration_evidence).toBe("nrd");

    // Caught up: a second run scans nothing and claims nothing.
    const r2 = await runLookalikeNrdMatch(env, { windowRows: 5, maxWindows: 100 });
    expect(r2.windows).toBe(0);
    expect(r2.claimed).toBe(0);

    // A new ingest after the cursor is picked up.
    nrd(raw, "late.com", reg, hoursAgo(0));
    const late = lookalike(raw, "late.com");
    const r3 = await runLookalikeNrdMatch(env, { windowRows: 5, maxWindows: 100 });
    expect(r3.claimed).toBe(1);
    expect(get(raw, late).registration_evidence).toBe("nrd");
  });

  it("stops at the window cap with more_remaining and resumes where it left off", async () => {
    const raw = openDb();
    const reg = daysAgoDate(1);
    for (let i = 0; i < 12; i++) nrd(raw, `x-${i}.com`, reg, hoursAgo(3));
    const tail = lookalike(raw, "x-11.com");
    const env = envFor(raw);

    const r1 = await runLookalikeNrdMatch(env, { windowRows: 5, maxWindows: 1 });
    expect(r1.more_remaining).toBe(true);
    expect(get(raw, tail).first_seen).toBeNull();

    await runLookalikeNrdMatch(env, { windowRows: 5, maxWindows: 1 });
    await runLookalikeNrdMatch(env, { windowRows: 5, maxWindows: 1 });
    expect(get(raw, tail).registration_evidence).toBe("nrd");
  });
});

// ─── Retention holds at the lookalike cursor ───────────────────────

describe.skipIf(!hasSqlite())("nrd-retention — the lookalike matcher's hold", () => {
  const now = Date.UTC(2026, 9, 5, 0, 7, 0);
  const old = (d: number) => toSqliteUtc(now - d * 86_400_000);

  it("a STUCK lookalike cursor is clamped to now − 37 days — and with 30-day retention the clamp binds", async () => {
    // M2: the hold is clamped to no earlier than now − (30 + 7) days, so a
    // matcher stuck 100 days ago does not pin the table. At 30-day
    // retention the clamped hold (37 days) is EARLIER than the age cutoff,
    // so it binds: rows 30–37 days old are held, older ones purged.
    const raw = openDb();
    nrd(raw, "a.com", "2026-06-01", old(120));
    nrd(raw, "b.com", "2026-06-02", old(40));
    nrd(raw, "held.com", "2026-06-03", old(33));
    nrd(raw, "c.com", "2026-06-03", old(10));
    const kv = fakeKv({
      [PHANTOM_MATCHER_NRD_CURSOR_KEY]: old(0),
      [LOOKALIKE_NRD_CURSOR_KEY]: JSON.stringify({ created_at: old(100), rowid: 1 }),
    });

    const r = await purgeNrdDomains(envFor(raw, kv), { now: () => now });

    expect(r.held_by_lookalike_matcher).toBe(true);
    expect(r.lookalike_cursor).toBe(old(100));
    expect(r.cutoff).toBe(old(37));
    const left = (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>)
      .map((x) => x.domain);
    expect(left).toEqual(["c.com", "held.com"]);
  });

  it("a lookalike cursor inside the clamp window holds exactly at its created_at", async () => {
    const raw = openDb();
    nrd(raw, "older.com", "2026-06-01", old(34));
    nrd(raw, "unscanned.com", "2026-06-02", old(31));
    const kv = fakeKv({
      [PHANTOM_MATCHER_NRD_CURSOR_KEY]: old(0),
      [LOOKALIKE_NRD_CURSOR_KEY]: JSON.stringify({ created_at: old(32), rowid: 1 }),
    });
    const r = await purgeNrdDomains(envFor(raw, kv), { now: () => now });
    expect(r.held_by_lookalike_matcher).toBe(true);
    expect(r.cutoff).toBe(old(32));
    const left = (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>)
      .map((x) => x.domain);
    expect(left).toEqual(["unscanned.com"]);
  });

  it("a CAUGHT-UP cursor on a sparse table (nothing above it) holds nothing — not a stuck matcher", async () => {
    // nrd_domains is sparse since the feed stores only lookalike/phantom-
    // equal NRDs: the cursor can sit on an old row only because nothing
    // newer was ingested. Every row is at/below the cursor key, i.e.
    // scanned, so there is nothing to hold and the signal must stay false.
    const raw = openDb();
    nrd(raw, "older.com", "2026-06-01", old(40));
    nrd(raw, "last.com", "2026-06-02", old(35));
    const rid = (raw.prepare("SELECT rowid AS r FROM nrd_domains WHERE domain = 'last.com'").get() as { r: number }).r;
    const kv = fakeKv({
      [PHANTOM_MATCHER_NRD_CURSOR_KEY]: old(0),
      [LOOKALIKE_NRD_CURSOR_KEY]: JSON.stringify({ created_at: old(35), rowid: rid }),
    });
    const r = await purgeNrdDomains(envFor(raw, kv), { now: () => now });
    expect(r.held_by_lookalike_matcher).toBe(false);
    expect(r.cutoff).toBe(old(30));
    // The probe is a keyset seek on idx_nrd_domains_created, no temp sort.
    const p = plan(raw, NRD_RETENTION_UNSCANNED_SQL);
    expect(p).toMatch(/SEARCH nrd_domains USING (COVERING )?INDEX idx_nrd_domains_created/);
    expect(p).not.toMatch(/TEMP B-TREE/);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM nrd_domains").get()).toEqual({ n: 0 });
  });

  it("the unscanned-row probe failing keeps the hold (any doubt → hold)", async () => {
    const raw = openDb();
    nrd(raw, "last.com", "2026-06-02", old(35));
    const kv = fakeKv({
      [PHANTOM_MATCHER_NRD_CURSOR_KEY]: old(0),
      [LOOKALIKE_NRD_CURSOR_KEY]: JSON.stringify({ created_at: old(35), rowid: 999 }),
    });
    const env = envFor(raw, kv);
    const inner = env.DB;
    const failing = {
      ...inner,
      prepare: (sql: string) => {
        if (sql === NRD_RETENTION_UNSCANNED_SQL) throw new Error("D1_ERROR: probe failed");
        return inner.prepare(sql);
      },
    } as unknown as D1Database;
    const r = await purgeNrdDomains({ ...env, DB: failing } as Env, { now: () => now });
    expect(r.held_by_lookalike_matcher).toBe(true);
    expect(r.cutoff).toBe(old(35));
    expect(raw.prepare("SELECT COUNT(*) AS n FROM nrd_domains").get()).toEqual({ n: 1 });
  });

  it("an absent lookalike cursor holds nothing (only the phantom hold / age cutoff apply)", async () => {
    const raw = openDb();
    nrd(raw, "a.com", "2026-06-01", old(120));
    const env = envFor(raw, fakeKv({ [PHANTOM_MATCHER_NRD_CURSOR_KEY]: toSqliteUtc(now) }));
    const r = await purgeNrdDomains(env, { now: () => now });
    expect(r.held_by_lookalike_matcher).toBe(false);
    expect(r.deleted).toBe(1);
  });
});

// ─── End to end: matcher -> checker -> alert ───────────────────────

// An answered "not registered" defaults to NXDOMAIN; NODATA (the name
// exists, no A/MX) is `nxdomain: false` explicitly.
const answer = (over: Record<string, unknown> = {}) => ({
  registered: false, resolved: true, hasMx: false, hasWeb: false,
  aAnswered: true, mxAnswered: true, webAnswered: true,
  nxdomain: over.registered !== true, ...over,
});

describe.skipIf(!hasSqlite())("NRD-matched row through the checker", () => {
  it("an NRD-matched UNCHECKED row is an observed registration: first_seen = NRD date, ONE MEDIUM alert, no duplicate on re-check", async () => {
    const raw = openDb();
    const reg = daysAgoDate(2);
    nrd(raw, "tp-ink.com", reg);
    const id = lookalike(raw, "tp-ink.com");
    const env = envFor(raw);

    await runLookalikeNrdMatch(env);
    // Parked (no A, no MX) is the typical shape of a fresh registration.
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.7", hasWeb: true }));
    const s1 = await checkLookalikeBatch(env);

    expect(s1.selected_first_contact).toBe(1);
    expect(s1.nrd_registrations).toBe(1);
    expect(s1.baselines_established).toBe(0); // NOT a first-contact baseline
    expect(s1.registration_alerts).toBe(1);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({
      brandId: "b1",
      alertType: "lookalike_domain_active",
      severity: "MEDIUM",
      title: "New lookalike domain registered: tp-ink.com",
      sourceType: "lookalike_scanner",
      sourceId: id,
      details: {
        new_registration: true,
        registration_evidence: "nrd",
        registered_at: `${reg} 00:00:00`,
      },
    });
    // Through createAlert WITH env, so alert.created webhooks fan out.
    expect(createAlertSpy.mock.calls[0]![2]).toMatchObject({ env });

    const row = get(raw, id);
    expect(row.first_seen).toBe(`${reg} 00:00:00`);
    expect(row.registration_evidence).toBe("nrd");
    expect(row.registration_alerted_at).not.toBeNull();
    expect(row.baseline_established_at).not.toBeNull(); // coverage recorded
    expect(row.alert_id).toBeNull(); // below-floor alert is not the operational link

    // Re-check: same registration, nothing new.
    raw.prepare("UPDATE lookalike_domains SET check_due_at = datetime('now','-1 hour') WHERE id = ?").run(id);
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
  });

  it("files the NRD alert on NODATA (exists, no records yet), and does not re-alert when DNS catches up", async () => {
    const raw = openDb();
    nrd(raw, "tp-iink.com", daysAgoDate(1));
    const id = lookalike(raw, "tp-iink.com");
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);

    checkDomainSpy.mockResolvedValue(answer({ registered: false, nxdomain: false }));
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(get(raw, id).registered).toBe(0);

    // DNS catches up: an observed 0 -> 1 of the SAME registration event.
    raw.prepare("UPDATE lookalike_domains SET check_due_at = datetime('now','-1 hour') WHERE id = ?").run(id);
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.8" }));
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(get(raw, id).registration_evidence).toBe("nrd"); // evidence unchanged
  });

  it("an UNMATCHED first contact stays a baseline: no first_seen, no alert", async () => {
    const raw = openDb();
    const id = lookalike(raw, "tplink-login.com", { check_due_at: hoursAgo(1) });
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);

    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.9", hasWeb: true }));
    const s = await checkLookalikeBatch(env);

    expect(s.baselines_established).toBe(1);
    expect(createAlertSpy).not.toHaveBeenCalled();
    const row = get(raw, id);
    expect(row.first_seen).toBeNull();
    expect(row.registration_evidence).toBeNull();
    expect(row.registration_alerted_at).toBeNull();
  });

  it("an NRD hit on a row that already has its HIGH alert marks the event handled without a second alert", async () => {
    const raw = openDb();
    const reg = daysAgoDate(1);
    nrd(raw, "tp-llnk.com", reg);
    const id = lookalike(raw, "tp-llnk.com", {
      registered: 1, has_mx: 1, has_web: 1, threat_level: "HIGH",
      baseline_established_at: hoursAgo(1), alert_id: "alert_existing",
    });
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.10", hasMx: true, hasWeb: true }));

    await checkLookalikeBatch(env);

    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(get(raw, id).registration_alerted_at).not.toBeNull();
    expect(get(raw, id).alert_id).toBe("alert_existing");
  });

  it("a lapse releases the claim, so a later re-registration alerts again", async () => {
    const raw = openDb();
    const id = lookalike(raw, "cycle.com", {
      registered: 1, baseline_established_at: hoursAgo(48),
      first_seen: hoursAgo(40), registration_evidence: "observed",
      registration_alerted_at: hoursAgo(40), check_due_at: hoursAgo(1),
    });
    const env = envFor(raw);

    checkDomainSpy.mockResolvedValue(answer({ registered: false }));
    await checkLookalikeBatch(env);
    expect(get(raw, id).registration_alerted_at).toBeNull();

    raw.prepare("UPDATE lookalike_domains SET check_due_at = datetime('now','-1 hour') WHERE id = ?").run(id);
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.11" }));
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({ severity: "MEDIUM" });
  });

  it("a createAlert throw releases the claim so the next pass retries", async () => {
    const raw = openDb();
    nrd(raw, "retry.com", daysAgoDate(1));
    const id = lookalike(raw, "retry.com");
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);

    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.12" }));
    createAlertSpy.mockRejectedValueOnce(new Error("boom"));
    const s1 = await checkLookalikeBatch(env);
    expect(s1.row_errors).toBe(1);
    expect(get(raw, id).registration_alerted_at).toBeNull();

    raw.prepare("UPDATE lookalike_domains SET check_due_at = datetime('now','-1 hour') WHERE id = ?").run(id);
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(2);
    expect(get(raw, id).registration_alerted_at).not.toBeNull();
  });
});

// ─── Review fixes: H1 / TI-1 / L1 / L3 / M1 / TI-6 ─────────────────

const due = (raw: SqliteDb, id: string) =>
  raw.prepare("UPDATE lookalike_domains SET check_due_at = datetime('now','-1 hour') WHERE id = ?").run(id);

describe.skipIf(!hasSqlite())("review fixes", () => {
  it("H1: NRD claim → alert → NXDOMAIN lapse → NXDOMAIN re-check (no alert) → re-registration (ONE alert, current date)", async () => {
    const raw = openDb();
    const reg = daysAgoDate(3);
    nrd(raw, "tp-1ink.com", reg);
    const id = lookalike(raw, "tp-1ink.com");
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);

    // 1. NRD-dated registration resolves → one alert dated from the list.
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.20" }));
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(createAlertSpy.mock.calls[0]![1]).toMatchObject({ details: { registered_at: `${reg} 00:00:00` } });

    // 2. Answered NXDOMAIN on the registered row → a lapse; the event ends.
    due(raw, id);
    checkDomainSpy.mockResolvedValue(answer({ registered: false, nxdomain: true }));
    const lapse = await checkLookalikeBatch(env);
    expect(lapse.registrations_lost).toBe(1);
    expect(get(raw, id).registration_evidence).toBeNull();
    expect(get(raw, id).registration_alerted_at).toBeNull();
    expect(get(raw, id).first_seen).toBe(`${reg} 00:00:00`); // kept

    // 3. NXDOMAIN again: NOT NRD-pending any more → no false alert.
    due(raw, id);
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);

    // 4. Re-registration → exactly one alert, dated NOW, not the old date.
    due(raw, id);
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.21" }));
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(2);
    const second = createAlertSpy.mock.calls[1]![1] as { details: { registered_at: string; registration_evidence: string } };
    expect(second.details.registration_evidence).toBe("observed");
    expect(second.details.registered_at.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(get(raw, id).first_seen).not.toBe(`${reg} 00:00:00`);
    expect(get(raw, id).registration_evidence).toBe("observed");

    // 5. And the re-check of that registration files nothing more.
    due(raw, id);
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(2);
  });

  it("TI-1: NODATA on a registered row is NOT a lapse (registered stays 1, claim kept)", async () => {
    const raw = openDb();
    const id = lookalike(raw, "nodata.com", {
      registered: 1, baseline_established_at: hoursAgo(48), check_due_at: hoursAgo(1),
      first_seen: hoursAgo(40), registration_evidence: "observed", registration_alerted_at: hoursAgo(40),
    });
    checkDomainSpy.mockResolvedValue(answer({ registered: false, nxdomain: false }));
    const s = await checkLookalikeBatch(envFor(raw));
    expect(s.registrations_lost).toBe(0);
    expect(get(raw, id).registered).toBe(1);
    expect(get(raw, id).registration_alerted_at).not.toBeNull();
  });

  it("TI-1: an NRD-dated row answering NXDOMAIN is HELD (no claim, no alert) and alerts when it resolves", async () => {
    const raw = openDb();
    nrd(raw, "held.com", daysAgoDate(1));
    const id = lookalike(raw, "held.com");
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);

    checkDomainSpy.mockResolvedValue(answer({ registered: false, nxdomain: true }));
    const s1 = await checkLookalikeBatch(env);
    expect(s1.nrd_registrations_held).toBe(1);
    expect(createAlertSpy).not.toHaveBeenCalled();
    expect(get(raw, id).registration_alerted_at).toBeNull();
    expect(get(raw, id).registration_evidence).toBe("nrd");

    due(raw, id);
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.22" }));
    await checkLookalikeBatch(env);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
  });

  it("TI-1: an NRD hold expires with the 30-day window (no alert for a stale listing)", async () => {
    const raw = openDb();
    const id = lookalike(raw, "expired.com", {
      first_seen: toSqliteUtc(Date.now() - 31 * 86_400_000), registration_evidence: "nrd",
      check_due_at: hoursAgo(1), baseline_established_at: hoursAgo(24 * 20),
    });
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.23" }));
    await checkLookalikeBatch(envFor(raw));
    // Not pending: the stale NRD date is NOT alerted as an NRD
    // registration. The 0 -> 1 is a real observed registration, so it is
    // re-dated NOW with 'observed' evidence and alerts once as such.
    expect(get(raw, id).registration_evidence).toBe("observed");
    expect(String(get(raw, id).first_seen).slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    const evs = createAlertSpy.mock.calls.map((c) => (c[1] as { details: { registration_evidence?: string } }).details.registration_evidence);
    expect(evs).toEqual(["observed"]);
  });

  it("L1: when createAlert succeeded but the alert_id link throws, the claim is NOT released", async () => {
    const raw = openDb();
    nrd(raw, "link-fail.com", daysAgoDate(1));
    const id = lookalike(raw, "link-fail.com");
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);
    // mail+web → HIGH → the alert is linked via `SET alert_id = ?`; make
    // that UPDATE throw.
    const db = env.DB as unknown as { prepare(sql: string): D1PreparedStatement };
    const realPrepare = db.prepare.bind(db);
    (env as unknown as { DB: unknown }).DB = {
      ...env.DB,
      prepare: (sql: string) => {
        if (sql.includes("SET alert_id = ?")) throw new Error("injected link failure");
        return realPrepare(sql);
      },
    };
    checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.24", hasMx: true, hasWeb: true }));
    const s = await checkLookalikeBatch(env);

    expect(s.row_errors).toBe(1);
    expect(createAlertSpy).toHaveBeenCalledTimes(1);
    expect(get(raw, id).registration_alerted_at).not.toBeNull();

    due(raw, id);
    await checkLookalikeBatch(env);
    // No duplicate new-registration alert on the retry.
    const newRegs = createAlertSpy.mock.calls.filter(
      (c) => (c[1] as { details: { new_registration?: boolean } }).details.new_registration === true,
    );
    expect(newRegs).toHaveLength(1);
  });

  it("L3: a benign / taken_down row gets no new-registration alert", async () => {
    for (const status of ["benign", "taken_down"]) {
      vi.clearAllMocks();
      createAlertSpy.mockResolvedValue("alert_1");
      const raw = openDb();
      nrd(raw, `${status}.com`, daysAgoDate(1));
      lookalike(raw, `${status}.com`, { status });
      const env = envFor(raw);
      await runLookalikeNrdMatch(env);
      checkDomainSpy.mockResolvedValue(answer({ registered: true, ip: "203.0.113.25" }));
      await checkLookalikeBatch(env);
      expect(createAlertSpy, status).not.toHaveBeenCalled();
    }
  });

  it("M1: with no cursor the first run starts at now − 30 days of ingest", async () => {
    const raw = openDb();
    const reg = daysAgoDate(1);
    nrd(raw, "ancient-ingest.com", reg, hoursAgo(24 * 45)); // ingested 45 d ago
    nrd(raw, "recent-ingest.com", reg, hoursAgo(2));
    const a = lookalike(raw, "ancient-ingest.com");
    const b = lookalike(raw, "recent-ingest.com");
    const r = await runLookalikeNrdMatch(envFor(raw));
    expect(r.hits).toBe(1);
    expect(get(raw, a).first_seen).toBeNull();
    expect(get(raw, b).registration_evidence).toBe("nrd");
  });

  it("TI-6: a baseline up to 2 days before the NRD list date still counts as new", async () => {
    const raw = openDb();
    const reg = daysAgoDate(1);
    nrd(raw, "slack.com", reg);
    nrd(raw, "older.com", reg);
    const slack = lookalike(raw, "slack.com", {
      registered: 1, baseline_established_at: toSqliteUtc(Date.parse(`${reg}T00:00:00Z`) - 36 * 3_600_000),
    });
    const older = lookalike(raw, "older.com", {
      registered: 1, baseline_established_at: toSqliteUtc(Date.parse(`${reg}T00:00:00Z`) - 72 * 3_600_000),
    });
    await runLookalikeNrdMatch(envFor(raw));
    expect(get(raw, slack).registration_evidence).toBe("nrd");
    expect(get(raw, older).registration_evidence).toBeNull();
  });
});

// ─── Cadence + policy (pure) ───────────────────────────────────────

describe("re-check cadence by state (TI-2)", () => {
  const base = { domain: "tp-ink.com", registered: true, hasMx: false, hasWeb: false, recentRegistration: false, highAlerted: false };
  it("follows the approved table", () => {
    expect(checkCadenceFor({ ...base, registered: false })).toBe("+24 hours");
    expect(checkCadenceFor({ ...base, recentRegistration: true })).toBe("+24 hours");
    expect(checkCadenceFor({ ...base, recentRegistration: true, hasWeb: true })).toBe("+24 hours");
    expect(checkCadenceFor({ ...base, hasWeb: true })).toBe("+72 hours");
    expect(checkCadenceFor({ ...base, hasMx: true, hasWeb: true })).toBe("+7 days");
    expect(checkCadenceFor({ ...base, recentRegistration: true, hasMx: true, hasWeb: true })).toBe("+7 days");
    expect(checkCadenceFor({ ...base, highAlerted: true, recentRegistration: true })).toBe("+7 days");
  });
  it("puts unregistrable suffixes on 30 days, whatever their state", () => {
    for (const d of ["tp-link.gov", "tplink.edu", "tp-link.mil", "tp-link.int", "tplink.google", "tp-link.gov.uk"]) {
      expect(checkCadenceFor({ ...base, domain: d, registered: false }), d).toBe("+30 days");
    }
    expect(checkCadenceFor({ ...base, domain: "tplinkgov.com", registered: false })).toBe("+24 hours");
  });
});

describe.skipIf(!hasSqlite())("cadence is what the success path writes", () => {
  it("schedules by the OBSERVED registration state", async () => {
    const raw = openDb();
    const unreg = lookalike(raw, "u.com", { check_due_at: hoursAgo(1), baseline_established_at: hoursAgo(48) });
    const reg = lookalike(raw, "r.com", {
      check_due_at: hoursAgo(1), baseline_established_at: hoursAgo(48), registered: 1,
    });
    checkDomainSpy.mockImplementation(async (d: string) =>
      d === "r.com" ? answer({ registered: true, ip: "203.0.113.13" }) : answer());
    await checkLookalikeBatch(envFor(raw));

    const dueAt = (id: string) => Date.parse(String(get(raw, id).check_due_at).replace(" ", "T") + "Z");
    const h = (ms: number) => (ms - Date.now()) / 3_600_000;
    // unregistered → 24 h; registered, old, neither mail nor web → 72 h.
    expect(h(dueAt(unreg))).toBeGreaterThan(23);
    expect(h(dueAt(unreg))).toBeLessThan(25);
    expect(h(dueAt(reg))).toBeGreaterThan(71);
    expect(h(dueAt(reg))).toBeLessThan(73);
  });
});

describe("new-registration policy exemption", () => {
  it("is MEDIUM, and MEDIUM is below the HIGH floor (i.e. a genuine exemption)", () => {
    expect(NEW_REGISTRATION_ALERT_SEVERITY).toBe("MEDIUM");
    expect(clearsLookalikeAlertFloor(NEW_REGISTRATION_ALERT_SEVERITY)).toBe(false);
  });

  it("floors LOW to MEDIUM and never caps a higher composed level", () => {
    expect(newRegistrationAlertSeverity("LOW")).toBe("MEDIUM");
    expect(newRegistrationAlertSeverity("MEDIUM")).toBe("MEDIUM");
    expect(newRegistrationAlertSeverity("HIGH")).toBe("HIGH");
    expect(newRegistrationAlertSeverity("CRITICAL")).toBe("CRITICAL");
  });
});

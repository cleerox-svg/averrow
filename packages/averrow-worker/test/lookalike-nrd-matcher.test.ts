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
const { purgeNrdDomains, toSqliteUtc } = await import("../src/lib/nrd-retention");
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
  it("never purges rows the lookalike matcher has not scanned", async () => {
    const raw = openDb();
    const now = Date.UTC(2026, 9, 5, 0, 7, 0);
    const old = (d: number) => toSqliteUtc(now - d * 86_400_000);
    nrd(raw, "a.com", "2026-06-01", old(120));
    nrd(raw, "b.com", "2026-06-02", old(110));
    nrd(raw, "c.com", "2026-06-03", old(100));
    const kv = fakeKv({
      // The phantom matcher is fully caught up…
      [PHANTOM_MATCHER_NRD_CURSOR_KEY]: old(0),
      // …but the lookalike matcher has only scanned up to b.com.
      [LOOKALIKE_NRD_CURSOR_KEY]: JSON.stringify({ created_at: old(110), rowid: 2 }),
    });
    const env = envFor(raw, kv);

    const r = await purgeNrdDomains(env, { now: () => now });

    expect(r.held_by_lookalike_matcher).toBe(true);
    expect(r.cutoff).toBe(old(110));
    const left = (raw.prepare("SELECT domain FROM nrd_domains ORDER BY domain").all() as Array<{ domain: string }>)
      .map((x) => x.domain);
    expect(left).toEqual(["b.com", "c.com"]);
  });

  it("an absent lookalike cursor holds nothing (phantom cursor stays the floor)", async () => {
    const raw = openDb();
    const now = Date.UTC(2026, 9, 5, 0, 7, 0);
    nrd(raw, "a.com", "2026-06-01", toSqliteUtc(now - 120 * 86_400_000));
    const env = envFor(raw, fakeKv({ [PHANTOM_MATCHER_NRD_CURSOR_KEY]: toSqliteUtc(now) }));
    const r = await purgeNrdDomains(env, { now: () => now });
    expect(r.held_by_lookalike_matcher).toBe(false);
    expect(r.deleted).toBe(1);
  });
});

// ─── End to end: matcher -> checker -> alert ───────────────────────

const answer = (over: Record<string, unknown> = {}) => ({
  registered: false, resolved: true, hasMx: false, hasWeb: false,
  aAnswered: true, mxAnswered: true, webAnswered: true, ...over,
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

  it("files the NRD alert even when DNS has nothing yet, and does not re-alert when DNS catches up", async () => {
    const raw = openDb();
    nrd(raw, "tp-iink.com", daysAgoDate(1));
    const id = lookalike(raw, "tp-iink.com");
    const env = envFor(raw);
    await runLookalikeNrdMatch(env);

    checkDomainSpy.mockResolvedValue(answer({ registered: false }));
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

// ─── Cadence + policy (pure) ───────────────────────────────────────

describe("re-check cadence by registration state", () => {
  it("unregistered rows come back in 24 h, registered rows in 7 days", () => {
    expect(checkCadenceFor(false)).toBe("+24 hours");
    expect(checkCadenceFor(true)).toBe("+7 days");
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

    const due = (id: string) => Date.parse(String(get(raw, id).check_due_at).replace(" ", "T") + "Z");
    const h = (ms: number) => (ms - Date.now()) / 3_600_000;
    expect(h(due(unreg))).toBeGreaterThan(23);
    expect(h(due(unreg))).toBeLessThan(25);
    expect(h(due(reg))).toBeGreaterThan(24 * 7 - 1);
    expect(h(due(reg))).toBeLessThan(24 * 7 + 1);
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

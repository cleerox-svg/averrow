/**
 * G4 / L14 / L15 — every alert created for an org emits `alert.created`
 * (org webhook + connected integrations) exactly once, from createAlert.
 *
 * Before: only social / app-store / dark-web emitted, each from its own
 * scanner (and only to the first org that had the brand). Lookalike, CT,
 * threat, executive, … alerts never reached webhooks or SIEM connectors.
 *
 * Real createAlert against node:sqlite (migration-derived schema);
 * `emitOrgEvent` is mocked so the test counts deliveries per org.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const emitOrgEvent = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../src/lib/org-events", () => ({
  emitOrgEvent: (...args: unknown[]) => emitOrgEvent(...args),
}));

const { createAlert } = await import("../src/lib/alerts");
const { drainAlertEvents, pendingAlertEventCount } = await import("../src/lib/alert-events");

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("producers no longer emit alert.created themselves (no double emit)", () => {
  it.each([
    "../src/scanners/social-monitor.ts",
    "../src/scanners/app-store-monitor.ts",
    "../src/scanners/dark-web-monitor.ts",
  ])("%s does not call emitOrgEvent('alert.created')", (rel) => {
    const s = src(rel);
    expect(s).not.toMatch(/emitOrgEvent\([^)]*alert\.created/s);
    expect(s).not.toContain("emitOrgEvent");
  });

  it("backfill stays silent (claiming a brand must not flood webhooks)", () => {
    // No third (emit) argument on the backfill createAlert call.
    expect(src("../src/lib/alert-backfill.ts")).toContain(
      "createAlert(env.DB, { ...params, userId, bypassTierGate: true });",
    );
  });
});

describe.skipIf(!hasSqlite())("createAlert → alert.created (real SQLite)", () => {
  let raw: SqliteDb;
  let env: Env;
  let pending: Promise<unknown>[];
  const emitCtx = () => ({ env, waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
  const flush = async () => { await Promise.all(pending); };

  beforeEach(() => {
    raw = openDerivedDb(["brands", "alerts", "org_brands"]);
    env = { DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
    pending = [];
    emitOrgEvent.mockClear();

    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b1', 'Acme', 'acme.example', 'customer')").run();
    raw.prepare("INSERT INTO brands (id, name, canonical_domain, tier) VALUES ('b2', 'Tracked', 'tracked.example', 'tracked')").run();
    // b1 is co-monitored by orgs 1 and 2; org 3 has nothing to do with it.
    raw.prepare("INSERT INTO org_brands (org_id, brand_id) VALUES (1, 'b1')").run();
    raw.prepare("INSERT INTO org_brands (org_id, brand_id) VALUES (2, 'b1')").run();
    raw.prepare("INSERT INTO org_brands (org_id, brand_id) VALUES (3, 'b2')").run();
  });

  it("a createAlert-family alert (lookalike) emits once per owning org, with the core payload", async () => {
    const id = await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "lookalike_domain_active",
      severity: "HIGH", title: "Lookalike live: acme-login.example", summary: "s",
      sourceType: "lookalike", sourceId: "ld1",
    }, emitCtx());
    await flush();

    expect(id).toBeTruthy();
    expect(emitOrgEvent).toHaveBeenCalledTimes(2);
    const orgs = emitOrgEvent.mock.calls.map((c) => c[1]).sort();
    expect(orgs).toEqual([1, 2]);
    for (const call of emitOrgEvent.mock.calls) {
      expect(call[2]).toBe("alert.created");
      expect(call[3]).toMatchObject({
        alert_id: id, alert_type: "lookalike_domain_active", severity: "high",
        title: "Lookalike live: acme-login.example", brand_id: "b1",
        brand_name: "Acme", brand_domain: "acme.example",
      });
    }
  });

  it("a social alert emits exactly once per org (not twice) and keeps its family fields", async () => {
    await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "social_impersonation",
      severity: "CRITICAL", title: "Likely impersonation on x: @acme_help", summary: "s",
      details: { platform: "twitter", handle: "acme_help", score: 0.9 },
      sourceType: "social_monitor", sourceId: "sp1",
      eventData: { platform: "twitter", handle: "acme_help", impersonation_score: 0.9 },
    }, emitCtx());
    await flush();

    const created = emitOrgEvent.mock.calls.filter((c) => c[2] === "alert.created");
    expect(created).toHaveLength(2);
    expect(new Set(created.map((c) => c[1])).size).toBe(2);
    expect(created[0]![3]).toMatchObject({ platform: "twitter", handle: "acme_help", impersonation_score: 0.9, alert_type: "social_impersonation" });
  });

  it("an org-private (executive) alert goes ONLY to its owning org", async () => {
    await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "executive_impersonation",
      severity: "high", title: "Exec impersonation", summary: "s", orgId: 2,
      details: { platform: "linkedin", handle: "jane-doe-ceo", score: 0.95 },
      sourceType: "executive_monitor", sourceId: "ex1",
    }, emitCtx());
    await flush();

    expect(emitOrgEvent).toHaveBeenCalledTimes(1);
    expect(emitOrgEvent.mock.calls[0]![1]).toBe(2);
  });

  it("does not emit for tier-gated, auto-dismissed, or silent (backfill-style) creates", async () => {
    // tier='tracked' → no row, no event (org 3 owns b2 but nothing is created)
    expect(await createAlert(env.DB, {
      brandId: "b2", userId: "system", alertType: "lookalike_domain_active",
      severity: "high", title: "t", summary: "s",
    }, emitCtx())).toBeNull();

    // social rule A (score < 0.5) → born false_positive → no event
    await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "social_impersonation",
      severity: "high", title: "t", summary: "s",
      details: { platform: "twitter", handle: "acme_x", score: 0.2 },
    }, emitCtx());

    // no emit context → silent
    await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "lookalike_domain_active",
      severity: "high", title: "t", summary: "s",
    });
    await flush();

    expect(emitOrgEvent).not.toHaveBeenCalled();
    const dismissed = raw.prepare("SELECT status FROM alerts WHERE alert_type = 'social_impersonation'").all() as Array<{ status: string }>;
    expect(dismissed[0]!.status).toBe("false_positive");
  });

  it("a delivery failure never fails alert creation", async () => {
    emitOrgEvent.mockImplementation(async () => { throw new Error("webhook down"); });
    const id = await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "lookalike_domain_active",
      severity: "high", title: "t", summary: "s",
    }, emitCtx());
    await expect(flush()).resolves.toBeUndefined();
    expect(id).toBeTruthy();
    emitOrgEvent.mockImplementation(async () => {});
  });

  it("without waitUntil, delivery is tracked and drained before the invocation ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    emitOrgEvent.mockImplementation(async () => { await gate; });

    await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "lookalike_domain_active",
      severity: "high", title: "t", summary: "s",
    }, { env });
    // Allow the org lookup to run and the deliveries to start.
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingAlertEventCount()).toBe(1);

    let drained = false;
    const d = drainAlertEvents().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(drained).toBe(false); // still waiting on the delivery
    release();
    await d;
    expect(drained).toBe(true);
    expect(pendingAlertEventCount()).toBe(0);
    expect(emitOrgEvent).toHaveBeenCalledTimes(2);
    emitOrgEvent.mockImplementation(async () => {});
  });

  it("an org-private alert is not delivered to an org that does not hold the brand", async () => {
    await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "executive_impersonation",
      severity: "high", title: "Exec", summary: "s", orgId: 3,
      details: { platform: "linkedin", handle: "x", score: 0.95 },
    }, emitCtx());
    await flush();
    expect(emitOrgEvent).not.toHaveBeenCalled();
  });

  it("caps brand-wide fan-out at 50 orgs, lowest org ids first", async () => {
    for (let org = 10; org < 70; org++) {
      raw.prepare("INSERT INTO org_brands (org_id, brand_id) VALUES (?, 'b1')").run(org);
    }
    await createAlert(env.DB, {
      brandId: "b1", userId: "system", alertType: "lookalike_domain_active",
      severity: "high", title: "t", summary: "s",
    }, emitCtx());
    await flush();
    const orgs = emitOrgEvent.mock.calls.map((c) => c[1] as number);
    expect(orgs).toHaveLength(50);
    expect(Math.min(...orgs)).toBe(1);
    expect(orgs).toContain(2);
    expect(orgs).not.toContain(69);
  });
});

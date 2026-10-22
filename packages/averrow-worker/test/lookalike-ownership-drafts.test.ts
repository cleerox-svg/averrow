/**
 * The ownership hook (lib/lookalike-ownership-drafts.ts) starts Sparrow's
 * lookalike drafting when a brand becomes org-owned. It must be best-effort:
 * a drafting failure never fails the brand-add request, and the deferred
 * promise handed to waitUntil never rejects.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "../src/types";
import type { AuthContext } from "../src/middleware/auth";
import { hasSqlite, openDerivedDb, d1FromSqlite } from "./sqlite-d1-harness";

const draftForBrand = vi.fn();
vi.mock("../src/agents/sparrow", () => ({
  createTakedownsFromLookalikesForBrand: (...args: unknown[]) => draftForBrand(...args),
}));
vi.mock("../src/lib/alert-backfill", () => ({
  backfillAlertsForBrand: async () => ({}),
}));

import { scheduleOwnedLookalikeDrafts, runOwnedLookalikeDrafts } from "../src/lib/lookalike-ownership-drafts";
import { handleAssignOrgBrand } from "../src/handlers/organizations";

function fakeCtx(): ExecutionContext & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
}

beforeEach(() => {
  draftForBrand.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("scheduleOwnedLookalikeDrafts", () => {
  it("defers a brand-scoped draft run under waitUntil", async () => {
    draftForBrand.mockResolvedValue({ created: 2, failed: 0, firstError: null });
    const ctx = fakeCtx();
    const env = {} as Env;
    scheduleOwnedLookalikeDrafts(env, ctx, "brand_x", 42, "test");
    expect(ctx.pending).toHaveLength(1);
    await Promise.all(ctx.pending);
    expect(draftForBrand).toHaveBeenCalledWith(env, "brand_x", 42);
  });

  it("never rejects when drafting throws", async () => {
    draftForBrand.mockRejectedValue(new Error("D1_ERROR: boom"));
    await expect(runOwnedLookalikeDrafts({} as Env, "brand_x", 42, "test")).resolves.toBeUndefined();
  });

  it("is a no-op without an ExecutionContext", () => {
    scheduleOwnedLookalikeDrafts({} as Env, undefined, "brand_x", 42, "test");
    expect(draftForBrand).not.toHaveBeenCalled();
  });

  it("normalises a route-param org id to the INTEGER org_brands.org_id", async () => {
    draftForBrand.mockResolvedValue({ created: 0, failed: 0, firstError: null });
    const ctx = fakeCtx();
    const env = {} as Env;
    scheduleOwnedLookalikeDrafts(env, ctx, "brand_x", "42", "test");
    await Promise.all(ctx.pending);
    expect(draftForBrand).toHaveBeenCalledWith(env, "brand_x", 42);
  });

  it("is a no-op for a non-integer org id", () => {
    const ctx = fakeCtx();
    scheduleOwnedLookalikeDrafts({} as Env, ctx, "brand_x", "not-an-org", "test");
    expect(ctx.pending).toHaveLength(0);
    expect(draftForBrand).not.toHaveBeenCalled();
  });
});

describe.skipIf(!hasSqlite())("a later claimant of an already-owned brand drafts nothing into its own org", () => {
  it("org 8's admin claims a brand org 7 already owns → no drafts for 8; the cron drafts into 7", async () => {
    // Run the REAL Sparrow brand-scoped drafter behind the hook for this test.
    const sparrow = await vi.importActual<typeof import("../src/agents/sparrow")>("../src/agents/sparrow");
    draftForBrand.mockImplementation((...args: unknown[]) =>
      sparrow.createTakedownsFromLookalikesForBrand(...(args as Parameters<typeof sparrow.createTakedownsFromLookalikesForBrand>)));

    const raw = openDerivedDb([
      "organizations", "org_brands", "monitored_brands", "brands",
      "lookalike_domains", "takedown_requests", "takedown_evidence",
    ]);
    raw.exec(`
      INSERT INTO organizations (id, name, slug, max_brands) VALUES (7, 'Acme', 'acme', 5);
      INSERT INTO organizations (id, name, slug, max_brands) VALUES (8, 'Squatter', 'squatter', 5);
      INSERT INTO brands (id, name, canonical_domain) VALUES ('brand_acme', 'Acme', 'acme.example');
      INSERT INTO org_brands (org_id, brand_id, is_primary, created_at) VALUES (7, 'brand_acme', 0, '2026-10-01 00:00:00');
      INSERT INTO lookalike_domains (id, brand_id, domain, permutation_type, registered, has_web, has_mx, threat_level, status, first_seen)
        VALUES ('ld-1', 'brand_acme', 'acme-login.example', 'typo', 1, 1, 0, 'CRITICAL', 'monitoring', '2026-10-01 00:00:00');
    `);
    const env = {
      DB: d1FromSqlite(raw),
      AUDIT_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    } as unknown as Env;
    const ctx = fakeCtx();
    const request = new Request("https://x/api/orgs/8/brands", {
      method: "POST",
      body: JSON.stringify({ brand_id: "brand_acme", is_primary: true }),
    });
    const auth = { userId: "usr_sq", role: "client", orgId: "8", orgRole: "admin" } as unknown as AuthContext;

    const res = await handleAssignOrgBrand(request, env, "8", auth, ctx);
    expect(res.status).toBe(201);
    await Promise.all(ctx.pending);

    // The hook ran for the CALLER's org, and drafted nothing (8 is not the owner).
    expect(draftForBrand).toHaveBeenCalledWith(env, "brand_acme", 8);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM takedown_requests").get()).toEqual({ n: 0 });
    expect(raw.prepare("SELECT takedown_id FROM lookalike_domains").get()).toEqual({ takedown_id: null });
    expect(await sparrow.resolveOwningOrgId(env, "brand_acme")).toBe(7);

    // The cron still drafts the lookalike — into the original owner.
    expect(await sparrow.createTakedownsFromLookalikes(env)).toMatchObject({ created: 1, failed: 0 });
    expect(raw.prepare("SELECT org_id, brand_id FROM takedown_requests").all()).toEqual([{ org_id: 7, brand_id: "brand_acme" }]);
  });
});

describe.skipIf(!hasSqlite())("handleAssignOrgBrand + ownership drafting", () => {
  it("still assigns the brand (201) when lookalike drafting throws", async () => {
    draftForBrand.mockRejectedValue(new Error("D1_ERROR: drafting exploded"));
    const raw = openDerivedDb(["organizations", "org_brands", "monitored_brands"]);
    raw.prepare("INSERT INTO organizations (id, name, slug, max_brands) VALUES (5, 'Acme', 'acme', 5)").run();
    const env = {
      DB: d1FromSqlite(raw),
      AUDIT_DB: { prepare: () => ({ bind: () => ({ run: async () => ({}) }) }) },
    } as unknown as Env;
    const ctx = fakeCtx();
    const request = new Request("https://x/api/orgs/5/brands", {
      method: "POST",
      body: JSON.stringify({ brand_id: "brand_acme", is_primary: true }),
    });
    const auth = { userId: "usr_1", role: "super_admin" } as unknown as AuthContext;

    const res = await handleAssignOrgBrand(request, env, "5", auth, ctx);
    expect(res.status).toBe(201);
    expect(raw.prepare("SELECT org_id, brand_id FROM org_brands").all()).toEqual([{ org_id: 5, brand_id: "brand_acme" }]);

    // The deferred work settles without rejecting, after having tried to draft.
    await expect(Promise.all(ctx.pending)).resolves.toBeDefined();
    expect(draftForBrand).toHaveBeenCalledWith(env, "brand_acme", 5);
  });
});

describe("every org_brands insert path schedules ownership drafting", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf-8");
  const SITES: Array<[string, number]> = [
    ["src/handlers/organizations.ts", 2], // handleCreateOrg + handleAssignOrgBrand
    ["src/handlers/leadConversion.ts", 1], // handleConvertLeadToTenant
  ];
  for (const [file, n] of SITES) {
    it(file, () => {
      const src = read(file);
      expect((src.match(/INSERT INTO org_brands/g) ?? []).length).toBe(n);
      expect((src.match(/scheduleOwnedLookalikeDrafts\(env, workerCtx,/g) ?? []).length).toBe(n);
      // Every call passes the org that inserted the claim (org-scoped drafting).
      expect((src.match(/scheduleOwnedLookalikeDrafts\(env, workerCtx, [\w.]+, orgId, '/g) ?? []).length).toBe(n);
    });
  }
});

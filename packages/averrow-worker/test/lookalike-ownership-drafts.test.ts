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
    scheduleOwnedLookalikeDrafts(env, ctx, "brand_x", "test");
    expect(ctx.pending).toHaveLength(1);
    await Promise.all(ctx.pending);
    expect(draftForBrand).toHaveBeenCalledWith(env, "brand_x");
  });

  it("never rejects when drafting throws", async () => {
    draftForBrand.mockRejectedValue(new Error("D1_ERROR: boom"));
    await expect(runOwnedLookalikeDrafts({} as Env, "brand_x", "test")).resolves.toBeUndefined();
  });

  it("is a no-op without an ExecutionContext", () => {
    scheduleOwnedLookalikeDrafts({} as Env, undefined, "brand_x", "test");
    expect(draftForBrand).not.toHaveBeenCalled();
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
    expect(draftForBrand).toHaveBeenCalledWith(env, "brand_acme");
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
    });
  }
});

// Companion to briefing-resilience.test.ts (2026-11-10 briefing fix):
//   - the Resend request carries an AbortSignal timeout, so a hung send is
//     aborted (reported "not sent") rather than abandoned while it may still
//     deliver;
//   - fetchMarketingVisibility keeps the admin route's single Promise.all
//     when no guard is passed, and runs one read at a time through the
//     guard when the briefing passes one.

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Env } from "../src/types";
import { RESEND_TIMEOUT_MS, sendBriefingEmail } from "../src/lib/briefing-email";
import { fetchMarketingVisibility } from "../src/lib/marketing-analytics";
import { fetchComprehensiveBriefing } from "../src/handlers/briefing";
import { fakeKv } from "./sqlite-d1-harness";

function probeDb() {
  let inFlight = 0;
  let peak = 0;
  const db = {
    prepare() {
      const stmt = {
        bind: () => stmt,
        first: async () => {
          inFlight++; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 0));
          inFlight--;
          return null;
        },
        all: async () => {
          inFlight++; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 0));
          inFlight--;
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as Env["DB"];
  return { db, peak: () => peak };
}

afterEach(() => vi.unstubAllGlobals());

describe("Resend send timeout", () => {
  it("passes an AbortSignal to fetch and reports an abort as a thrown timeout", async () => {
    const briefing = await fetchComprehensiveBriefing({ DB: probeDb().db, CACHE: fakeKv() } as unknown as Env);
    const seen: Array<AbortSignal | null | undefined> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }));
    const env = { RESEND_API_KEY: "re_test", CACHE: fakeKv() } as unknown as Env;

    await expect(sendBriefingEmail(env, briefing, "t")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(RESEND_TIMEOUT_MS).toBeLessThan(30_000);
  });
});

describe("fetchMarketingVisibility read mode", () => {
  it("admin route (no guard): one Promise.all, unchanged", async () => {
    const p = probeDb();
    await fetchMarketingVisibility({ DB: p.db } as unknown as Env, 24);
    expect(p.peak()).toBe(9);
  });

  it("briefing (guard): one read at a time, each through the guard", async () => {
    const p = probeDb();
    const labels: string[] = [];
    await fetchMarketingVisibility({ DB: p.db } as unknown as Env, 24, {
      guard: (label, _fallback, read) => { labels.push(label); return read(); },
    });
    expect(p.peak()).toBe(1);
    expect(labels).toHaveLength(9);
    expect(labels[0]).toBe("marketing_human_views");
  });
});

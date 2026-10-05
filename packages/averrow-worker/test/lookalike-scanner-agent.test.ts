/**
 * agents/lookalike-scanner.ts — `itemsProcessed` is the real work count
 * (rows DNS-checked + pages analysed), no longer a hardcoded 0, and the
 * NRD matcher runs BEFORE the checker; the NRD archive back-check runs on
 * the just-seeded domains BEFORE the matcher, and not at all when nothing
 * was seeded.
 */
import { describe, it, expect, vi } from "vitest";

const calls: string[] = [];
const { seedSpy, checkSpy, pagesSpy, nrdSpy, backcheckSpy } = vi.hoisted(() => ({
  seedSpy: vi.fn(),
  checkSpy: vi.fn(),
  pagesSpy: vi.fn(),
  nrdSpy: vi.fn(),
  backcheckSpy: vi.fn(),
}));

vi.mock("../src/scanners/lookalike-domains", () => ({
  seedLookalikesForOrgBrands: seedSpy,
  checkLookalikeBatch: checkSpy,
  lookalikeCheckDefects: () => 0,
}));
vi.mock("../src/scanners/lookalike-page-analysis", () => ({ analyzeLookalikePages: pagesSpy }));
vi.mock("../src/lib/lookalike-nrd-matcher", () => ({ runLookalikeNrdMatch: nrdSpy }));
vi.mock("../src/lib/db", () => ({ getReadSession: () => ({}) }));
vi.mock("../src/lib/nrd-archive-backcheck", () => ({ runNrdArchiveBackcheck: backcheckSpy }));

const { lookalikeScannerAgent } = await import("../src/agents/lookalike-scanner");

describe("lookalike_scanner agent", () => {
  it("reports checked + analysed rows as itemsProcessed, NRD claims as itemsUpdated, matcher first", async () => {
    seedSpy.mockResolvedValue({ brands_seeded: 1, candidates_created: 30, new_domains: ["a-1.com", "a-2.com"] });
    backcheckSpy.mockImplementation(async () => {
      calls.push("backcheck");
      return {
        source: "lookalike", domains: 2, domains_dropped: 0, objects_scanned: 8, lines_scanned: 100,
        hits: 1, stored: 1, timed_out: false, object_errors: 0, skipped: null, error: null, duration_ms: 5,
      };
    });
    nrdSpy.mockImplementation(async () => {
      calls.push("nrd");
      return { windows: 1, hits: 2, claimed: 2, stale: 0, more_remaining: false, claim_errors: 0 };
    });
    checkSpy.mockImplementation(async () => {
      calls.push("check");
      return {
        checked: 50, new_registrations: 1, nrd_registrations: 2, registration_alerts: 3,
        registrations_lost: 0, mx_gained: 0, web_gained: 0, baselines_established: 10,
        baselines_suppressed: 9, bimi_alerts: 0, bimi_lookups: 0, mail_web_level_lifts: 0,
        alerts_withheld_below_floor: 0, checks_unresolved: 0, rows_parked: 0, rows_unparked: 0,
        row_errors: 0, bimi_alert_errors: 0, bimi_claim_release_failures: 0,
        cooldown_stamp_failures: 0, inline_page_errors: 0,
      };
    });
    pagesSpy.mockResolvedValue({ analyzed: 7, escalated: 0, credential_harvest: 0, alerts_raised: 0, alert_cap_hit: false });

    const r = await lookalikeScannerAgent.execute({ env: {} } as never);

    expect(r.itemsProcessed).toBe(57);
    expect(r.itemsUpdated).toBe(2);
    expect(r.itemsCreated).toBe(30);
    expect(calls).toEqual(["backcheck", "nrd", "check"]);
    expect(backcheckSpy).toHaveBeenCalledWith({}, ["a-1.com", "a-2.com"], "lookalike");
    // The seed diagnostic does not carry the domain list.
    const seedOut = r.agentOutputs?.find((o) => o.summary.startsWith("Seeded lookalike candidates"));
    expect(seedOut?.details).toEqual({ brands_seeded: 1, candidates_created: 30 });
    expect(r.agentOutputs?.some((o) => o.summary.startsWith("NRD archive back-check: 2 seeded domain(s), 1 found"))).toBe(true);
  });

  it("skips the back-check when nothing was seeded", async () => {
    calls.length = 0;
    backcheckSpy.mockClear();
    seedSpy.mockResolvedValue({ brands_seeded: 0, candidates_created: 0, new_domains: [] });

    await lookalikeScannerAgent.execute({ env: {} } as never);

    expect(backcheckSpy).not.toHaveBeenCalled();
    expect(calls).toEqual(["nrd", "check"]);
  });
});

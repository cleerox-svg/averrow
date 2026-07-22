/**
 * Regression coverage for the prod-deploy fragility in
 * scripts/verify-db-seed.ts (db:verify:prod).
 *
 * The original runQuery ran each seed assertion as a single un-retried
 * execSync. When the FIRST remote D1 call flaked with a transient
 * non-zero exit, execSync threw, the assertion reported "(query failed)",
 * and the whole prod deploy aborted — even though the data was fine.
 *
 * The fix adds retry-with-backoff around the exec, but ONLY for transient
 * infra failures (exec throw / unparseable output). A query that SUCCEEDS
 * but returns a below-threshold count is a genuine seed-missing failure and
 * must NOT be retried or masked. These tests pin all three behaviors.
 */

import { describe, it, expect, vi } from "vitest";
import { runQuery, type ExecFn } from "../scripts/verify-db-seed";

const VALID_N1 = JSON.stringify([{ results: [{ n: 1 }] }]);
const VALID_N0 = JSON.stringify([{ results: [{ n: 0 }] }]);
const QUERY = "SELECT COUNT(*) AS n FROM organizations WHERE slug = '_averrow_platform'";

// Zero-wait sleep + tight backoff so tests don't actually pause.
const testOpts = { sleep: () => {}, backoffMs: [0, 0], maxAttempts: 3 };

describe("verify-db-seed runQuery retry resilience", () => {
  it("retries a transient exec failure and returns the correct count (the deploy-abort bug, fixed)", () => {
    let calls = 0;
    const flakyExec: ExecFn = () => {
      calls += 1;
      if (calls === 1) throw new Error("Command failed: wrangler d1 execute ... exit code 1");
      return VALID_N1;
    };

    const got = runQuery(QUERY, { ...testOpts, exec: flakyExec });

    expect(got).toBe(1);
    expect(calls).toBe(2); // failed once, retried once, succeeded
  });

  it("retries when exec succeeds but returns unparseable/non-numeric output", () => {
    let calls = 0;
    const flakyExec: ExecFn = () => {
      calls += 1;
      if (calls === 1) return "▲ [WARNING] partial pipe, not json";
      return VALID_N1;
    };

    const got = runQuery(QUERY, { ...testOpts, exec: flakyExec });

    expect(got).toBe(1);
    expect(calls).toBe(2);
  });

  it("still throws (fails the deploy) when every attempt fails — a real outage is not masked", () => {
    let calls = 0;
    const alwaysFails: ExecFn = () => {
      calls += 1;
      throw new Error("Command failed: wrangler d1 execute ... exit code 1");
    };

    expect(() => runQuery(QUERY, { ...testOpts, exec: alwaysFails })).toThrow(/exit code 1/);
    expect(calls).toBe(3); // exhausted all attempts, then re-threw
  });

  it("does NOT retry (or mask) a successful query that returns a below-threshold count", () => {
    const exec = vi.fn<ExecFn>(() => VALID_N0);

    const got = runQuery(QUERY, { ...testOpts, exec });

    // A genuine seed-missing result: returned verbatim on the FIRST attempt.
    // main() compares got >= min and fails loudly; the retry loop must not
    // hide it by re-querying.
    expect(got).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

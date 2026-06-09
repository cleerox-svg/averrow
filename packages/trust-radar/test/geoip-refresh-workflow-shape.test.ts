/**
 * Regression test for the GeoipRefresh workflow's 1 MiB step-output cap.
 *
 * Cloudflare Workflows enforce a hard 1 MiB cap on each step's
 * serialized return value. Production 2026-05-04 hit
 * `WorkflowInternalError: Step import-locations-1 output is too
 * large. Maximum allowed size is 1MiB.` because the original design
 * returned a `Record<geonameId, LocationRow>` (~22 MB serialized)
 * from a dedicated "import-locations" step so a separate
 * "import-blocks" step could reuse it. Every refresh attempt failed
 * — `geo_ip_ranges` was never populated.
 *
 * The fix merges Locations + Blocks into a single `import` step.
 * The Locations Map lives entirely inside that step's closure (held
 * in Worker memory, never serialized across step boundaries) and
 * the step returns only counters.
 *
 * These tests are intentionally source-level — testing the actual
 * workflow runtime would need the Cloudflare Workflows engine,
 * which is not available in vitest. Source-level checks pin the
 * architectural invariant so any future PR that reintroduces a
 * cap-busting return path will fail CI.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WORKFLOW_PATH = resolve(__dirname, "../src/workflows/geoipRefresh.ts");
const source = readFileSync(WORKFLOW_PATH, "utf-8");

describe("GeoipRefreshWorkflow — 1 MiB step-output invariant", () => {
  it("does not declare an `import-locations` step (the cap-busting pattern)", () => {
    // The pre-2026-05-04 design had `step.do('import-locations', ...)`
    // returning a Record<string, LocationRow> across a step boundary —
    // ~22 MB serialized, blowing past the 1 MiB cap on every run.
    expect(source).not.toMatch(/step\.do\(\s*['"]import-locations['"]/);
  });

  it("does not declare a separate `import-blocks` step (relies on shared Locations map)", () => {
    // The companion step that consumed the leaked Locations map.
    // Removing both proves the merge is the single source of truth.
    expect(source).not.toMatch(/step\.do\(\s*['"]import-blocks['"]/);
  });

  it("declares exactly one `import` step that owns both Locations and Blocks", () => {
    // The merged step. The Locations Map lives inside this step's
    // closure — held in Worker memory, never serialized as a step
    // return value.
    const matches = source.match(/step\.do\(\s*['"]import['"]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("does not return Locations data from any workflow step", () => {
    // Catches regressions where a future step returns `{ locations: ... }`
    // (Map or Record). The Locations data must stay in step-local
    // memory; never cross the step boundary.
    //
    // We allow the word "locations" inside comments and inside the
    // import step's body (where the Map is built and used in-place);
    // we forbid it appearing in a `return { ... locations: ... }`
    // shape OR a `Promise<{ ... locations: ... }>` type annotation.
    expect(source).not.toMatch(/return\s*\{\s*[^}]*\blocations\s*:/);
    expect(source).not.toMatch(/Promise<\s*\{\s*[^}]*\blocations\s*:/);
  });

  it("does not import `LocationRow` or `HttpZipMetadata` (signs of cross-step state)", () => {
    // These types only mattered when state had to flow between
    // steps. After the merge they're inlined locally.
    expect(source).not.toMatch(/\bLocationRow\b/);
    expect(source).not.toMatch(/\bHttpZipMetadata\b/);
  });

  // ── Diff-only import (write-budget remediation 2026-06-09) ──
  it("declares the diff/full mode branch steps", () => {
    // The workflow chooses in-place diff (write only deltas) vs a full
    // shadow rebuild. Guard the step names that implement that branch so
    // a future refactor can't silently drop the cheap path.
    expect(source).toMatch(/step\.do\(\s*['"]decide-mode['"]/);
    expect(source).toMatch(/step\.do\(\s*['"]diff-apply['"]/);
    expect(source).toMatch(/step\.do\(\s*['"]finalize-diff['"]/);
  });

  it("keeps the diff path inside the 1 MiB step-output invariant", () => {
    // diff-apply must not return the Locations map either — same cap that
    // sank the old import-locations step. It returns only counters.
    expect(source).not.toMatch(/step\.do\(\s*['"]import-locations['"]/);
    // The diff helper builds its own Locations map inside the helper's
    // closure (lib/geoip-import.ts), never across a workflow step.
    expect(source).not.toMatch(/return\s*\{\s*[^}]*\blocations\s*:/);
  });
});

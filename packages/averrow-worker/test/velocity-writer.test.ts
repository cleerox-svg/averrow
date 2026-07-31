/**
 * REC 5 — coverage for the weaponization-velocity D1 glue layer
 * (`lib/velocity-writer.ts`), mirroring the house pattern in
 * test/phishing-pattern-writer.test.ts (see that file's header comment).
 *
 * This package has no SQLite engine in devDeps (no better-sqlite3 /
 * miniflare D1 harness — confirmed via package.json: only `vitest` +
 * `wrangler`, no `@cloudflare/vitest-pool-workers` or similar). So this
 * suite covers exactly what's testable without a live DB:
 *
 *   1. The pure, D1-free helpers: clampLimit / clampOffset bounds.
 *   2. Static source assertions for the doctrine invariant that the
 *      writer only PERSISTS the velocity attribute and never wires it
 *      into an alert-triage / alert-ai-judge gating decision.
 *
 * Full D1 integration (computeVelocityDryRun, runVelocityBackfill against
 * a real `threats` table) is explicitly DEFERRED to qa-verifier's
 * end-to-end run against a live/local D1 instance — see the test-engineer
 * task report. Introducing a new SQLite/miniflare devDependency to cover
 * that here would be out of scope for this pass.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clampLimit,
  clampOffset,
  VELOCITY_BACKFILL_DEFAULT_LIMIT,
  VELOCITY_BACKFILL_MAX_LIMIT,
} from "../src/lib/velocity-writer";

const writerPath = fileURLToPath(new URL("../src/lib/velocity-writer.ts", import.meta.url));
const writerSrc = readFileSync(writerPath, "utf8");

// ═══════════════════════════════════════════════════════════════════════
// clampLimit / clampOffset — pure bounds (identical contract to the
// phishing-pattern-writer helpers of the same name)
// ═══════════════════════════════════════════════════════════════════════

describe("clampLimit", () => {
  it("defaults to VELOCITY_BACKFILL_DEFAULT_LIMIT (500) when null", () => {
    expect(clampLimit(null)).toBe(VELOCITY_BACKFILL_DEFAULT_LIMIT);
    expect(clampLimit(null)).toBe(500);
  });

  it("defaults when undefined", () => {
    expect(clampLimit(undefined)).toBe(500);
  });

  it("defaults when NaN / non-finite", () => {
    expect(clampLimit(NaN)).toBe(500);
    expect(clampLimit(Infinity)).toBe(500);
    expect(clampLimit(-Infinity)).toBe(500);
  });

  it("passes through an in-range value unchanged", () => {
    expect(clampLimit(200)).toBe(200);
  });

  it("floors a fractional value", () => {
    expect(clampLimit(200.9)).toBe(200);
  });

  it("clamps up to 1 when given 0", () => {
    expect(clampLimit(0)).toBe(1);
  });

  it("clamps up to 1 when given a negative value", () => {
    expect(clampLimit(-50)).toBe(1);
  });

  it("passes through the exact floor boundary (1)", () => {
    expect(clampLimit(1)).toBe(1);
  });

  it("passes through the exact cap boundary (VELOCITY_BACKFILL_MAX_LIMIT = 1000)", () => {
    expect(clampLimit(1000)).toBe(1000);
    expect(VELOCITY_BACKFILL_MAX_LIMIT).toBe(1000);
  });

  it("clamps a value one past the cap (1001) down to 1000", () => {
    expect(clampLimit(1001)).toBe(1000);
  });

  it("clamps a very large value down to the cap", () => {
    expect(clampLimit(1_000_000)).toBe(1000);
  });
});

describe("clampOffset", () => {
  it("defaults to 0 when null", () => {
    expect(clampOffset(null)).toBe(0);
  });

  it("defaults to 0 when undefined", () => {
    expect(clampOffset(undefined)).toBe(0);
  });

  it("defaults to 0 when NaN / non-finite", () => {
    expect(clampOffset(NaN)).toBe(0);
    expect(clampOffset(Infinity)).toBe(0);
  });

  it("passes through a positive value unchanged", () => {
    expect(clampOffset(250)).toBe(250);
  });

  it("floors a fractional value", () => {
    expect(clampOffset(250.7)).toBe(250);
  });

  it("floors a negative value up to 0 (no upper cap, unlike limit)", () => {
    expect(clampOffset(-100)).toBe(0);
  });

  it("has no upper cap — a very large offset passes through", () => {
    expect(clampOffset(10_000_000)).toBe(10_000_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Doctrine guard: the writer only PERSISTS the velocity attribute — it
// must never wire weaponization_hours/flag into an alert-triage /
// alert-ai-judge dismissal decision (spec §3, doctrine §3.1, restated in
// the module's own header comment).
// ═══════════════════════════════════════════════════════════════════════

describe("velocity-writer never gates alert-triage / alert-ai-judge (metadata-only doctrine)", () => {
  it("the module does not import lib/alert-triage or lib/alert-ai-judge", () => {
    expect(writerSrc).not.toMatch(/from\s+['"].*lib\/alert-triage['"]/);
    expect(writerSrc).not.toMatch(/from\s+['"].*lib\/alert-ai-judge['"]/);
  });

  it("the UPDATE statement's column list is exactly the two velocity columns (no dismissal/status column)", () => {
    // Anchor to the actual UPDATE_SQL template literal, not the prose
    // description of it in the module's header comment (which also
    // contains the literal string "UPDATE threats ... SET ... WHERE").
    const sqlMatch = writerSrc.match(/const UPDATE_SQL = `([\s\S]*?)`;/);
    expect(sqlMatch, "UPDATE_SQL template literal not found in writer source").toBeTruthy();
    const updateMatch = sqlMatch![1].match(/UPDATE threats\s+SET([\s\S]*?)WHERE/);
    expect(updateMatch, "UPDATE threats ... SET not found inside UPDATE_SQL").toBeTruthy();
    const setClause = updateMatch![1];
    expect(setClause).toMatch(/\bweaponization_hours\s*=\s*\?/);
    expect(setClause).toMatch(/\bweaponization_flag\s*=\s*\?/);
    expect(setClause).not.toMatch(/\bstatus\s*=/);
    expect(setClause).not.toMatch(/\bresolution_notes\s*=/);
  });

  it("writes never go through the read-replica handle — env.DB is the only write target", () => {
    expect(writerSrc).toContain("env.DB.prepare(UPDATE_SQL)");
    expect(writerSrc).toContain("env.DB.batch(");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Zero-AI guard (rec 5 is pure SQL/arithmetic, same doctrine as rec 4)
// ═══════════════════════════════════════════════════════════════════════

describe("zero-AI import graph", () => {
  it("the writer imports no AI helper and does not reference env.AI", () => {
    expect(writerSrc).not.toMatch(/from\s+['"].*lib\/anthropic['"]/);
    expect(writerSrc).not.toMatch(/from\s+['"].*lib\/haiku['"]/);
    expect(writerSrc).not.toMatch(/\benv\.AI\b/);
  });
});

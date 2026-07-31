/**
 * W2.4 — coverage for the phantom-squat watchlist's post-pass matcher
 * (`lib/phantom-matcher.ts`, W2.3), per the W2.0 design spec §6 (hit
 * semantics) and §7 (post-pass match constraint).
 *
 * `clampMatchLimit` is pure and unit-tested directly (table-driven,
 * mirrors `clampLimit`/`clampOffset` in `test/phishing-pattern-writer.test.ts`).
 *
 * This package has no SQLite/miniflare D1 harness (confirmed by the prior
 * wave's `test/phishing-pattern-writer.test.ts` note and re-checked here —
 * no better-sqlite3 / miniflare devDependency), so `runPhantomMatch`'s
 * actual join/flip/alert behavior against real rows is explicitly DEFERRED
 * to qa-verifier's end-to-end run against a live/local D1 instance.
 *
 * What CAN be verified without a live DB — and is the highest-value,
 * cheapest-to-break contract here — is that the source code structurally
 * enforces the spec's non-negotiable invariants:
 *   - §0/§6: the module never inserts into `threats` (a phantom is a
 *     prediction, never manufactured into a threat by the matcher either).
 *   - §6.4: the status-flip UPDATE is guarded by `WHERE ... AND
 *     status = 'predicted'` so the alert-creating transition can fire
 *     AT MOST ONCE per phantom row (the row-state IS the dedup key).
 *   - §6.2: the hit alert's severity is hardcoded to `'low'` regardless of
 *     the reused alert_type's own default severity.
 *   - §6.1: only the two already-existing alert types are reused
 *     (`lookalike_domain_active`, `ct_certificate_issued`) — no new type.
 *   - §6.3: a `null` return from `createAlert` (NX2 tier gate) is tolerated
 *     — the flip stands, only a non-null id gets stamped/counted.
 *
 * These are grep-style static assertions against the real source, same
 * house pattern as `test/phishing-pattern-writer.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clampMatchLimit } from "../src/lib/phantom-matcher";

const matcherPath = fileURLToPath(new URL("../src/lib/phantom-matcher.ts", import.meta.url));
const matcherSrc = readFileSync(matcherPath, "utf8");

// ═══════════════════════════════════════════════════════════════════════
// clampMatchLimit — pure bounds (spec: clamped 1..5000, default 500)
// ═══════════════════════════════════════════════════════════════════════

describe("clampMatchLimit", () => {
  it("defaults to 500 when undefined", () => {
    expect(clampMatchLimit(undefined)).toBe(500);
  });

  it("defaults to 500 when NaN / non-finite", () => {
    expect(clampMatchLimit(NaN)).toBe(500);
    expect(clampMatchLimit(Infinity)).toBe(500);
    expect(clampMatchLimit(-Infinity)).toBe(500);
  });

  it("passes through an in-range value unchanged", () => {
    expect(clampMatchLimit(250)).toBe(250);
  });

  it("floors a fractional value", () => {
    expect(clampMatchLimit(10.9)).toBe(10);
  });

  it("clamps up to the floor (1) when given 0", () => {
    expect(clampMatchLimit(0)).toBe(1);
  });

  it("clamps up to the floor (1) when given a negative value", () => {
    expect(clampMatchLimit(-50)).toBe(1);
  });

  it("passes through the exact floor boundary (1)", () => {
    expect(clampMatchLimit(1)).toBe(1);
  });

  it("passes through the exact cap boundary (5000)", () => {
    expect(clampMatchLimit(5000)).toBe(5000);
  });

  it("clamps a value one past the cap (5001) down to 5000", () => {
    expect(clampMatchLimit(5001)).toBe(5000);
  });

  it("clamps a very large value down to the cap", () => {
    expect(clampMatchLimit(1_000_000)).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §0/§6 guard: the matcher NEVER inserts into `threats`
// ═══════════════════════════════════════════════════════════════════════

describe("phantom-matcher never inserts into threats (spec §0/§6 governing invariant)", () => {
  it("the source contains no INSERT INTO threats", () => {
    expect(matcherSrc).not.toMatch(/INSERT INTO threats\b/i);
  });

  it("the source contains no UPDATE ... threats write path either", () => {
    expect(matcherSrc).not.toMatch(/UPDATE threats\b/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §6.4 guard: the claim UPDATE is guarded by status='predicted' — the
// at-most-once transition IS the alert dedup key.
// ═══════════════════════════════════════════════════════════════════════

describe("guarded status='predicted' claim transition (spec §6.4 at-most-once)", () => {
  it("the phantom_domains claim UPDATE's WHERE clause requires status = 'predicted'", () => {
    const claimMatch = matcherSrc.match(
      /UPDATE phantom_domains\s+SET status = 'registered'[\s\S]*?WHERE id = \? AND status = 'predicted'/,
    );
    expect(claimMatch, "guarded claim UPDATE not found in matcher source").toBeTruthy();
  });

  it("a zero-changes claim result is treated as an idempotent no-op (no alert fires)", () => {
    // The code path: `if (!claim.meta?.changes || claim.meta.changes === 0) { continue; }`
    // BEFORE result.matched++ and BEFORE createAlert is ever called.
    const guardIdx = matcherSrc.indexOf("claim.meta?.changes");
    const matchedIdx = matcherSrc.indexOf("result.matched++");
    const createAlertIdx = matcherSrc.indexOf("await createAlert(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(matchedIdx).toBeGreaterThan(-1);
    expect(createAlertIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(matchedIdx);
    expect(matchedIdx).toBeLessThan(createAlertIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §6.1/§6.2 guard: reused alert types only, severity hardcoded to 'low'
// ═══════════════════════════════════════════════════════════════════════

describe("reused alert types + hardcoded 'low' severity (spec §6.1/§6.2)", () => {
  it("SOURCE_CONFIG reuses exactly the two documented alert types, no new type", () => {
    expect(matcherSrc).toMatch(/alertType:\s*"lookalike_domain_active"/);
    expect(matcherSrc).toMatch(/alertType:\s*"ct_certificate_issued"/);
  });

  it("nrd and lookalike sources both map to lookalike_domain_active; ct maps to ct_certificate_issued", () => {
    const nrdBlock = matcherSrc.match(/nrd:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    const ctBlock = matcherSrc.match(/ct:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    const lookalikeBlock = matcherSrc.match(/lookalike:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    expect(nrdBlock).toMatch(/alertType:\s*"lookalike_domain_active"/);
    expect(ctBlock).toMatch(/alertType:\s*"ct_certificate_issued"/);
    expect(lookalikeBlock).toMatch(/alertType:\s*"lookalike_domain_active"/);
  });

  it("the createAlert call passes severity: \"low\" as a literal, not a variable", () => {
    const callMatch = matcherSrc.match(/createAlert\(env\.DB,\s*\{[\s\S]*?\}\)/);
    expect(callMatch, "createAlert call not found").toBeTruthy();
    expect(callMatch![0]).toMatch(/severity:\s*"low"/);
  });

  it("the createAlert call leaves orgId unset (phantom hits are brand-wide, not org-private)", () => {
    const callMatch = matcherSrc.match(/createAlert\(env\.DB,\s*\{[\s\S]*?\}\)/);
    expect(callMatch![0]).not.toMatch(/orgId:/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §6.3 guard: a null createAlert return (NX2 tier gate) is tolerated
// ═══════════════════════════════════════════════════════════════════════

describe("tolerates createAlert returning null (spec §6.3 NX2 tier gate)", () => {
  it("alertId is only stamped/counted inside an `if (alertId)` guard", () => {
    expect(matcherSrc).toMatch(/if\s*\(alertId\)\s*\{/);
  });

  it("the alert_id UPDATE and result.alerted++ both live inside that guard, after the claim UPDATE", () => {
    const guardBlock = matcherSrc.match(/if\s*\(alertId\)\s*\{[\s\S]*?\n\s*\}/)?.[0] ?? "";
    expect(guardBlock).toContain("result.alerted++");
    expect(guardBlock).toMatch(/UPDATE phantom_domains\s+SET alert_id = \?/);
  });

  it("createAlert failures are caught and degrade to a null alertId rather than throwing (non-fatal)", () => {
    const tryBlock = matcherSrc.match(/try\s*\{[\s\S]*?alertId = await createAlert[\s\S]*?\}\s*catch\s*\{[\s\S]*?alertId = null;[\s\S]*?\}/);
    expect(tryBlock, "try/catch around createAlert with alertId = null fallback not found").toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §7 guard: set-based join per source, driven from phantom_domains, status
// filter present, and only bound-parameter interpolation for cursor/limit.
// ═══════════════════════════════════════════════════════════════════════

describe("set-based join shape (spec §7 post-pass constraint)", () => {
  it("the per-source SELECT filters on phantom_domains p.status = 'predicted'", () => {
    expect(matcherSrc).toMatch(/WHERE p\.status = 'predicted'/);
  });

  it("all three sources (nrd, ct, lookalike) are represented in SOURCE_CONFIG", () => {
    expect(matcherSrc).toMatch(/nrd:\s*\{/);
    expect(matcherSrc).toMatch(/ct:\s*\{/);
    expect(matcherSrc).toMatch(/lookalike:\s*\{/);
  });

  it("runPhantomMatch defaults to scanning all three sources when none is specified", () => {
    const block = matcherSrc.match(/const sources: PhantomMatchSource\[\] =[\s\S]*?;/)?.[0] ?? "";
    expect(block).toMatch(/\["nrd", "ct", "lookalike"\]/);
  });

  it("pins SQLite join order with CROSS JOIN so the small phantom side drives the scan (code-review #5)", () => {
    // CROSS JOIN forces phantom_domains p as the OUTER/driver table; a plain
    // JOIN would let the planner reorder and scan the millions-row source.
    expect(matcherSrc).toContain("CROSS JOIN ${cfg.table} t ON t.domain = p.domain");
    // The FROM must be phantom_domains (the small side) and there must be no
    // un-pinned inner `JOIN ${cfg.table}`.
    expect(matcherSrc).toContain("FROM phantom_domains p");
    expect(matcherSrc).not.toMatch(/(?<!CROSS )JOIN \$\{cfg\.table\} t ON/);
  });

  it("appends the per-source residual (cfg.extraWhere) into the join WHERE", () => {
    expect(matcherSrc).toContain("cfg.extraWhere");
    expect(matcherSrc).toContain("AND t.${cfg.cursorCol} >= ?");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Finding 1 (ship-blocker): the lookalike source must gate on registered=1
// so a predicted phantom only fires on a REAL registration, not on an
// unregistered permutation candidate. nrd/ct are genuine observations and
// carry NO such gate.
// ═══════════════════════════════════════════════════════════════════════

describe("lookalike source gates on registered=1 (Finding 1 ship-blocker)", () => {
  it("the lookalike SOURCE_CONFIG entry sets extraWhere to ' AND t.registered = 1 '", () => {
    const lookalikeBlock = matcherSrc.match(/lookalike:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    expect(lookalikeBlock).toMatch(/extraWhere:\s*" AND t\.registered = 1 "/);
  });

  it("neither nrd nor ct carries a registered/status gate — they are genuine observations", () => {
    const nrdBlock = matcherSrc.match(/nrd:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    const ctBlock = matcherSrc.match(/ct:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    expect(nrdBlock).toMatch(/extraWhere:\s*""/);
    expect(ctBlock).toMatch(/extraWhere:\s*""/);
    // No SQL `registered = 1` gate on the genuine-observation sources (the
    // word "registered" may still appear in prose, e.g. "registered_date").
    expect(nrdBlock).not.toMatch(/registered\s*=\s*1/);
    expect(ctBlock).not.toMatch(/registered\s*=\s*1/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Finding 2 (ship-blocker): the incremental cursor must key on an
// INGESTION-time column (created_at, monotonic), NOT the row's intrinsic
// date (registered_date / not_before, which are backdated / non-monotonic
// and would exclude late-ingested rows forever).
// ═══════════════════════════════════════════════════════════════════════

describe("cursor keyed on ingestion-time created_at, not intrinsic date (Finding 2 ship-blocker)", () => {
  it("all three sources cursor on created_at", () => {
    const nrdBlock = matcherSrc.match(/nrd:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    const ctBlock = matcherSrc.match(/ct:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    const lookalikeBlock = matcherSrc.match(/lookalike:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    expect(nrdBlock).toMatch(/cursorCol:\s*"created_at"/);
    expect(ctBlock).toMatch(/cursorCol:\s*"created_at"/);
    expect(lookalikeBlock).toMatch(/cursorCol:\s*"created_at"/);
  });

  it("no source cursors on the non-monotonic intrinsic dates registered_date / not_before", () => {
    expect(matcherSrc).not.toMatch(/cursorCol:\s*"registered_date"/);
    expect(matcherSrc).not.toMatch(/cursorCol:\s*"not_before"/);
  });
});

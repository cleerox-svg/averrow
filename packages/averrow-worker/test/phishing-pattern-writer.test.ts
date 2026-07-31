/**
 * W1.7 — coverage for the AI-phishing phase-1 D1 glue layer
 * (`lib/phishing-pattern-writer.ts`, W1.5), per the W1.0 phase-1
 * measurement spec §0.3 enforcement list + §11.
 *
 * This package has no SQLite engine in devDeps (no better-sqlite3 /
 * miniflare D1 harness — checked package.json, confirmed by the existing
 * house pattern in test/brand-threat-correlator-schema-contract.test.ts and
 * test/diagnostics-hours-clamp.test.ts). So this suite covers exactly what
 * the task brief calls for when no D1 harness exists:
 *
 *   1. The pure, D1-free helpers: clampLimit / clampOffset bounds.
 *   2. Static source assertions for the two remaining §0.3 enforcement
 *      guards that don't need a live DB to check:
 *      - the writer's INSERT column list never contains
 *        `ai_generated_probability` (grep-style, against the real source),
 *      - the module's import graph contains no `lib/anthropic`,
 *        `lib/haiku`, `env.AI`, or `fetch(` (zero-AI / zero-egress, §0.2
 *        rules 2-3), checked against BOTH the writer and the pure core it
 *        wraps.
 *
 * Full D1 integration (computePhishingCorpusStats, runPhishingSignalWriter,
 * runPhishingCampaignRollup, refineTemplateDetected against a real
 * phishing_pattern_signals table) is explicitly DEFERRED to qa-verifier's
 * end-to-end run against a live/local D1 instance — see the test-engineer
 * task report for W1.7. Introducing a new SQLite/miniflare devDependency to
 * cover that here would be out of scope for this pass.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clampLimit,
  clampOffset,
  PHISHING_BACKFILL_DEFAULT_LIMIT,
  PHISHING_BACKFILL_MAX_LIMIT,
} from "../src/lib/phishing-pattern-writer";

const writerPath = fileURLToPath(new URL("../src/lib/phishing-pattern-writer.ts", import.meta.url));
const corePath = fileURLToPath(new URL("../src/lib/phishing-pattern-signals.ts", import.meta.url));
const writerSrc = readFileSync(writerPath, "utf8");
const coreSrc = readFileSync(corePath, "utf8");

// ═══════════════════════════════════════════════════════════════════════
// clampLimit / clampOffset — pure bounds
// ═══════════════════════════════════════════════════════════════════════

describe("clampLimit", () => {
  it("defaults to PHISHING_BACKFILL_DEFAULT_LIMIT (500) when null", () => {
    expect(clampLimit(null)).toBe(PHISHING_BACKFILL_DEFAULT_LIMIT);
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

  it("passes through the exact cap boundary (PHISHING_BACKFILL_MAX_LIMIT = 1000)", () => {
    expect(clampLimit(1000)).toBe(1000);
    expect(PHISHING_BACKFILL_MAX_LIMIT).toBe(1000);
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

  it("floors a negative value up to 0 (no negative offsets, unlike limit there is no upper cap)", () => {
    expect(clampOffset(-100)).toBe(0);
  });

  it("has no upper cap — a very large offset passes through", () => {
    expect(clampOffset(10_000_000)).toBe(10_000_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Endpoint limit/offset derivation — an ABSENT ?limit must default to 500,
// NOT 1 (regression: Number(null)===0 → clampLimit(0)===1 processed one row).
// Mirrors the parse expression in routes/admin.ts for both phishing-signals
// endpoints (/backfill and /rollup).
// ═══════════════════════════════════════════════════════════════════════

// The exact derivation both endpoints use: presence-gate the param so an
// omitted value passes `undefined` (default branch) instead of Number(null)===0.
const deriveLimit = (url: URL): number =>
  clampLimit(url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined);
const deriveOffset = (url: URL): number =>
  clampOffset(url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined);

describe("endpoint limit/offset derivation (routes/admin.ts phishing-signals)", () => {
  it("an ABSENT ?limit defaults to 500, not 1", () => {
    const url = new URL("https://x/api/admin/phishing-signals/backfill");
    expect(url.searchParams.has("limit")).toBe(false);
    expect(deriveLimit(url)).toBe(500);
  });

  it("an explicit in-range ?limit passes through", () => {
    expect(deriveLimit(new URL("https://x/api?limit=200"))).toBe(200);
  });

  it("an explicit ?limit=0 still clamps up to 1 (explicit floor, not the default)", () => {
    expect(deriveLimit(new URL("https://x/api?limit=0"))).toBe(1);
  });

  it("a non-numeric ?limit=abc falls back to the 500 default", () => {
    expect(deriveLimit(new URL("https://x/api?limit=abc"))).toBe(500);
  });

  it("an ABSENT ?offset defaults to 0", () => {
    expect(deriveOffset(new URL("https://x/api"))).toBe(0);
  });

  it("an explicit ?offset passes through", () => {
    expect(deriveOffset(new URL("https://x/api?offset=250"))).toBe(250);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §0.3 guard: the writer's INSERT/UPDATE column lists never mention
// ai_generated_probability
// ═══════════════════════════════════════════════════════════════════════

describe("writer SQL never writes ai_generated_probability (spec §0.2 rule 1 / §0.3)", () => {
  it("the per-capture INSERT statement's column list omits ai_generated_probability", () => {
    const insertMatch = writerSrc.match(/INSERT INTO phishing_pattern_signals \(([\s\S]*?)\)\s*VALUES/);
    expect(insertMatch, "INSERT INTO phishing_pattern_signals not found in writer source").toBeTruthy();
    const columnList = insertMatch![1];
    expect(columnList).not.toMatch(/\bai_generated_probability\b/);
  });

  it("the per-capture ON CONFLICT DO UPDATE SET clause omits ai_generated_probability", () => {
    const conflictMatch = writerSrc.match(
      /ON CONFLICT\(capture_id\) DO UPDATE SET([\s\S]*?)`;/,
    );
    expect(conflictMatch, "ON CONFLICT(capture_id) DO UPDATE clause not found").toBeTruthy();
    expect(conflictMatch![1]).not.toMatch(/\bai_generated_probability\b/);
  });

  it("the campaign_pattern_stats INSERT statement has no ai_generated_probability / ai_score / ai_likelihood column at all", () => {
    const statsInsertMatch = writerSrc.match(/INSERT INTO campaign_pattern_stats \(([\s\S]*?)\)\s*VALUES/);
    expect(statsInsertMatch, "INSERT INTO campaign_pattern_stats not found in writer source").toBeTruthy();
    const columnList = statsInsertMatch![1];
    expect(columnList).not.toMatch(/ai_generated_probability|ai_score|ai_likelihood/);
  });

  it("no bound parameter in the writer is a PerCaptureSignals.ai_generated_probability reference (belt-and-braces: the field is never even read)", () => {
    expect(writerSrc).not.toMatch(/s\.ai_generated_probability/);
    expect(writerSrc).not.toMatch(/signals\.ai_generated_probability/);
  });

  it("the writer calls assertEvidenceOnly on every measured row before persisting", () => {
    expect(writerSrc).toContain("assertEvidenceOnly(signals)");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §0.2 rules 2-3 guard: zero AI, zero network egress in the import graph
// ═══════════════════════════════════════════════════════════════════════

describe("zero-AI / zero-egress import graph (spec §0.2 rules 2-3 / §0.3)", () => {
  it("the writer module imports no AI helper (lib/anthropic, lib/haiku) and does not reference env.AI", () => {
    expect(writerSrc).not.toMatch(/from\s+['"].*lib\/anthropic['"]/);
    expect(writerSrc).not.toMatch(/from\s+['"].*lib\/haiku['"]/);
    expect(writerSrc).not.toMatch(/\benv\.AI\b/);
  });

  it("the writer module makes no network calls (no bare fetch(...))", () => {
    expect(writerSrc).not.toMatch(/(?<!\.)\bfetch\(/);
  });

  it("the pure measurement core imports no AI helper and does not reference env.AI", () => {
    expect(coreSrc).not.toMatch(/from\s+['"].*lib\/anthropic['"]/);
    expect(coreSrc).not.toMatch(/from\s+['"].*lib\/haiku['"]/);
    expect(coreSrc).not.toMatch(/\benv\.AI\b/);
  });

  it("the pure measurement core makes no network calls (no bare fetch(...)) — its only async op is the local crypto.subtle.digest for mail_server_fingerprint", () => {
    expect(coreSrc).not.toMatch(/(?<!\.)\bfetch\(/);
    expect(coreSrc).toContain("crypto.subtle.digest");
  });

  it("the pure core never imports `env` or a D1 type — it is genuinely pure, no DB handle threaded through it", () => {
    expect(coreSrc).not.toMatch(/from\s+['"]\.\.\/types['"]/);
    expect(coreSrc).not.toMatch(/D1Database/);
  });
});

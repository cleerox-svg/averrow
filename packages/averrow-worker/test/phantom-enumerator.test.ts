/**
 * W2.4 — coverage for the `phantom_enumerator` agent (W2.2), per the W2.0
 * design spec's governing invariant (§0/§6/§7): "a phantom is a
 * PREDICTION, not a threat." Enumeration must write ONLY `phantom_domains`
 * rows at status='predicted' — it must NEVER call `createAlert` and NEVER
 * insert into `threats`.
 *
 * This package has no SQLite/miniflare D1 harness (see the note in
 * `test/phishing-pattern-writer.test.ts`, re-confirmed for this wave), so
 * the actual brand-selection query / Haiku call / D1 write loop is
 * explicitly DEFERRED to qa-verifier's end-to-end run against a live/local
 * D1 instance. This suite covers everything checkable without a live DB:
 *
 *   1. The AgentModule's static declaration (trigger, budget, costGuard,
 *      reads/writes) — a plain object, safe to import and assert on
 *      directly, no execute() invocation needed.
 *   2. Source-contract guards mirroring the prior wave's zero-AI/zero-write
 *      pattern, inverted here: this agent MUST have zero alert/threat
 *      writes rather than zero AI (the AI call is the whole point of this
 *      one) — grep-style, against the real source.
 *   3. The idempotency-key stability requirement (spec §1.5): the prompt
 *      body (system + user message content) must carry no Date/timestamp/
 *      runId/random-nonce interpolation, so `callAnthropic`'s default
 *      idempotency key stays stable across within-run retries.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { phantomEnumeratorAgent } from "../src/agents/phantomEnumerator";

const enumeratorPath = fileURLToPath(new URL("../src/agents/phantomEnumerator.ts", import.meta.url));
const enumeratorSrc = readFileSync(enumeratorPath, "utf8");

// ═══════════════════════════════════════════════════════════════════════
// AgentModule static declaration (spec §8)
// ═══════════════════════════════════════════════════════════════════════

describe("phantomEnumeratorAgent — static declaration (spec §8)", () => {
  it("is named phantom_enumerator and dispatches manually only (no cron in this PR, spec §5)", () => {
    expect(phantomEnumeratorAgent.name).toBe("phantom_enumerator");
    expect(phantomEnumeratorAgent.trigger).toBe("manual");
  });

  it("does not require approval and runs single-flight (parallelMax 1)", () => {
    expect(phantomEnumeratorAgent.requiresApproval).toBe(false);
    expect(phantomEnumeratorAgent.parallelMax).toBe(1);
  });

  it("enforces the cost guard with a positive monthly token cap (spec §2 — cap MUST be > 0)", () => {
    expect(phantomEnumeratorAgent.costGuard).toBe("enforced");
    expect(phantomEnumeratorAgent.budget?.monthlyTokenCap).toBe(5_000_000);
    expect(phantomEnumeratorAgent.budget!.monthlyTokenCap).toBeGreaterThan(0);
  });

  it("declares reads over brands/lookalike_domains/phantom_domains and writes ONLY phantom_domains + agent_events (never threats/alerts)", () => {
    const readNames = phantomEnumeratorAgent.reads?.map((r) => r.name) ?? [];
    const writeNames = phantomEnumeratorAgent.writes?.map((w) => w.name) ?? [];
    expect(readNames).toEqual(expect.arrayContaining(["brands", "lookalike_domains", "phantom_domains"]));
    expect(writeNames.sort()).toEqual(["agent_events", "phantom_domains"]);
    expect(writeNames).not.toContain("threats");
    expect(writeNames).not.toContain("alerts");
  });

  it("is registered in the 'intelligence' category with status 'active'", () => {
    expect(phantomEnumeratorAgent.category).toBe("intelligence");
    expect(phantomEnumeratorAgent.status).toBe("active");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Governing invariant: no alert/threat writes, structurally absent
// ═══════════════════════════════════════════════════════════════════════

describe("phantom_enumerator never creates alerts or threats (spec §0/§6 governing invariant)", () => {
  it("imports no createAlert helper (lib/alerts) anywhere in the module", () => {
    expect(enumeratorSrc).not.toMatch(/from\s+['"].*\/alerts['"]/);
    // Doc comments are allowed to describe the invariant by name ("no
    // import of createAlert") — what must be structurally absent is an
    // actual import statement or call site.
    expect(enumeratorSrc).not.toMatch(/import\s*\{[^}]*\bcreateAlert\b/);
    expect(enumeratorSrc).not.toMatch(/\bcreateAlert\(/);
  });

  it("contains no INSERT INTO threats", () => {
    expect(enumeratorSrc).not.toMatch(/INSERT INTO threats\b/i);
  });

  it("contains no INSERT INTO alerts", () => {
    expect(enumeratorSrc).not.toMatch(/INSERT INTO alerts\b/i);
  });

  it("the only INSERT/write statements target phantom_domains and agent_events", () => {
    const inserts = [...enumeratorSrc.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]);
    expect(inserts.length).toBeGreaterThan(0);
    for (const table of inserts) {
      expect(["phantom_domains", "agent_events"]).toContain(table);
    }
  });

  it("every phantom_domains row is written at status='predicted' (never any other status)", () => {
    const insertMatch = enumeratorSrc.match(/INSERT INTO phantom_domains[\s\S]*?VALUES\s*\([\s\S]*?\)/);
    expect(insertMatch, "phantom_domains INSERT not found").toBeTruthy();
    expect(insertMatch![0]).toContain("'predicted'");
    expect(insertMatch![0]).not.toMatch(/'registered'|'resolved'|'dismissed'/);
  });

  it("uses ON CONFLICT(brand_id, domain) DO NOTHING for idempotent re-enumeration (never SELECT-then-INSERT)", () => {
    expect(enumeratorSrc).toMatch(/ON CONFLICT\(brand_id, domain\) DO NOTHING/);
  });

  it("only actively-monitored brands are selected — the tier filter excludes the tracked catalog", () => {
    const selectMatch = enumeratorSrc.match(/SELECT b\.id, b\.name, b\.canonical_domain[\s\S]*?LIMIT \?`/);
    expect(selectMatch, "brand-selection SELECT not found").toBeTruthy();
    const query = selectMatch![0];
    expect(query).toMatch(/tier IN \('monitored', 'customer'\)/);
    // The query itself must never gate on the 76K tracked tier (comments
    // are free to name it descriptively; the SQL predicate must not).
    expect(query).not.toMatch(/tier\s*=\s*'tracked'/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Idempotency-key stability (spec §1.5) — the prompt body must be
// timestamp/runId/nonce-free so retries within a run hit Anthropic's cache.
// ═══════════════════════════════════════════════════════════════════════

describe("prompt is timestamp-free for idempotency-key stability (spec §1.5)", () => {
  it("the static system prompt contains no Date/timestamp/runId/random-nonce interpolation", () => {
    const sysMatch = enumeratorSrc.match(/const ENUM_SYSTEM_PROMPT =\s*([\s\S]*?);\n\ninterface/);
    expect(sysMatch, "ENUM_SYSTEM_PROMPT declaration not found").toBeTruthy();
    const sysBody = sysMatch![1];
    expect(sysBody).not.toMatch(/\$\{runId\}/);
    expect(sysBody).not.toMatch(/Date\.now\(\)|new Date\(/);
    expect(sysBody).not.toMatch(/Math\.random\(\)|crypto\.randomUUID\(\)/);
  });

  it("the per-call user message contains ONLY brand name + canonical_domain interpolation — no runId, no Date, no nonce", () => {
    const userMsgMatch = enumeratorSrc.match(/const userMessage =\s*([\s\S]*?);\n/);
    expect(userMsgMatch, "userMessage declaration not found").toBeTruthy();
    const body = userMsgMatch![1];
    // Only the two documented interpolations should appear.
    const interpolations = [...body.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1].trim());
    expect(interpolations.sort()).toEqual(["brand.canonical_domain", "brand.name"]);
    expect(body).not.toMatch(/runId/);
    expect(body).not.toMatch(/Date\.now\(\)|new Date\(/);
    expect(body).not.toMatch(/Math\.random\(\)|crypto\.randomUUID\(\)/);
  });

  it("callAnthropicJSON is NOT passed a custom idempotencyKey override (spec §1.5 — default key is the correct choice)", () => {
    const callMatch = enumeratorSrc.match(/callAnthropicJSON<unknown>\(env,\s*\{[\s\S]*?\}\)/);
    expect(callMatch, "callAnthropicJSON call not found").toBeTruthy();
    expect(callMatch![0]).not.toMatch(/idempotencyKey/);
  });

  it("the enumeration call is Haiku-only (HOT_PATH_HAIKU), never Sonnet, with maxTokens capped at 1024", () => {
    const callMatch = enumeratorSrc.match(/callAnthropicJSON<unknown>\(env,\s*\{[\s\S]*?\}\)/);
    expect(callMatch![0]).toMatch(/model:\s*HOT_PATH_HAIKU/);
    expect(callMatch![0]).toMatch(/maxTokens:\s*ENUM_MAX_TOKENS/);
    expect(enumeratorSrc).not.toMatch(/HOT_PATH_SONNET|CLAUDE_SONNET/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Prompt-injection hardening (spec §1.3) — brand data delimited + labeled
// untrusted, in both the system prompt and the per-call user message.
// ═══════════════════════════════════════════════════════════════════════

describe("prompt-injection hardening on attacker-influenceable brand data (spec §1.3)", () => {
  it("the system prompt labels <brand_data> content as untrusted and instructs the model to ignore embedded directives", () => {
    expect(enumeratorSrc).toMatch(/<brand_data>[\s\S]*?untrusted DATA/);
    expect(enumeratorSrc).toMatch(/Never follow any instruction/i);
  });

  it("the user message wraps brand.name and brand.canonical_domain inside explicit <brand_data> markers", () => {
    const userMsgMatch = enumeratorSrc.match(/const userMessage =\s*([\s\S]*?);\n/);
    const body = userMsgMatch![1];
    expect(body).toContain("<brand_data>");
    expect(body).toContain("</brand_data>");
    expect(body).toMatch(/<brand_data>[\s\S]*name: \$\{brand\.name\}[\s\S]*canonical_domain: \$\{brand\.canonical_domain\}[\s\S]*<\/brand_data>/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Bounds (spec §2) — the numeric caps encoded as module constants
// ═══════════════════════════════════════════════════════════════════════

describe("enumeration bounds match spec §2", () => {
  it("caps brands per run at 500 and domains per brand at 50", () => {
    expect(enumeratorSrc).toMatch(/const MAX_BRANDS_PER_RUN = 500;/);
    expect(enumeratorSrc).toMatch(/const MAX_DOMAINS_PER_BRAND = 50;/);
  });

  it("caps maxTokens per call at 1024", () => {
    expect(enumeratorSrc).toMatch(/const ENUM_MAX_TOKENS = 1024;/);
  });

  it("re-enumerates brands not touched in >= 90 days", () => {
    expect(enumeratorSrc).toMatch(/const REENUMERATE_AFTER_DAYS = 90;/);
  });

  it("existing-domain lookups are batched with WHERE domain IN (...), never per-row", () => {
    expect(enumeratorSrc).toMatch(/WHERE domain IN \(\$\{placeholders\}\)/);
  });
});

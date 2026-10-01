/**
 * Flight Control `platform_ai_calls_failing` — the conjunction gate.
 *
 * The emit requires BOTH:
 *   (1) `budget_ledger` silent past 2h (no SUCCESSFUL call recorded), AND
 *   (2) a recent agent run with `aiCallsAttempted > 0 AND aiCallsSucceeded = 0`.
 *
 * Leg 2 is what makes the check safe. A genuinely quiet platform (nothing to
 * classify, no unmatched brands) makes no AI calls, so its ledger is silent
 * too — but it must NOT page anyone. Silent ledger ALONE is therefore the
 * false-positive guard and the most important negative case in this file.
 *
 * ── Why the negative cases are non-vacuous ──────────────────────────
 * The check sits inside a mandatory try/catch ("notification failures never
 * break FC"). So "did not emit" is exactly what a THROWING query looks like
 * too — a permanently dead check and a correctly-silent one are
 * indistinguishable from the outside. Every negative assertion here is
 * therefore paired with `expectCheckRanCleanly`, which proves from the
 * statement log that the check's own SQL executed without error (and, where
 * it should have, returned zero qualifying rows) and that FC did not log
 * "AI call-failure check failed".
 *
 * ── Test lane ───────────────────────────────────────────────────────
 * `flightControlAgent.execute` itself, over real `node:sqlite` with the
 * schema DERIVED from migrations/ (see migration-schema.ts), so a phantom
 * column in the check's SQL is a failure. Only `emitPlatformNotification`
 * is stubbed (to observe the emit); the template renderer stays real.
 * Tables FC reads for its OTHER checks are absent, and "no such table"
 * from those is answered with an empty result — every other error
 * (no such column, malformed JSON, syntax) propagates.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("../src/lib/platform-templates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/platform-templates")>();
  return { ...actual, emitPlatformNotification: vi.fn(async () => undefined) };
});

import { emitPlatformNotification } from "../src/lib/platform-templates";
import { flightControlAgent } from "../src/agents/flightControl";
import { parseNewestFailure, AI_OUTAGE_MIN_ATTEMPTS } from "../src/lib/haiku";
import { executeAgent } from "../src/lib/agentRunner";
import { sentinelAgent } from "../src/agents/sentinel";
import {
  hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, sqlContaining, sqliteTimestampHoursAgo,
  type SqliteDb, type StatementLogEntry,
} from "./sqlite-d1-harness";
import {
  SENTINEL_TABLES, CLASSIFICATION_JSON, CREDIT_BALANCE_400, anthropicOk,
  RULE_SKIPPED, seedThreats, distinct, type SeedThreat,
} from "./ai-fixtures";

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const FC_SRC = readSrc("../src/agents/flightControl.ts");
const DIAG_SRC = readSrc("../src/handlers/diagnostics.ts");

// Extracted from source, not retyped: a reworded query changes what is
// tested instead of silently dropping out of coverage.
const LEDGER_SQL = sqlContaining(FC_SRC, ["SELECT MAX(created_at) AS last_at FROM budget_ledger"]);
const FAILING_SQL = sqlContaining(FC_SRC, ["FROM agent_outputs", "HAVING", "$.aiCallsAttempted"]);
const DIAG_AI_HEALTH_SQL = sqlContaining(DIAG_SRC, ["FROM agent_outputs", "$.aiCallsSkipped", "GROUP BY agent_id"]);

const TABLES = [...SENTINEL_TABLES];

/** Statements that are the unit under test — their errors must never be swallowed. */
const swallowOnlyAbsentUnrelatedTables = (_sql: string, err: Error): boolean => /no such table/i.test(err.message);

describe.skipIf(!hasSqlite())("Flight Control: platform_ai_calls_failing conjunction gate (real SQLite)", () => {
  let raw: SqliteDb;
  let log: StatementLogEntry[];
  let warn: { mock: { calls: unknown[][] } };
  const emit = vi.mocked(emitPlatformNotification);

  beforeEach(() => {
    raw = openDerivedDb(TABLES);
    log = [];
    emit.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // ── fixtures ────────────────────────────────────────────────────
  const ledgerRowHoursAgo = (hours: number): void => {
    raw.prepare(
      `INSERT INTO budget_ledger (id, agent_id, model, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, 'sentinel', 'claude-haiku-4-5-20251001', 10, 5, 0.001, ?)`,
    ).run(`l-${Math.random()}`, sqliteTimestampHoursAgo(hours));
  };

  /** One agent_outputs row exactly as an instrumented agent writes it (details = JSON.stringify). */
  const outputHoursAgo = (
    hours: number,
    agentId: string,
    details: Record<string, unknown> | string | null,
  ): void => {
    raw.prepare(
      `INSERT INTO agent_outputs (id, agent_id, type, summary, severity, details, created_at)
       VALUES (?, ?, 'classification', 'x', 'info', ?, datetime('now', ?))`,
    ).run(
      `o-${Math.random()}`,
      agentId,
      details === null ? null : typeof details === "string" ? details : JSON.stringify(details),
      `-${Math.round(hours * 60)} minutes`,
    );
  };

  const failingRun = (over: Record<string, unknown> = {}) => ({
    aiCallsAttempted: 4,
    aiCallsSucceeded: 0,
    aiCallsSkipped: 0,
    aiFirstFailureKind: "api_error",
    aiFirstError: 'Anthropic HTTP 400: {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
    ...over,
  });

  async function runFlightControl(): Promise<void> {
    const env = {
      DB: d1FromSqlite(raw, { swallow: swallowOnlyAbsentUnrelatedTables, log }),
      CACHE: fakeKv(),
    } as never;
    await flightControlAgent.execute({ env, runId: "fc-run", agentName: "flight_control", input: {}, triggeredBy: null });
  }

  const aiEmits = () => emit.mock.calls.filter((c) => c[1] === "platform_ai_calls_failing");

  /** The negative-case honesty check — see the file header. */
  function expectCheckRanCleanly(opts: { failingQueryShouldRun: boolean }): void {
    const ledger = log.filter((e) => e.sql === LEDGER_SQL);
    expect(ledger, "the ledger-silence read never executed — the check was skipped or the query was reworded").toHaveLength(1);
    expect(ledger[0]!.error, "ledger query raised").toBeUndefined();

    const failing = log.filter((e) => e.sql === FAILING_SQL);
    if (opts.failingQueryShouldRun) {
      expect(failing, "the attempted/succeeded rollup never executed").toHaveLength(1);
      expect(failing[0]!.error, "the attempted/succeeded rollup RAISED — a swallowed throw reads as 'silent'").toBeUndefined();
      expect(failing[0]!.rows, "a clean negative case must have returned zero qualifying agents").toBe(0);
    } else {
      expect(failing, "leg 2 must not even run while the ledger is fresh").toHaveLength(0);
    }
    const swallowedByFc = warn.mock.calls.filter((c) => String(c[0]).includes("AI call-failure check failed"));
    expect(swallowedByFc, "FC's catch block fired: the check threw and was swallowed").toHaveLength(0);
  }

  /** Positive-case twin: the rollup ran cleanly AND qualified exactly `n` agents. */
  function expectRollupQualified(n: number): void {
    const failing = log.filter((e) => e.sql === FAILING_SQL);
    expect(failing).toHaveLength(1);
    expect(failing[0]!.error).toBeUndefined();
    expect(failing[0]!.rows).toBe(n);
  }

  /**
   * Run the REAL sentinel through executeAgent against this same database, so
   * the agent_outputs rows Flight Control reads are the ones the writer
   * actually produces (writer/reader key parity), not hand-seeded JSON.
   */
  async function runRealSentinel(opts: { threats: SeedThreat[]; fetchImpl?: () => Promise<Response> }): Promise<void> {
    raw.exec(`INSERT OR IGNORE INTO agent_approvals (agent_id, state, requested_at) VALUES ('sentinel', 'approved', datetime('now'))`);
    seedThreats(raw, opts.threats);
    globalThis.fetch = vi.fn(opts.fetchImpl ?? (async () => anthropicOk(CLASSIFICATION_JSON))) as unknown as typeof fetch;
    const env = {
      DB: d1FromSqlite(raw),
      CACHE: fakeKv({ "ai:throttle_reason": "" }),
      ANTHROPIC_API_KEY: "sk-ant-test",
    } as never;
    const out = await executeAgent(env, sentinelAgent);
    expect(out.runId).not.toBe("");
  }

  // ═══════════════════════════════════════════════════════════════════
  // The conjunction
  // ═══════════════════════════════════════════════════════════════════
  describe("silent ledger ALONE must NOT emit (a quiet platform is not an outage)", () => {
    it("ledger silent for 5h and NO agent has run: no emit", async () => {
      ledgerRowHoursAgo(5);

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("ledger has NEVER been written and nothing has run: no emit", async () => {
      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("ledger silent, agents ran but attempted === 0 (nothing to classify): no emit", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "sentinel", { aiCallsAttempted: 0, aiCallsSucceeded: 0, aiCallsSkipped: 0 });
      outputHoursAgo(0.5, "analyst", { aiCallsAttempted: 0, aiCallsSucceeded: 0, aiCallsSkipped: 0 });

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("ledger silent because the cost guard THROTTLED (skipped > 0, attempted === 0): no emit", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "sentinel", { aiCallsAttempted: 0, aiCallsSucceeded: 0, aiCallsSkipped: 37 });

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("ledger silent, and the only agent output is a rules-skip run written by the REAL sentinel: no emit", async () => {
      // Writer/reader contract: not seeded by hand — produced by sentinel itself,
      // so renaming a counter in sentinel.ts without updating the FC query fails here.
      ledgerRowHoursAgo(5);
      await runRealSentinel({ threats: distinct(6, RULE_SKIPPED) });

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });
  });

  describe("silent ledger + attempted > 0 / succeeded = 0 DOES emit", () => {
    it("emits platform_ai_calls_failing once, with the failing agent, first error and a high (not critical) severity", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "sentinel", failingRun());

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      const [, key, rendered] = aiEmits()[0]!;
      expect(key).toBe("platform_ai_calls_failing");
      const t = rendered as { title: string; message: string; severity: string; audience: string };
      expect(t.title).toBe("AI calls failing — 4 attempted, 0 succeeded");
      expect(t.message).toMatch(/sentinel \(4 attempted, 0 succeeded\)/);
      expect(t.message).toMatch(/credit balance is too low/);
      expect(t.message).toMatch(/Last billed Anthropic call: 5\.\d+h ago \(threshold 2h\)/);
      // 'high' DELIBERATELY: 'critical' auto-creates an incident that surfaces on the PUBLIC status page.
      expect(t.severity).toBe("high");
      expect(t.audience).toBe("super_admin");
      expectRollupQualified(1);
    });

    it("emits from a REAL sentinel run whose every Anthropic call returned HTTP 400 (writer/reader parity)", async () => {
      ledgerRowHoursAgo(5);
      await runRealSentinel({
        threats: distinct(3),
        fetchImpl: async () => new Response(CREDIT_BALANCE_400, { status: 400 }),
      });

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      const t = aiEmits()[0]![2] as { title: string; message: string };
      expect(t.title).toBe("AI calls failing — 3 attempted, 0 succeeded");
      expect(t.message).toMatch(/First failure kind: api_error — Anthropic HTTP 400/);
      expectRollupQualified(1);
    });

    it("a ledger that has NEVER been written is silent: a failing run still emits, and the message says so", async () => {
      // 3 attempts, not 2: AI_OUTAGE_MIN_ATTEMPTS is the noise floor. The
      // subject of this test is the empty-ledger message, not the count.
      outputHoursAgo(0.5, "analyst", failingRun({ aiCallsAttempted: 3 }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      expect((aiEmits()[0]![2] as { message: string }).message).toMatch(/Last billed Anthropic call: never \(budget_ledger is empty\)/);
    });

    it("lists every failing agent and sums their attempts", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "sentinel", failingRun({ aiCallsAttempted: 4 }));
      outputHoursAgo(0.5, "analyst", failingRun({ aiCallsAttempted: 3 }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      const t = aiEmits()[0]![2] as { title: string; message: string };
      expect(t.title).toBe("AI calls failing — 7 attempted, 0 succeeded");
      expect(t.message).toMatch(/sentinel \(4 attempted, 0 succeeded\)/);
      expect(t.message).toMatch(/analyst \(3 attempted, 0 succeeded\)/);
      expectRollupQualified(2);
    });

    it("AI is alive for one agent and dead for another: only the dead one is reported", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "sentinel", failingRun({ aiCallsAttempted: 4 }));
      outputHoursAgo(0.5, "analyst", { aiCallsAttempted: 5, aiCallsSucceeded: 5, aiCallsSkipped: 0 });

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      const t = aiEmits()[0]![2] as { message: string };
      expect(t.message).toMatch(/sentinel \(4 attempted/);
      expect(t.message).not.toMatch(/analyst/);
      expectRollupQualified(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Gate boundaries (off-by-one in thresholds is a runtime bug tsc misses)
  // ═══════════════════════════════════════════════════════════════════
  describe("leg 1 boundary — ledger silence threshold (2h)", () => {
    it("ledger 1.9h old + a failing run: NO emit, and leg 2 is not even queried", async () => {
      ledgerRowHoursAgo(1.9);
      outputHoursAgo(0.5, "sentinel", failingRun());

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: false });
    });

    it("ledger 2.1h old + a failing run: emits", async () => {
      ledgerRowHoursAgo(2.1);
      outputHoursAgo(0.5, "sentinel", failingRun());

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      expectRollupQualified(1);
    });

    it("the NEWEST ledger row decides: an old row plus a fresh one is NOT silent", async () => {
      ledgerRowHoursAgo(30);
      ledgerRowHoursAgo(0.2);
      outputHoursAgo(0.5, "sentinel", failingRun());

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: false });
    });
  });

  describe("leg 2 boundaries — attempt window (EQUAL to the 2h threshold) and the succeeded = 0 requirement", () => {
    // The window is deliberately the same 2h as the ledger threshold, not
    // wider. Any successful call inside the window necessarily writes a
    // ledger row inside the window, which fails leg 1 — so summing
    // `succeeded` over the window agrees with leg 1 instead of adding
    // delay of its own. The earlier threshold + 1h of grace meant one
    // pre-outage success could suppress an agent for up to 3h while the
    // comment claimed 2h detection latency.
    it("a failing run 1.5h old is inside the window: emits", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(1.5, "sentinel", failingRun());

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
    });

    it("a failing run 2.5h old has aged out of the 2h window: no emit (and the query ran cleanly)", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(2.5, "sentinel", failingRun());

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("attempted > 0 but succeeded > 0 summed across the window: no emit (AI is partly alive)", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(1.0, "sentinel", failingRun({ aiCallsAttempted: 3 }));
      outputHoursAgo(0.5, "sentinel", { aiCallsAttempted: 2, aiCallsSucceeded: 2, aiCallsSkipped: 0 });

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("the failing-run query binds BOTH its parameters (an unbound `?` would silently match nothing)", () => {
      // Behavioural proof is the 1.5h-emits test above (datetime('now', NULL)
      // is NULL, so an unbound window qualifies no rows) plus the floor
      // tests below (an unbound floor makes HAVING ... >= NULL never true).
      // This pins arity statically so a third placeholder added later
      // cannot go unbound: FC binds the window AND the attempts floor.
      expect(FAILING_SQL.match(/\?/g)).toHaveLength(2);
      expect(DIAG_AI_HEALTH_SQL.match(/\?/g)).toHaveLength(1);
    });

    it("the attempts floor is bound from AI_OUTAGE_MIN_ATTEMPTS, not inlined", () => {
      // An inlined literal would silently drift from the exported const
      // that the agents' own verdicts and the alert copy reference.
      expect(FAILING_SQL).toMatch(/HAVING[\s\S]*>= \?/);
      expect(FC_SRC).toMatch(/\.bind\(`-\$\{AI_ATTEMPT_WINDOW_HOURS\} hours`, AI_OUTAGE_MIN_ATTEMPTS\)/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Attempts floor — one transient failure must not page anyone
  // ═══════════════════════════════════════════════════════════════════
  describe(`attempts floor (AI_OUTAGE_MIN_ATTEMPTS = ${AI_OUTAGE_MIN_ATTEMPTS})`, () => {
    it("premise: the floor is 3, so the boundary cases below are the real ones", () => {
      expect(AI_OUTAGE_MIN_ATTEMPTS).toBe(3);
    });

    it("ONE failed attempt in the window: no emit (a single transient 529 is not an outage)", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "sentinel", failingRun({ aiCallsAttempted: 1 }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("TWO failed attempts in the window: still no emit (one below the floor)", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "analyst", failingRun({ aiCallsAttempted: 2 }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("THREE failed attempts: emits (the floor is >=, not >)", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "analyst", failingRun({ aiCallsAttempted: 3 }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      expectRollupQualified(1);
    });

    it("the floor ACCUMULATES across runs, so it is a noise filter and not a detection ceiling", async () => {
      // A low-volume agent failing 1-2 calls per run must still alert. This
      // is why the floor sums over the window instead of being applied
      // per-run inside the agent: three separate 1-attempt runs qualify.
      ledgerRowHoursAgo(5);
      outputHoursAgo(1.5, "analyst", failingRun({ aiCallsAttempted: 1 }));
      outputHoursAgo(1.0, "analyst", failingRun({ aiCallsAttempted: 1 }));
      outputHoursAgo(0.5, "analyst", failingRun({ aiCallsAttempted: 1 }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      const t = aiEmits()[0]![2] as { title: string; message: string };
      expect(t.title).toBe("AI calls failing — 3 attempted, 0 succeeded");
      expect(t.message).toMatch(/Floor: an agent needs >= 3 real attempts/);
    });

    it("the floor is PER AGENT: two agents at 2 attempts each do not combine to clear it", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "analyst", failingRun({ aiCallsAttempted: 2 }));
      outputHoursAgo(0.5, "sentinel", failingRun({ aiCallsAttempted: 2 }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // The reported failure kind and message must describe THE SAME failure
  // ═══════════════════════════════════════════════════════════════════
  describe("first-failure diagnostic is read from one row", () => {
    it("pairs the kind with the message from the SAME, NEWEST failing row", async () => {
      // Two independent MAX() aggregates (the first implementation) would
      // mix these: MAX on text is lexicographic, so MAX(kind) picks
      // 'parse_error' (p > a) from the OLDER row while MAX(error) picks
      // the 'Z...' message from the newer one — an operator reads
      // "parse_error" beside an HTTP-400 message and chases the wrong
      // cause. The newest row here is the api_error one.
      ledgerRowHoursAgo(5);
      outputHoursAgo(1.5, "sentinel", failingRun({
        aiCallsAttempted: 3,
        aiFirstFailureKind: "parse_error",
        aiFirstError: "Anthropic JSON parse failed: Unexpected token",
      }));
      outputHoursAgo(0.2, "sentinel", failingRun({
        aiCallsAttempted: 3,
        aiFirstFailureKind: "api_error",
        aiFirstError: "ZZZ Anthropic HTTP 400: credit balance is too low",
      }));

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      const t = aiEmits()[0]![2] as { message: string };
      expect(t.message).toMatch(/First failure kind: api_error/);
      expect(t.message).toMatch(/credit balance is too low/);
      // The older row's kind must not be the one reported.
      expect(t.message).not.toMatch(/parse_error/);
      expect(t.message).not.toMatch(/Unexpected token/);
    });

    it("a healthy row in the same group cannot blank the diagnosis", async () => {
      // The aggregate is restricted to rows that actually recorded a
      // failure, so the newest row overall (which may carry no error)
      // cannot win it and report kind=null.
      ledgerRowHoursAgo(5);
      outputHoursAgo(1.0, "sentinel", failingRun({ aiCallsAttempted: 3 }));
      outputHoursAgo(0.1, "sentinel", { aiCallsAttempted: 0, aiCallsSucceeded: 0, aiCallsSkipped: 4 });

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      expect((aiEmits()[0]![2] as { message: string }).message).toMatch(/First failure kind: api_error/);
    });
  });

  describe("parseNewestFailure (the decoder)", () => {
    it("never throws, and degrades to unknown rather than breaking the alert that carries it", () => {
      expect(parseNewestFailure(null)).toEqual({ kind: null, error: null });
      expect(parseNewestFailure("")).toEqual({ kind: null, error: null });
      expect(parseNewestFailure("no separator here")).toEqual({ kind: null, error: null });
      expect(parseNewestFailure("2026-10-01 00:00:00\u001f{not json")).toEqual({ kind: null, error: null });
      expect(parseNewestFailure("2026-10-01 00:00:00\u001f[1,2]")).toEqual({ kind: null, error: null });
      expect(parseNewestFailure("2026-10-01 00:00:00\u001f{\"kind\":5,\"error\":null}")).toEqual({ kind: null, error: null });
    });

    it("round-trips a message containing the separator-adjacent characters and JSON punctuation", () => {
      const packed = `2026-10-01 00:00:00\u001f${JSON.stringify({ kind: "api_error", error: 'HTTP 400: {"error":{"message":"too low"}}' })}`;
      expect(parseNewestFailure(packed)).toEqual({
        kind: "api_error",
        error: 'HTTP 400: {"error":{"message":"too low"}}',
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // json_valid guard — a malformed details payload must not kill the check
  // ═══════════════════════════════════════════════════════════════════
  describe("json_valid(details) guard", () => {
    it("premise: an UNGUARDED json_extract over a malformed payload RAISES in this SQLite (otherwise the guard proves nothing)", () => {
      outputHoursAgo(0.5, "sentinel", "this is {not json");
      expect(() => raw.prepare(`SELECT json_extract(details, '$.aiCallsAttempted') FROM agent_outputs`).all()).toThrow(/malformed JSON/i);
    });

    it("a malformed row ALONGSIDE a valid failing row: the query does not abort, and the alert still emits", async () => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(1.0, "sentinel", "this is {not json");
      outputHoursAgo(0.5, "sentinel", failingRun());

      await runFlightControl();

      expect(aiEmits()).toHaveLength(1);
      expectRollupQualified(1);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("AI call-failure check failed"))).toHaveLength(0);
    });

    it.each<[string, string | null]>([
      ["truncated JSON", '{"aiCallsAttempted": 4, "aiCallsSucc'],
      ["plain prose", "Analyst matched 3 threats"],
      ["empty string", ""],
      ["SQL NULL", null],
      ["valid JSON that is not an object (array)", "[1,2,3]"],
      ["valid JSON that is not an object (string)", '"just a string"'],
      ["valid JSON object without the counters", '{"processed": 10}'],
    ])("a lone %s details row: no emit, and the query ran cleanly rather than being swallowed", async (_label, details) => {
      ledgerRowHoursAgo(5);
      outputHoursAgo(0.5, "sentinel", details);

      await runFlightControl();

      expect(aiEmits()).toHaveLength(0);
      expectCheckRanCleanly({ failingQueryShouldRun: true });
    });

    it("the diagnostics ai_health rollup carries the same guard: a malformed row does not abort it, valid rows still aggregate", () => {
      outputHoursAgo(1.0, "sentinel", "this is {not json");
      outputHoursAgo(0.5, "sentinel", failingRun({ aiCallsAttempted: 6, aiCallsSkipped: 2 }));
      outputHoursAgo(0.5, "analyst", { aiCallsAttempted: 0, aiCallsSucceeded: 0, aiCallsSkipped: 9 });

      const rows = raw.prepare(DIAG_AI_HEALTH_SQL).all(24) as Array<{
        agent_id: string; attempted: number; succeeded: number; skipped: number; newest_failure: string | null;
      }>;

      const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
      expect(byAgent.sentinel).toMatchObject({ attempted: 6, succeeded: 0, skipped: 2 });
      // kind + message travel together in one packed column — see
      // parseNewestFailure and the same-row test below.
      expect(parseNewestFailure(byAgent.sentinel!.newest_failure).kind).toBe("api_error");
      expect(byAgent.analyst).toMatchObject({ attempted: 0, succeeded: 0, skipped: 9 });
      // A healthy row records no failure, so nothing is invented for it.
      expect(parseNewestFailure(byAgent.analyst!.newest_failure)).toEqual({ kind: null, error: null });
    });
  });
});

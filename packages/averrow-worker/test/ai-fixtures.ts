/**
 * Fixtures shared by the silent-AI-failure test lanes (sentinel counters /
 * run status, and the Flight Control conjunction gate). Kept out of the
 * `*.test.ts` files so importing them does not re-register a suite.
 */

import type { SqliteDb } from "./sqlite-d1-harness";

export const SENTINEL_TABLES = [
  "threats", "brands", "monitored_brands", "social_profiles",
  "agent_runs", "agent_outputs", "agent_configs", "agent_approvals",
  "budget_ledger", "budget_config", "agent_budget_rollups",
];

export const CLASSIFICATION_JSON = '{"threat_type":"phishing","confidence":88,"severity":"high"}';
export const CREDIT_BALANCE_400 =
  '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

export function anthropicOk(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      model: "claude-haiku-4-5-20251001",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200 },
  );
}

export interface SeedThreat {
  id: string;
  domain: string | null;
  /** `phishtank` + `phishing` is rule-skipped (confidence 90 >= 85); anything else goes to the model. */
  feed?: string;
  type?: string;
}

export const RULE_SKIPPED = { feed: "phishtank", type: "phishing" } as const;
export const MODEL_BOUND = { feed: "otherfeed", type: "phishing" } as const;

export function seedThreats(raw: SqliteDb, threats: SeedThreat[]): void {
  const ins = raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, status, created_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
  );
  for (const t of threats) ins.run(t.id, t.feed ?? MODEL_BOUND.feed, t.type ?? MODEL_BOUND.type, t.domain);
}

/**
 * n model-bound threats with DISTINCT APEX domains. Sentinel groups siblings by
 * `getApexDomain` (last two labels), so `a.example.net` and `b.example.net`
 * would share one call; the apex must differ, hence `siteN-zq.net`.
 */
export const distinct = (n: number, spec: { feed: string; type: string } = MODEL_BOUND): SeedThreat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, domain: `site${i}-zq.net`, ...spec }));


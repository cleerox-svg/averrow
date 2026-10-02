/**
 * Fixtures shared by the silent-AI-failure test lanes (analyst counters /
 * run status, the Flight Control conjunction gate) and the Phase 1
 * rules-only lane for sentinel. Kept out of the `*.test.ts` files so
 * importing them does not re-register a suite.
 */

import type { SqliteDb } from "./sqlite-d1-harness";

export const SENTINEL_TABLES = [
  "threats", "brands", "monitored_brands", "social_profiles",
  "agent_runs", "agent_outputs", "agent_configs", "agent_approvals",
  "budget_ledger", "budget_config", "agent_budget_rollups",
];

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
  /** Defaults to MODEL_BOUND's feed: an unknown feed that analyst sends to the model. */
  feed?: string;
  type?: string;
}

export const MODEL_BOUND = { feed: "otherfeed", type: "phishing" } as const;

export function seedThreats(raw: SqliteDb, threats: SeedThreat[]): void {
  const ins = raw.prepare(
    `INSERT INTO threats (id, source_feed, threat_type, malicious_domain, status, created_at)
     VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
  );
  for (const t of threats) ins.run(t.id, t.feed ?? MODEL_BOUND.feed, t.type ?? MODEL_BOUND.type, t.domain);
}

/**
 * n model-bound threats with distinct domains (`siteN-zq.net`), so no two
 * share a classification or brand inference.
 */
export const distinct = (n: number, spec: { feed: string; type: string } = MODEL_BOUND): SeedThreat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i}`, domain: `site${i}-zq.net`, ...spec }));


// ─── analyst ─────────────────────────────────────────────────────────────

/**
 * Tables analyst's REQUIRED path touches (candidate select, safe-domain load,
 * keyword/AI flush, brand upsert, phase 2.5 enrichment aggregates, run + output
 * bookkeeping). The optional correlation phases (social / dark-web / app-store /
 * geopolitical) are each wrapped in their own try/catch inside analyst and are
 * deliberately not materialised: they are out of scope for the counters.
 */
export const ANALYST_TABLES = [
  "threats", "brands", "brand_safe_domains", "monitored_brands",
  "agent_runs", "agent_outputs", "agent_configs", "agent_approvals",
  "budget_ledger", "budget_config", "agent_budget_rollups",
];

/** What `inferBrand` asks the model for: `{brand_name, confidence, reasoning, matched_indicators}`. */
export const brandMatchJson = (confidence: number, brandName = "Zorbex"): string =>
  JSON.stringify({ brand_name: brandName, confidence, reasoning: "test", matched_indicators: ["domain"] });

/**
 * A monitored brand whose keyword makes `acmebank-*` hosts pre-match (no AI
 * call). Monitored, because the analyst pre-match only loads tier
 * monitored/customer brands (the tracked Tranco catalog is canonical-only).
 */
export function seedKeywordBrand(raw: SqliteDb): void {
  raw.exec(
    `INSERT INTO brands (id, name, canonical_domain, threat_count, brand_keywords, first_seen, tier)
     VALUES ('brand_acmebank', 'Acmebank', 'acmebank.com', 0, '["acmebank"]', datetime('now'), 'monitored')`,
  );
}

/** n threats whose hosts contain the seeded brand keyword, so analyst pre-matches them and never calls AI. */
export const keywordMatched = (n: number): SeedThreat[] =>
  Array.from({ length: n }, (_, i) => ({ id: `k${i}`, domain: `acmebank-login${i}.evil-zq.net`, ...MODEL_BOUND }));

export interface RoutedFetch {
  /** Install as `globalThis.fetch`. */
  fn: typeof fetch;
  anthropicCalls: string[];
  dohCalls: string[];
  /** URLs that matched no route. A test must assert this is empty: an unexpected egress is a failure, not a silent 404. */
  unrouted: string[];
}

/**
 * One `fetch` stub that serves BOTH upstreams analyst talks to, discriminated
 * by hostname: Anthropic (direct or via the AI Gateway) and Cloudflare DoH
 * (phase 6's numbered-variant scan). A single-purpose Anthropic stub answers
 * DoH lookups with the Anthropic fixture, which analyst's DoH helper
 * silently swallows (`catch {}`) — so a mis-routed stub looks like "no DNS
 * results" rather than an error.
 */
export function routedFetch(opts: {
  anthropic?: (init: { body: string }) => Response | Promise<Response>;
  /** Default: NXDOMAIN-shaped (no Answer) for every variant. */
  doh?: (name: string) => Response;
} = {}): RoutedFetch {
  const anthropicCalls: string[] = [];
  const dohCalls: string[] = [];
  const unrouted: string[] = [];
  const fn = (async (input: unknown, init?: { body?: unknown }) => {
    const url = new URL(typeof input === "string" ? input : (input as Request).url);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name") ?? "";
      dohCalls.push(name);
      return opts.doh ? opts.doh(name) : new Response(JSON.stringify({ Status: 3 }), { status: 200 });
    }
    if (url.hostname === "api.anthropic.com" || url.hostname === "gateway.ai.cloudflare.com") {
      const body = String(init?.body ?? "");
      anthropicCalls.push(body);
      if (!opts.anthropic) throw new Error("routedFetch: Anthropic called but no handler was provided");
      return opts.anthropic({ body });
    }
    unrouted.push(url.toString());
    throw new Error(`routedFetch: no route for ${url.toString()}`);
  }) as unknown as typeof fetch;
  return { fn, anthropicCalls, dohCalls, unrouted };
}

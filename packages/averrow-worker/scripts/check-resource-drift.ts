#!/usr/bin/env tsx
/**
 * Resource-declaration drift check.
 *
 * AGENT_STANDARD §10 requires every AgentModule to declare the D1
 * tables / KV namespaces / R2 buckets / env bindings it touches.
 * The architect manifest already runs static SQL/KV extraction over
 * each agent file; this script imports the live agentModules registry
 * and the manifest, then fails (exit 1) if an agent's declared
 * `reads` / `writes` doesn't match the extracted set.
 *
 * Phase 4.3 ships the drift gate alongside the declarations. CI runs
 * `pnpm check:resource-drift` after `pnpm build:manifest` (i.e. the
 * extraction is fresh against the current source).
 *
 * Usage:
 *   pnpm --filter averrow-worker check:resource-drift
 *   tsx scripts/check-resource-drift.ts
 */

import { agentModules } from "../src/agents";
import { REPO_MANIFEST } from "../src/agents/architect/manifest.generated";
import type { ResourceDecl } from "../src/lib/agentRunner";

// Match the transform used when authoring per-agent declarations
// (Phase 4.3 generation). Extraction in repo-fs.ts produces flat string
// arrays; we normalise them into ResourceDecl shape for comparison.
const DROP = new Set(["DB", "SET"]);
const KV_BINDINGS = new Set(["CACHE"]);
const KNOWN_BINDINGS = new Set([
  "CERTSTREAM_MONITOR",
  "AI",
  "AE",
  "WORKFLOW",
  "ARCHITECT_BUNDLES",
]);

function transform(name: string): ResourceDecl | null {
  if (DROP.has(name)) return null;
  if (KV_BINDINGS.has(name)) return { kind: "kv", namespace: name };
  if (KNOWN_BINDINGS.has(name)) return { kind: "binding", name };
  // Heuristic: ALL_CAPS strings are env bindings, otherwise D1 table.
  if (/^[A-Z][A-Z0-9_]*$/.test(name)) return { kind: "binding", name };
  return { kind: "d1_table", name };
}

function normalise(items: string[]): ResourceDecl[] {
  return items
    .map(transform)
    .filter((x): x is ResourceDecl => x !== null);
}

function key(r: ResourceDecl): string {
  switch (r.kind) {
    case "d1_table": return `d1:${r.name}`;
    case "kv":       return `kv:${r.namespace}${r.prefix ? `:${r.prefix}` : ""}`;
    case "r2":       return `r2:${r.bucket}${r.prefix ? `:${r.prefix}` : ""}`;
    case "queue":    return `queue:${r.name}`;
    case "binding":  return `binding:${r.name}`;
    case "external": return `external:${r.name}`;
  }
}

function diff(declared: ResourceDecl[], extracted: ResourceDecl[]): {
  missing: ResourceDecl[];
  unexpected: ResourceDecl[];
} {
  const declaredKeys = new Set(declared.map(key));
  const extractedKeys = new Set(extracted.map(key));
  return {
    missing: extracted.filter((r) => !declaredKeys.has(key(r))),
    // `external` resources (third-party HTTP endpoints) are
    // operator-facing documentation; the static extractor can't
    // see HTTP destinations through fetch() calls reliably (they
    // can be variables, template literals, etc.). Excluding them
    // from the "declared but not extracted" check lets agents
    // surface external dependencies in their declarations without
    // tripping the drift gate. The cost: a typo in the `name` /
    // `url` fields won't be caught here. Catch those at code review.
    unexpected: declared.filter((r) =>
      r.kind !== 'external' && !extractedKeys.has(key(r)),
    ),
  };
}

// Map agentModules registry name (snake_case) to manifest entry name
// (kebab/camel — extractor uses filename basename).
const MANIFEST_NAME_OVERRIDES: Record<string, string> = {
  abuse_mailbox_classifier: "abuseMailboxClassifier",
  admin_classify: "admin-classify",
  app_store_monitor: "appStoreMonitor",
  auto_seeder: "auto-seeder",
  brand_analysis: "brand-analysis",
  brand_deep_scan: "brand-deep-scan",
  brand_enricher: "brand-enricher",
  campaign_hunter: "campaign-hunter",
  ct_monitor: "ct-monitor",
  brand_report: "brand-report",
  cube_healer: "cube-healer",
  dark_web_monitor: "darkWebMonitor",
  evidence_assembler: "evidence-assembler",
  flight_control: "flightControl",
  geo_campaign_assessment: "geo-campaign-assessment",
  geoip_refresh: "geoip-refresh",
  honeypot_generator: "honeypot-generator",
  lookalike_scanner: "lookalike-scanner",
  news_watcher: "news-watcher",
  public_trust_check: "public-trust-check",
  qualified_report: "qualified-report",
  scan_report: "scan-report",
  seed_strategist: "seed-strategist",
  social_ai_assessor: "social-ai-assessor",
  social_discovery: "socialDiscovery",
  social_monitor: "socialMonitor",
  trademark_monitor: "trademarkMonitor",
  url_scan: "url-scan",
};

// Agents whose source isn't in agents/*.ts are skipped — the manifest
// extractor only walks that directory. Phase 5 may broaden the
// extractor; for now we trust the per-module declarations on these.
const NOT_IN_MANIFEST = new Set(["navigator", "enricher"]);

let failures = 0;
const reports: string[] = [];

for (const [agentId, mod] of Object.entries(agentModules)) {
  if (NOT_IN_MANIFEST.has(agentId)) continue;
  const manifestName = MANIFEST_NAME_OVERRIDES[agentId] ?? agentId;
  const manifestEntry = REPO_MANIFEST.agents.find((a) => a.name === manifestName);
  if (!manifestEntry) {
    reports.push(`[FAIL] ${agentId} — no manifest entry found (looked up "${manifestName}"). Regenerate with \`pnpm build:manifest\`.`);
    failures++;
    continue;
  }

  const extractedReads = normalise(manifestEntry.reads);
  const extractedWrites = normalise(manifestEntry.writes);
  const readsDiff = diff(mod.reads, extractedReads);
  const writesDiff = diff(mod.writes, extractedWrites);

  const issues: string[] = [];
  if (readsDiff.missing.length > 0) {
    issues.push(`reads MISSING from declaration: ${readsDiff.missing.map(key).join(", ")}`);
  }
  if (readsDiff.unexpected.length > 0) {
    issues.push(`reads DECLARED but not extracted: ${readsDiff.unexpected.map(key).join(", ")}`);
  }
  if (writesDiff.missing.length > 0) {
    issues.push(`writes MISSING from declaration: ${writesDiff.missing.map(key).join(", ")}`);
  }
  if (writesDiff.unexpected.length > 0) {
    issues.push(`writes DECLARED but not extracted: ${writesDiff.unexpected.map(key).join(", ")}`);
  }

  if (issues.length > 0) {
    reports.push(`[DRIFT] ${agentId}\n  ${issues.join("\n  ")}`);
    failures++;
  }
}

if (failures === 0) {
  console.log(
    `[check-resource-drift] OK — ${Object.keys(agentModules).length} agents, ` +
      `${NOT_IN_MANIFEST.size} skipped (not in agents/*.ts), 0 drift`,
  );
  process.exit(0);
}

console.error(
  `[check-resource-drift] ${failures} agent${failures === 1 ? "" : "s"} have drift between declared resources and the architect manifest extraction:\n`,
);
for (const r of reports) console.error(r + "\n");
console.error(
  "Fix by either updating the declaration in the agent module (the extracted set is the truth) " +
    "or by removing the SQL from the agent file (declarations track what the file actually queries).\n" +
    "If you added an agent and forgot to update the manifest, run `pnpm build:manifest`.",
);
process.exit(1);

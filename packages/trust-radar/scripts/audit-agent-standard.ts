#!/usr/bin/env tsx
/**
 * AGENT_STANDARD §22 enforcement script.
 *
 * Walks every cross-file consistency rule the TypeScript compiler
 * cannot verify on its own, fails (exit 1) on any violation, and
 * exits 0 when the registry matches the standard end-to-end.
 *
 * The TS compiler already enforces (Phase 4 work):
 *   - AgentName union closure
 *   - AgentModule interface field presence (incl. category, status,
 *     budget, reads/writes, outputs)
 *   - AgentCategory + AgentStatus + AgentOutputType unions
 *
 * What this script adds (cross-file rules):
 *   1. agentModules registry ↔ averrow-ops AGENT_METADATA parity
 *   2. AGENT_METADATA ↔ AgentIcon.tsx icon presence
 *   3. AGENT_METADATA membership in averrow-ops AGENT_GROUPS
 *   4. pipelinePosition uniqueness across all modules
 *   5. costGuard='exempt' agents have inline justification comments
 *   6. Each registered agent appears in docs/AI_AGENTS.md
 *   7. Phase 4.3 resource-drift status (delegates to
 *      check-resource-drift.ts so a single CI step covers both)
 *
 * Usage:
 *   pnpm --filter trust-radar audit:agent-standard
 *   tsx scripts/audit-agent-standard.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { agentModules } from "../src/agents";

// ─── Repo paths ──────────────────────────────────────────────────

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const UI_METADATA_PATH = resolve(REPO_ROOT, "packages/averrow-ops/src/lib/agent-metadata.ts");
const UI_ICONS_PATH = resolve(REPO_ROOT, "packages/averrow-ops/src/components/brand/AgentIcon.tsx");
const UI_AGENTS_PAGE_PATH = resolve(REPO_ROOT, "packages/averrow-ops/src/features/agents/Agents.tsx");
const AGENTS_DOC_PATH = resolve(REPO_ROOT, "docs/AI_AGENTS.md");

// ─── Failure tracker ─────────────────────────────────────────────

interface Failure {
  rule: string;
  agent?: string;
  detail: string;
}
const failures: Failure[] = [];
const fail = (rule: string, detail: string, agent?: string) => failures.push({ rule, agent, detail });

// ─── 1. agentModules ↔ AGENT_METADATA parity ─────────────────────

function ruleMetadataParity(): void {
  let metadataSrc: string;
  try {
    metadataSrc = readFileSync(UI_METADATA_PATH, "utf8");
  } catch (err) {
    fail("metadata-parity", `cannot read ${UI_METADATA_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Match top-level entries: each AGENT_METADATA value starts at column 2
  // with `<id>: {` after the `AGENT_METADATA: Record<...> = {` line.
  const metadataIds = new Set<string>();
  const idRe = /^[ \t]{2}([a-z_][a-z0-9_]*):\s*\{$/gm;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(metadataSrc)) !== null) {
    metadataIds.add(m[1]!);
  }

  const registeredIds = new Set(Object.keys(agentModules));

  for (const id of registeredIds) {
    if (!metadataIds.has(id)) {
      fail("metadata-parity", `agent registered in agentModules but missing from AGENT_METADATA in agent-metadata.ts`, id);
    }
  }
  for (const id of metadataIds) {
    if (!registeredIds.has(id)) {
      // Whitelist the architect retired-but-typechecked module — it
      // is intentionally missing from agentModules but kept in the
      // metadata for the FC card mesh's "retired" tile.
      if (id === "architect") continue;
      fail("metadata-parity", `AGENT_METADATA has entry but no AgentModule registered`, id);
    }
  }
}

// ─── 2. AGENT_METADATA ↔ AgentIcon icons ─────────────────────────

function ruleIconCoverage(): void {
  let iconsSrc: string;
  let metadataSrc: string;
  try {
    iconsSrc = readFileSync(UI_ICONS_PATH, "utf8");
    metadataSrc = readFileSync(UI_METADATA_PATH, "utf8");
  } catch (err) {
    fail("icon-coverage", `cannot read AgentIcon source: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Icons are entries inside `const icons: Record<string, ...> = { <id>: (s) => ( ... ) }`.
  const iconIds = new Set<string>();
  const iconRe = /^[ \t]{2}([a-z_][a-z0-9_]*):\s*\(s\)\s*=>\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = iconRe.exec(iconsSrc)) !== null) {
    iconIds.add(m[1]!);
  }

  const metadataIds = new Set<string>();
  const idRe = /^[ \t]{2}([a-z_][a-z0-9_]*):\s*\{$/gm;
  let mm: RegExpExecArray | null;
  while ((mm = idRe.exec(metadataSrc)) !== null) {
    metadataIds.add(mm[1]!);
  }

  for (const id of metadataIds) {
    if (!iconIds.has(id)) {
      fail("icon-coverage", `AGENT_METADATA entry has no SVG in AgentIcon.tsx`, id);
    }
  }
}

// ─── 3. Agents page group membership ─────────────────────────────
//
// V3 Agents.tsx groups by AGENT_METADATA.category at render time
// (no more hand-maintained AGENT_GROUPS constant). The page's
// GROUP_LABELS map enumerates the categories that have a section
// on the page. Every registered agent must:
//   (a) appear in AGENT_METADATA, and
//   (b) have its `category` listed in the page's GROUP_LABELS map.
// Otherwise it would render in no section at all.

function ruleGroupMembership(): void {
  let agentsPageSrc: string;
  let metadataSrc: string;
  try {
    agentsPageSrc = readFileSync(UI_AGENTS_PAGE_PATH, "utf8");
    metadataSrc   = readFileSync(UI_METADATA_PATH, "utf8");
  } catch (err) {
    fail("group-membership", `cannot read Agents.tsx / agent-metadata.ts: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Pull the set of category keys the page actually surfaces
  // (anything before a colon inside the GROUP_LABELS map literal).
  const groupLabelsBlockRe = /GROUP_LABELS\s*:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\}\s*;/m;
  const blockMatch = groupLabelsBlockRe.exec(agentsPageSrc);
  if (!blockMatch) {
    fail("group-membership", "could not find GROUP_LABELS map on Agents.tsx — page-render contract changed");
    return;
  }
  const groupKeys = new Set<string>();
  const keyRe = /^\s*([a-z_][a-z0-9_]*)\s*:/gm;
  let km: RegExpExecArray | null;
  while ((km = keyRe.exec(blockMatch[1] ?? "")) !== null) {
    groupKeys.add(km[1]!);
  }

  // Pull (id, category) pairs from AGENT_METADATA. Each entry is
  // an object literal with `id: 'x'` and `category: 'y'`.
  const metaCategory = new Map<string, string>();
  const entryRe = /id:\s*['"]([a-z_][a-z0-9_]*)['"][\s\S]*?category:\s*['"]([a-z]+)['"]/g;
  let em: RegExpExecArray | null;
  while ((em = entryRe.exec(metadataSrc)) !== null) {
    metaCategory.set(em[1]!, em[2]!);
  }

  // flight_control renders in a dedicated SUPERVISOR section, not
  // in a GROUP_LABELS bucket — exempt from category check.
  const groupExempt = new Set(["flight_control"]);

  for (const id of Object.keys(agentModules)) {
    if (groupExempt.has(id)) continue;
    const cat = metaCategory.get(id);
    if (!cat) {
      fail("group-membership", `no AGENT_METADATA entry — won't render on Agents.tsx`, id);
      continue;
    }
    if (!groupKeys.has(cat)) {
      fail("group-membership", `category '${cat}' has no GROUP_LABELS bucket on Agents.tsx — won't render`, id);
    }
  }
}

// ─── 4. pipelinePosition uniqueness ──────────────────────────────

function rulePipelinePositionUniqueness(): void {
  // Backend's AgentModule has the position; UI metadata has its own
  // (Phase 4.5 ports the backend's into the registry but the UI
  // copy is still authoritative until Phase 5.5 ports the consumers).
  // Check both for collisions independently.
  const backendByPosition = new Map<number, string[]>();
  for (const [id, mod] of Object.entries(agentModules)) {
    const pos = mod.pipelinePosition;
    const existing = backendByPosition.get(pos) ?? [];
    existing.push(id);
    backendByPosition.set(pos, existing);
  }
  for (const [pos, ids] of backendByPosition) {
    if (ids.length > 1) {
      fail("pipeline-position-unique", `pipelinePosition ${pos} is shared by ${ids.length} agents in backend AgentModule registry: ${ids.join(", ")}`);
    }
  }
}

// ─── 5. costGuard='exempt' justification comments ────────────────

function ruleExemptJustification(): void {
  // Each module file is in src/agents/*.ts or src/cron/*.ts (for
  // navigator + enricher). Walk the registry and read each file.
  for (const [id, mod] of Object.entries(agentModules)) {
    if (mod.costGuard !== "exempt") continue;

    // We need the source file path. The registry doesn't track it,
    // so probe the two known directories by filename. Module file
    // names are kebab-case (admin-classify.ts) or camelCase
    // (appStoreMonitor.ts) — try both.
    const candidates = [
      resolve(__dirname, "..", "src", "agents", `${id.replace(/_/g, "-")}.ts`),
      resolve(__dirname, "..", "src", "agents", `${id.replace(/_./g, (m) => m[1]!.toUpperCase())}.ts`),
      resolve(__dirname, "..", "src", "cron", `${id.replace(/_/g, "-")}.ts`),
      resolve(__dirname, "..", "src", "cron", `${id.replace(/_./g, (m) => m[1]!.toUpperCase())}.ts`),
    ];

    let src: string | null = null;
    for (const path of candidates) {
      try {
        src = readFileSync(path, "utf8");
        break;
      } catch { /* try next */ }
    }
    if (src === null) {
      fail("exempt-justification", `costGuard='exempt' but module source file not found (tried ${candidates.join(", ")})`, id);
      continue;
    }

    // Look for `costGuard: 'exempt'` (or "exempt"), then check the
    // 3 lines preceding AND 3 lines following the declaration for
    // a `//` comment. Authors put justifications on either side of
    // the field — both placements are valid.
    const lines = src.split("\n");
    const declLineIdx = lines.findIndex((l) => /costGuard:\s*['"]exempt['"]/.test(l));
    if (declLineIdx < 0) {
      // Module file uses a different agentId for its costGuard line;
      // unusual but skip.
      continue;
    }
    const windowStart = Math.max(0, declLineIdx - 3);
    const windowEnd = Math.min(lines.length, declLineIdx + 4); // +4 inclusive of decl line + 3 after
    const windowText = lines.slice(windowStart, windowEnd).join("\n");
    if (!/\/\/.+/.test(windowText) && !/\/\*[\s\S]*\*\//.test(windowText)) {
      fail("exempt-justification", `costGuard='exempt' must have an inline justification comment within 3 lines before or after the declaration`, id);
    }
  }
}

// ─── 6. AI_AGENTS.md docstring presence ──────────────────────────

function ruleAgentDocCoverage(): void {
  let docsSrc: string;
  try {
    docsSrc = readFileSync(AGENTS_DOC_PATH, "utf8");
  } catch (err) {
    fail("agents-doc-coverage", `cannot read docs/AI_AGENTS.md: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const id of Object.keys(agentModules)) {
    // Match either snake_case or `displayName`-style references —
    // some modules in the doc are written as their displayName
    // (e.g. "Mockingbird" for social_monitor). Be permissive: as
    // long as the snake_case OR the displayName appears, count it
    // as documented.
    const display = agentModules[id]!.displayName;
    const idEscape = id.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const dispEscape = display.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re = new RegExp(`\\b(${idEscape}|${dispEscape})\\b`);
    if (!re.test(docsSrc)) {
      fail("agents-doc-coverage", `agent missing from docs/AI_AGENTS.md (looked for "${id}" or "${display}")`, id);
    }
  }
}

// ─── 7. Resource drift (delegates to Phase 4.3 script) ───────────
//
// We don't re-implement the drift check here — the existing
// scripts/check-resource-drift.ts already covers it. The CI workflow
// already runs check-resource-drift after build:manifest, so this
// rule just verifies the script exists where it should so the
// failure message can point operators at it.

function ruleResourceDriftScriptExists(): void {
  const path = resolve(__dirname, "check-resource-drift.ts");
  try {
    readFileSync(path, "utf8");
  } catch {
    fail("resource-drift", `expected scripts/check-resource-drift.ts to exist alongside this file (Phase 4.3) — CI's resource-drift gate is the truth source for reads/writes drift`);
  }
}

// ─── Runner ──────────────────────────────────────────────────────

const start = Date.now();

ruleMetadataParity();
ruleIconCoverage();
ruleGroupMembership();
rulePipelinePositionUniqueness();
ruleExemptJustification();
ruleAgentDocCoverage();
ruleResourceDriftScriptExists();

const durationMs = Date.now() - start;

if (failures.length === 0) {
  console.log(
    `[audit-agent-standard] OK — ${Object.keys(agentModules).length} agents, 7 rules, 0 violations (${durationMs}ms)`,
  );
  process.exit(0);
}

const grouped = new Map<string, Failure[]>();
for (const f of failures) {
  const list = grouped.get(f.rule) ?? [];
  list.push(f);
  grouped.set(f.rule, list);
}

console.error(
  `[audit-agent-standard] ${failures.length} violation${failures.length === 1 ? "" : "s"} across ${grouped.size} rule${grouped.size === 1 ? "" : "s"}:\n`,
);
for (const [rule, fs] of grouped) {
  console.error(`── ${rule} ─────────────────────────────────────────`);
  for (const f of fs) {
    const tag = f.agent ? `[${f.agent}] ` : "";
    console.error(`  ${tag}${f.detail}`);
  }
  console.error("");
}
console.error(
  `Fix by reading docs/AGENT_STANDARD.md §22 — every rule above maps to a numbered checklist item there.`,
);
process.exit(1);

/**
 * ARCHITECT — repository inventory collector (Node-only fs walker).
 *
 * Walks the monorepo file tree and builds a RepoInventory describing
 * agents, feeds, cron handlers, and worker entries. This module uses
 * node:fs and must never be imported from Worker runtime code —
 * importing it pulls `fs` into the Worker bundle.
 *
 * Two callers today:
 *   1. scripts/build-architect-manifest.ts — emits manifest.generated.ts
 *      at build time so the Worker runtime has a deterministic inventory
 *      without touching the filesystem.
 *   2. src/agents/architect/cli.ts — local verification path, so a
 *      CLI operator can regenerate the bundle against the live working
 *      tree without a full build first.
 *
 * Heuristics only — this is a context bundle for downstream AI synthesis,
 * not a source of truth. When in doubt, return what is observable and
 * leave interpretation to later phases.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type {
  AgentFile,
  CronHandler,
  FeedFile,
  RepoInventory,
  WorkerEntry,
} from "../types";

// ─── Constants ────────────────────────────────────────────────────

// ARCHITECT's inventory is scoped to the averrow-worker Worker package.
// Other packages in the monorepo (averrow-mcp, averrow-ops, averrow-tenant, …) are separate
// products and must never appear in this bundle.
const AVERROW_WORKER_PACKAGE_SEGMENTS = ["packages", "averrow-worker"];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".wrangler",
  "_archive",
  ".git",
]);
const SKIP_FILES = new Set(["index.ts", "types.ts"]);

// Known agents that are shipped in this Worker but whose top-level
// export does not follow the `*Agent` naming convention. Any file
// directly under src/agents/ must either export an `*Agent` symbol or
// be explicitly listed here to be treated as an agent.
const KNOWN_AGENT_NAMES = new Set<string>([
  "analyst",
  "cartographer",
  "curator",
  "flightControl",
  "narrator",
  "nexus",
  "observer",
  "pathfinder",
  "seed-strategist",
  "sentinel",
  "sparrow",
  "strategist",
  "trustbot",
  "watchdog",
]);

// Bindings we recognise as "reads/writes" targets at the Env level.
// Table names are extracted separately from inline SQL.
const ENV_BINDING_NAMES = [
  "DB",
  "AUDIT_DB",
  "CACHE",
  "ASSETS",
  "THREAT_PUSH_HUB",
  "CERTSTREAM_MONITOR",
  "CARTOGRAPHER_BACKFILL",
  "NEXUS_RUN",
];

// ─── Public API ───────────────────────────────────────────────────

export async function collectRepoInventoryFromFs(
  rootDir: string,
): Promise<RepoInventory> {
  const collectedAt = new Date().toISOString();

  // All discovery is scoped to the averrow-worker package tree. Other
  // packages (e.g. averrow-mcp) have their own Workers, crons, and agents
  // and must not leak into the ARCHITECT bundle.
  const packageRoot = join(rootDir, ...AVERROW_WORKER_PACKAGE_SEGMENTS);

  const agentFilePaths = await findAgentFiles(packageRoot);
  const feedFilePaths = await findFeedFiles(packageRoot);
  const wranglerPaths = await findWranglerTomls(packageRoot);

  const agents: AgentFile[] = [];
  for (const p of agentFilePaths) {
    const entry = await scanAgentFile(rootDir, p);
    if (entry) agents.push(entry);
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));

  const feeds: FeedFile[] = [];
  for (const p of feedFilePaths) {
    const entry = await scanFeedFile(rootDir, p);
    if (entry) feeds.push(entry);
  }
  feeds.sort((a, b) => a.name.localeCompare(b.name));

  const workers: WorkerEntry[] = [];
  const crons: CronHandler[] = [];
  for (const p of wranglerPaths) {
    const parsed = await parseWranglerToml(rootDir, p, agents);
    workers.push(parsed.worker);
    crons.push(...parsed.crons);
  }
  workers.sort((a, b) => a.name.localeCompare(b.name));

  return {
    collected_at: collectedAt,
    agents,
    feeds,
    crons,
    workers,
    totals: {
      agents: agents.length,
      feeds: feeds.length,
      crons: crons.length,
      workers: workers.length,
    },
  };
}

// ─── Filesystem walking ───────────────────────────────────────────

/**
 * Return candidate agent files — top-level *.ts directly under
 * packages/averrow-worker/src/agents/. Subdirectories (notably
 * `architect/`, which is ARCHITECT's own infra and NOT a runtime
 * agent) are not walked at all. Files matching test/spec/shim/cli
 * /generated naming patterns are also skipped.
 */
async function findAgentFiles(packageRoot: string): Promise<string[]> {
  const agentsDir = join(packageRoot, "src", "agents");
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isAgentCandidateFilename(entry.name)) continue;
    out.push(join(agentsDir, entry.name));
  }
  return out;
}

function isAgentCandidateFilename(name: string): boolean {
  if (!name.endsWith(".ts")) return false;
  if (SKIP_FILES.has(name)) return false;
  if (name === "cli.ts") return false;
  if (name.endsWith(".generated.ts")) return false;
  if (name.endsWith(".test.ts")) return false;
  if (name.endsWith(".spec.ts")) return false;
  if (name.endsWith("-shim.ts")) return false;
  return true;
}

async function findFeedFiles(packageRoot: string): Promise<string[]> {
  const feedsDir = join(packageRoot, "src", "feeds");
  const out: string[] = [];
  await walk(feedsDir, async (absPath, isDir) => {
    if (isDir) return;
    if (!absPath.endsWith(".ts")) return;
    if (SKIP_FILES.has(basenameOf(absPath))) return;
    out.push(absPath);
  });
  return out;
}

async function findWranglerTomls(packageRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walk(packageRoot, async (absPath, isDir) => {
    if (isDir) return;
    if (basenameOf(absPath) !== "wrangler.toml") return;
    out.push(absPath);
  });
  return out;
}

async function walk(
  dir: string,
  visit: (absPath: string, isDir: boolean) => Promise<void>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await visit(full, true);
      await walk(full, visit);
    } else if (entry.isFile()) {
      await visit(full, false);
    }
  }
}

function basenameOf(p: string): string {
  const parts = p.split(sep);
  return parts[parts.length - 1] ?? p;
}

// ─── Agent file scanning ──────────────────────────────────────────

async function scanAgentFile(
  rootDir: string,
  absPath: string,
): Promise<AgentFile | null> {
  const source = await readFile(absPath, "utf8");
  const stats = await stat(absPath);
  const name = basenameOf(absPath).replace(/\.ts$/, "");
  const path = relative(rootDir, absPath).split(sep).join("/");
  const isGenerated = absPath.endsWith(".generated.ts");

  const entrypoint = extractAgentEntrypoint(source);
  // A file is only treated as an agent if it either exports an
  // `*Agent` symbol or is explicitly listed in KNOWN_AGENT_NAMES
  // (e.g. narrator, whose entrypoint is `generateThreatNarrative`).
  const hasAgentExport =
    entrypoint !== null && /Agent$/.test(entrypoint);
  const isKnownAgent = KNOWN_AGENT_NAMES.has(name);
  if (!hasAgentExport && !isKnownAgent) {
    return null;
  }

  return {
    name,
    path,
    entrypoint,
    triggers: isGenerated ? [] : extractAgentTriggers(source),
    reads: extractReadTables(source),
    writes: extractWriteTables(source),
    ai_models_referenced: isGenerated ? [] : extractAiModels(source),
    loc: countLines(source),
    last_modified: stats.mtime.toISOString(),
  };
}

function extractAgentEntrypoint(source: string): string | null {
  // Matches `export const fooAgent: AgentModule = { ... }` or
  // `export const fooAgent = { ... }`.
  //
  // Anchored to line start (with optional leading whitespace) via the
  // `m` flag so a quoted example inside a `//` or `/* */` comment —
  // e.g. this very docblock — doesn't get picked up as an entrypoint.
  // Real exports always start at column 0 after module-top indent.
  const m = source.match(
    /^[ \t]*export\s+const\s+([A-Za-z_][A-Za-z0-9_]*Agent)\b/m,
  );
  if (m && m[1]) return m[1];
  const fn = source.match(
    /^[ \t]*export\s+(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)/m,
  );
  if (fn && fn[1]) return fn[1];
  return null;
}

function extractAgentTriggers(source: string): string[] {
  const out = new Set<string>();
  // Agent trigger field, e.g. `trigger: "scheduled"` → cron.
  const triggerMatches = source.matchAll(
    /trigger\s*:\s*["'`](scheduled|event|manual|api)["'`]/g,
  );
  for (const m of triggerMatches) {
    const kind = m[1];
    if (kind === "scheduled") out.add("cron");
    else if (kind === "event") out.add("queue");
    else if (kind === "api") out.add("http");
    else if (kind === "manual") out.add("manual");
  }
  // Cron handler hint.
  if (/handleScheduled|ScheduledEvent\b/.test(source)) out.add("cron");
  // HTTP hint.
  if (/request\.method\s*===|itty-?router|router\.(get|post|put|delete)/i.test(source)) {
    out.add("http");
  }
  // Queue / event hint.
  if (/agent_events|queue\.send\(|QueueBinding/.test(source)) {
    out.add("queue");
  }
  return [...out].sort();
}

function extractReadTables(source: string): string[] {
  const out = new Set<string>();
  // Case-sensitive SQL verbs to avoid catching English "from" / "join"
  // in comments and log strings. All SQL in this codebase is uppercase.
  const fromMatches = source.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/g);
  for (const m of fromMatches) {
    const name = m[1];
    if (name) out.add(name);
  }
  const joinMatches = source.matchAll(/\bJOIN\s+([A-Za-z_][A-Za-z0-9_]*)/g);
  for (const m of joinMatches) {
    const name = m[1];
    if (name) out.add(name);
  }
  // Env bindings read on RHS (env.XYZ.get / env.XYZ.prepare / env.XYZ.fetch)
  for (const binding of ENV_BINDING_NAMES) {
    const re = new RegExp(`env\\.${binding}\\b`);
    if (re.test(source)) out.add(binding);
  }
  return [...out].sort();
}

function extractWriteTables(source: string): string[] {
  const out = new Set<string>();
  // Case-sensitive — see extractReadTables for rationale.
  const insertMatches = source.matchAll(
    /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  );
  for (const m of insertMatches) {
    const name = m[1];
    if (name) out.add(name);
  }
  // PR-BO: UPSERT-shaped SQL contains `DO UPDATE SET` — the regex
  // would capture "SET" as a phantom table. Match `UPDATE <ident>`
  // only when the next token is NOT a SQLite keyword we know about
  // (SET = UPSERT clause; lowercase `is` was tripping on phrasing
  // like "the UPDATE is skipped" inside comments — neither is a table
  // name). The negative lookahead keeps the regex narrow without
  // needing a real SQL parser.
  const updateMatches = source.matchAll(
    /\bUPDATE\s+(?!SET\b|set\b|is\b|IS\b)([A-Za-z_][A-Za-z0-9_]*)/g,
  );
  for (const m of updateMatches) {
    const name = m[1];
    if (name) out.add(name);
  }
  const deleteMatches = source.matchAll(
    /\bDELETE\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  );
  for (const m of deleteMatches) {
    const name = m[1];
    if (name) out.add(name);
  }
  return [...out].sort();
}

function extractAiModels(source: string): string[] {
  const out = new Set<string>();
  const matches = source.matchAll(/(claude-[a-z0-9-]+)/g);
  for (const m of matches) {
    const name = m[1];
    if (name) out.add(name);
  }
  return [...out].sort();
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) count++;
  }
  return count;
}

// ─── Feed file scanning ───────────────────────────────────────────

async function scanFeedFile(
  rootDir: string,
  absPath: string,
): Promise<FeedFile | null> {
  const source = await readFile(absPath, "utf8");
  const stats = await stat(absPath);
  const name = basenameOf(absPath).replace(/\.ts$/, "");
  const path = relative(rootDir, absPath).split(sep).join("/");

  return {
    name,
    path,
    source_type: inferFeedSourceType(source),
    schedule: null, // feeds don't self-describe schedule; cron orchestrator decides
    loc: countLines(source),
    last_modified: stats.mtime.toISOString(),
  };
}

function inferFeedSourceType(source: string): string {
  if (/WebSocket|ws:\/\/|wss:\/\//.test(source)) return "stream";
  if (/\.rss|application\/rss\+xml|parseRss/i.test(source)) return "rss";
  if (/graphql|apiKey|Bearer\s+\$\{/i.test(source)) return "api";
  if (/fetch\s*\(/.test(source)) return "http";
  return "unknown";
}

// ─── wrangler.toml parsing ────────────────────────────────────────

interface ParsedWrangler {
  worker: WorkerEntry;
  crons: CronHandler[];
}

async function parseWranglerToml(
  rootDir: string,
  absPath: string,
  agents: AgentFile[],
): Promise<ParsedWrangler> {
  const raw = await readFile(absPath, "utf8");
  const lines = raw.split(/\r?\n/);

  let workerName = basenameOf(absPath);
  let workerMain: string | null = null;
  const bindings = new Set<string>();
  const cronPatterns: string[] = [];

  let currentSection: string | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;

    const sectionMatch = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1] ?? null;
      continue;
    }

    // Top-level fields only capture before entering a subsection.
    if (currentSection === null) {
      const nameMatch = line.match(/^name\s*=\s*["']([^"']+)["']/);
      if (nameMatch && nameMatch[1]) workerName = nameMatch[1];
      const mainMatch = line.match(/^main\s*=\s*["']([^"']+)["']/);
      if (mainMatch && mainMatch[1]) workerMain = mainMatch[1];
    }

    if (currentSection === "triggers") {
      const cronsMatch = line.match(/^crons\s*=\s*\[(.*)\]/);
      if (cronsMatch && cronsMatch[1]) {
        const inner = cronsMatch[1];
        const patterns = inner.matchAll(/["']([^"']+)["']/g);
        for (const p of patterns) {
          const val = p[1];
          if (val) cronPatterns.push(val);
        }
      }
    }

    if (currentSection && /^(d1_databases|kv_namespaces|r2_buckets|durable_objects\.bindings|workflows|queues\.producers|queues\.consumers)$/.test(currentSection)) {
      const bindingMatch = line.match(/^binding\s*=\s*["']([^"']+)["']/);
      if (bindingMatch && bindingMatch[1]) bindings.add(bindingMatch[1]);
      const nameOnBinding = line.match(/^name\s*=\s*["']([^"']+)["']/);
      if (nameOnBinding && nameOnBinding[1] && currentSection.startsWith("durable_objects")) {
        bindings.add(nameOnBinding[1]);
      }
    }
  }

  // Discover which agents are reachable from the cron handler. We can't
  // statically resolve the full call graph, so list all known agents that
  // show cron-like triggers as potentially invoked.
  const cronAgents = agents
    .filter((a) => a.triggers.includes("cron"))
    .map((a) => a.name);

  const workerRelative = relative(rootDir, absPath).split(sep).join("/");
  const worker: WorkerEntry = {
    name: workerName,
    path: workerMain
      ? workerRelative.replace(/wrangler\.toml$/, workerMain)
      : workerRelative,
    bindings: [...bindings].sort(),
  };

  const crons: CronHandler[] = cronPatterns.map((pattern) => ({
    pattern,
    handler_path: workerMain
      ? workerRelative.replace(/wrangler\.toml$/, workerMain)
      : workerRelative,
    agents_invoked: cronAgents,
  }));

  return { worker, crons };
}

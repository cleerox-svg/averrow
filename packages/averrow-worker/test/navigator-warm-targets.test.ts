// Pin: Navigator's KV pre-warm hits the keys the live UI actually reads.
//
// PR7b audit (2026-10): most warms wrote KV keys no client request ever
// produced — the Observatory warms omitted `source_feed` while the ops
// client sends `source_feed=` (empty), live/threat-actors/operations/brands
// warmed parameter sets no page uses, and two warms
// (`/api/observatory/operations`, `/api/dashboard/top-brands`) had no live
// consumer at all. A warm on an unread key is pure D1 spend.
//
// What this pins:
//   1. The exact warm list (phase + path + query string).
//   2. Observatory handlers collapse absent / empty / `all` source_feed to
//      one cache key and treat it as "no filter" in SQL; a real feed value
//      gets its own key and a filter.
//   3. For every warm whose consumer sends query params, the KV key the
//      warm reads/writes equals the key the consumer's request reads.
//      The client query strings are duplicated as LITERALS below (no
//      imports from averrow-ops) with a pointer to the source line — if a
//      client hook changes its params, update both the literal and the
//      matching NAVIGATOR_WARM_TARGETS entry.
//   4. Client-source drift: the literals in (3) can't notice a client
//      change on their own, so section 4 reads the ops / MCP source files
//      with node fs and asserts every param name/value each warm relies on
//      still appears there (and that the unparameterised warms are still
//      requested with no query string). A client edit that changes a
//      warmed param fails here and points at both places to update.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NAVIGATOR_WARM_TARGETS } from "../src/cron/navigator";
import {
  handleObservatoryNodes,
  handleObservatoryArcs,
  handleObservatoryStats,
  handleObservatoryLive,
  normalizeSourceFeed,
} from "../src/handlers/observatory";
import { handleListOperations } from "../src/handlers/operations";
import { handleListBrands } from "../src/handlers/brands";
import { handleListThreatActors } from "../src/handlers/threatActors";
import { handleDashboardOverview } from "../src/handlers/dashboard";
import type { Env } from "../src/types";

// ─── Harness ────────────────────────────────────────────────────────

interface Harness {
  env: Env;
  cacheReads: string[];
  sql: string[];
  binds: unknown[][];
}

/**
 * `hit: true` → every CACHE.get returns a payload so the handler
 * short-circuits right after building its key (we only want the key).
 * `hit: false` → cache misses so the handler runs its SQL against a
 * stub DB that records every statement + bind.
 */
function makeHarness(hit: boolean): Harness {
  const cacheReads: string[] = [];
  const sql: string[] = [];
  const binds: unknown[][] = [];

  const stmt = (text: string) => {
    sql.push(text);
    const run = {
      async first<T>(): Promise<T | null> {
        return { n: 0 } as unknown as T;
      },
      async all<T>(): Promise<{ results: T[]; meta: Record<string, unknown> }> {
        return { results: [], meta: {} };
      },
      async run() {
        return { success: true, meta: {} };
      },
    };
    return {
      bind: (...args: unknown[]) => {
        binds.push(args);
        return run;
      },
      ...run,
    };
  };

  const db = {
    prepare: (text: string) => stmt(text),
    withSession: () => ({ prepare: (text: string) => stmt(text), getBookmark: () => null }),
  };

  const cache = {
    async get(key: string): Promise<string | null> {
      cacheReads.push(key);
      return hit ? JSON.stringify({ success: true, data: [] }) : null;
    },
    async put(): Promise<void> {},
  };

  return { env: { DB: db, CACHE: cache } as unknown as Env, cacheReads, sql, binds };
}

const req = (path: string) => new Request(`https://averrow.com${path}`);

type Handler = (request: Request, env: Env) => Promise<Response>;

/** The first KV key `handler` reads for `path`. */
async function firstCacheKey(handler: Handler, path: string): Promise<string> {
  const h = makeHarness(true);
  await handler(req(path), h.env);
  expect(h.cacheReads.length).toBeGreaterThan(0);
  return h.cacheReads[0];
}

// ─── 1. Warm list pin ───────────────────────────────────────────────

describe("NAVIGATOR_WARM_TARGETS — pinned list", () => {
  it("warms exactly these paths, in these phases", () => {
    expect(NAVIGATOR_WARM_TARGETS.map((t) => `${t.phase} ${t.path}`)).toEqual([
      "A /api/observatory/nodes?period=7d",
      "A /api/observatory/arcs?period=7d",
      "A /api/observatory/stats?period=7d",
      "A /api/observatory/live?limit=8",
      "A /api/v1/operations?limit=4&offset=0&status=active",
      "A2 /api/observatory/nodes?period=24h",
      "A2 /api/observatory/arcs?period=24h",
      "A2 /api/observatory/stats?period=24h",
      "A2 /api/observatory/nodes?period=30d",
      "A2 /api/observatory/arcs?period=30d",
      "A2 /api/observatory/stats?period=30d",
      "B /api/dashboard/overview",
      "B /api/agents",
      "B /api/v1/operations?limit=12&offset=0",
      "B /api/v1/operations/stats",
      "B /api/feeds/aggregate-stats",
      "B /api/admin/dashboard",
      "C /api/brands?view=top&limit=8&offset=0&range=7d",
      "C /api/brands/stats",
      "C /api/threat-actors?status=active",
      "C /api/threat-actors/stats",
    ]);
  });

  it("never warms a retired target", () => {
    const paths = NAVIGATOR_WARM_TARGETS.map((t) => t.path);
    expect(paths.some((p) => p.startsWith("/api/observatory/operations"))).toBe(false);
    expect(paths.some((p) => p.startsWith("/api/dashboard/top-brands"))).toBe(false);
  });

  it("every target names its consumer and paths are unique", () => {
    for (const t of NAVIGATOR_WARM_TARGETS) expect(t.consumer.length).toBeGreaterThan(0);
    const paths = NAVIGATOR_WARM_TARGETS.map((t) => t.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

// ─── 2. Observatory source_feed normalisation ───────────────────────

describe("normalizeSourceFeed", () => {
  it("collapses absent, empty and 'all' to null; keeps real feeds", () => {
    expect(normalizeSourceFeed(null)).toBeNull();
    expect(normalizeSourceFeed("")).toBeNull();
    expect(normalizeSourceFeed("all")).toBeNull();
    expect(normalizeSourceFeed("spam_trap")).toBe("spam_trap");
    expect(normalizeSourceFeed("feeds")).toBe("feeds");
    expect(normalizeSourceFeed("urlhaus")).toBe("urlhaus");
  });
});

const SOURCE_FEED_HANDLERS: Array<{ name: string; handler: Handler; base: string; prefix: string }> = [
  { name: "nodes", handler: handleObservatoryNodes, base: "/api/observatory/nodes?period=7d", prefix: "observatory_nodes:7d:" },
  { name: "arcs", handler: handleObservatoryArcs, base: "/api/observatory/arcs?period=7d", prefix: "observatory_arcs:7d:" },
  { name: "stats", handler: handleObservatoryStats, base: "/api/observatory/stats?period=7d", prefix: "observatory_stats:7d:" },
  { name: "live", handler: handleObservatoryLive, base: "/api/observatory/live?limit=8", prefix: "observatory_live:" },
];

describe("observatory handlers — source_feed cache key", () => {
  for (const { name, handler, base, prefix } of SOURCE_FEED_HANDLERS) {
    it(`${name}: absent, empty and 'all' source_feed share one key`, async () => {
      const absent = await firstCacheKey(handler, base);
      const empty = await firstCacheKey(handler, `${base}&source_feed=`);
      const all = await firstCacheKey(handler, `${base}&source_feed=all`);
      expect(absent.startsWith(prefix)).toBe(true);
      expect(absent).toContain(":all");
      expect(empty).toBe(absent);
      expect(all).toBe(absent);
    });

    it(`${name}: a real source_feed gets a distinct key`, async () => {
      const absent = await firstCacheKey(handler, base);
      const spam = await firstCacheKey(handler, `${base}&source_feed=spam_trap`);
      expect(spam).not.toBe(absent);
      expect(spam).toContain("spam_trap");
    });

    it(`${name}: empty source_feed applies no SQL filter; a real feed does`, async () => {
      const empty = makeHarness(false);
      await handler(req(`${base}&source_feed=`), empty.env);
      expect(empty.sql.length).toBeGreaterThan(0);
      expect(empty.sql.some((s) => /source_feed\s*(=|!=)/.test(s))).toBe(false);

      const real = makeHarness(false);
      await handler(req(`${base}&source_feed=urlhaus`), real.env);
      expect(real.sql.some((s) => /source_feed\s*=\s*\?/.test(s))).toBe(true);
      expect(real.binds.some((b) => b.includes("urlhaus"))).toBe(true);
    });
  }
});

// ─── 3. Warm key === live client key ────────────────────────────────

/**
 * Client requests, duplicated as literals. Query-string order matters
 * only where a handler would key on it (none do today), but the literals
 * are kept byte-for-byte to what the client builds.
 */
const CLIENT_REQUESTS: Array<{ warm: string; client: string; source: string; handler: Handler }> = [
  // useObservatoryQuery.buildUrl keeps insertion order: period, source_feed, limit.
  { warm: "/api/observatory/nodes?period=7d", client: "/api/observatory/nodes?period=7d&source_feed=&limit=2000", source: "averrow-ops/src/hooks/useObservatory.ts:54-57", handler: handleObservatoryNodes },
  { warm: "/api/observatory/arcs?period=7d", client: "/api/observatory/arcs?period=7d&source_feed=", source: "averrow-ops/src/hooks/useObservatory.ts:78-81", handler: handleObservatoryArcs },
  { warm: "/api/observatory/stats?period=7d", client: "/api/observatory/stats?period=7d&source_feed=", source: "averrow-ops/src/hooks/useObservatory.ts:66-69", handler: handleObservatoryStats },
  { warm: "/api/observatory/nodes?period=24h", client: "/api/observatory/nodes?period=24h&source_feed=&limit=2000", source: "averrow-ops/src/hooks/useObservatory.ts:54-57", handler: handleObservatoryNodes },
  { warm: "/api/observatory/arcs?period=24h", client: "/api/observatory/arcs?period=24h&source_feed=", source: "averrow-ops/src/hooks/useObservatory.ts:78-81", handler: handleObservatoryArcs },
  { warm: "/api/observatory/stats?period=24h", client: "/api/observatory/stats?period=24h&source_feed=", source: "averrow-ops/src/hooks/useObservatory.ts:66-69", handler: handleObservatoryStats },
  { warm: "/api/observatory/nodes?period=30d", client: "/api/observatory/nodes?period=30d&source_feed=&limit=2000", source: "averrow-ops/src/hooks/useObservatory.ts:54-57", handler: handleObservatoryNodes },
  { warm: "/api/observatory/arcs?period=30d", client: "/api/observatory/arcs?period=30d&source_feed=", source: "averrow-ops/src/hooks/useObservatory.ts:78-81", handler: handleObservatoryArcs },
  { warm: "/api/observatory/stats?period=30d", client: "/api/observatory/stats?period=30d&source_feed=", source: "averrow-ops/src/hooks/useObservatory.ts:66-69", handler: handleObservatoryStats },
  // SidePanel LiveFeedWidget.
  { warm: "/api/observatory/live?limit=8", client: "/api/observatory/live?limit=8", source: "averrow-ops/src/features/observatory-v3/components/SidePanel.tsx:481", handler: handleObservatoryLive },
  // useOperations: URLSearchParams({limit, offset}) then .set('status').
  { warm: "/api/v1/operations?limit=4&offset=0&status=active", client: "/api/v1/operations?limit=4&offset=0&status=active", source: "averrow-ops/src/features/observatory-v3/components/SidePanel.tsx:310 + hooks/useOperations.ts:44-46", handler: handleListOperations },
  { warm: "/api/v1/operations?limit=12&offset=0", client: "/api/v1/operations?limit=12&offset=0", source: "averrow-ops/src/features/campaigns/Campaigns.tsx:681 + hooks/useOperations.ts:44-46", handler: handleListOperations },
  // useBrands: URLSearchParams({view, limit, offset, range}). The route
  // passes getOrgScope() — null for every staff role ("global" key, PR-F).
  { warm: "/api/brands?view=top&limit=8&offset=0&range=7d", client: "/api/brands?view=top&limit=8&offset=0&range=7d", source: "averrow-ops/src/features/observatory-v3/components/SidePanel.tsx:235 + hooks/useBrands.ts:95-97", handler: (r, e) => handleListBrands(r, e, null) },
  // ThreatActors default: status=active, no country/q, no limit.
  { warm: "/api/threat-actors?status=active", client: "/api/threat-actors?status=active", source: "averrow-ops/src/features/threat-actors/ThreatActors.tsx:353-357 + hooks/useThreatActors.ts:91-98", handler: handleListThreatActors },
  // MCP smoke probe (service JWT, auditor → scope null).
  { warm: "/api/dashboard/overview", client: "/api/dashboard/overview", source: "averrow-mcp/src/index.ts:354", handler: (r, e) => handleDashboardOverview(r, e, null) },
];

describe("warm KV key === live client KV key", () => {
  for (const { warm, client, source, handler } of CLIENT_REQUESTS) {
    it(`${warm} serves ${client} (${source})`, async () => {
      const target = NAVIGATOR_WARM_TARGETS.find((t) => t.path === warm);
      expect(target, `no warm target for ${warm}`).toBeDefined();
      const warmKey = await firstCacheKey(target!.handler, warm);
      const clientKey = await firstCacheKey(handler, client);
      expect(warmKey).toBe(clientKey);
    });
  }

  it("every param-bearing warm target is covered above", () => {
    const covered = new Set(CLIENT_REQUESTS.map((c) => c.warm));
    const parameterised = NAVIGATOR_WARM_TARGETS.filter((t) => t.path.includes("?")).map((t) => t.path);
    expect(parameterised.filter((p) => !covered.has(p))).toEqual([]);
  });

  it("regression: the pre-PR7b warm params missed the client keys", async () => {
    // threat-actors warmed ?limit=50 while the page sends ?status=active.
    expect(await firstCacheKey(handleListThreatActors, "/api/threat-actors?limit=50"))
      .not.toBe(await firstCacheKey(handleListThreatActors, "/api/threat-actors?status=active"));
    // live warmed ?limit=20 while the side panel sends ?limit=8.
    expect(await firstCacheKey(handleObservatoryLive, "/api/observatory/live?limit=20"))
      .not.toBe(await firstCacheKey(handleObservatoryLive, "/api/observatory/live?limit=8"));
  });
});

// ─── 4. Client-source drift ─────────────────────────────────────────

/** Repo `packages/` dir, resolved from this test file. */
const PACKAGES_DIR = resolve(__dirname, "../..");

interface SourceCheck {
  /** Repo-relative to `packages/`. */
  file: string;
  /** Each must match somewhere in the file. */
  present: RegExp[];
  /** Each must NOT match anywhere in the file. */
  absent?: RegExp[];
}

/**
 * Per warm path: the client source(s) whose request the warm mirrors,
 * and the param names/values it depends on. Regexes target the param
 * name + value with `\s*` between tokens so reformatting (spacing,
 * line breaks, quote-adjacent whitespace) doesn't trip them; only a
 * change to WHAT is sent does.
 *
 * Unparameterised warms assert the client requests the path as a
 * closed string literal (`'/api/agents'` — the quote right after the
 * path means no `?query` is appended).
 */
const OPS = "averrow-ops/src";
const USE_OBS = `${OPS}/hooks/useObservatory.ts`;
const OBS_V3 = `${OPS}/features/observatory-v3/ObservatoryV3.tsx`;
const SIDE_PANEL = `${OPS}/features/observatory-v3/components/SidePanel.tsx`;
const USE_OPS = `${OPS}/hooks/useOperations.ts`;
const USE_BRANDS = `${OPS}/hooks/useBrands.ts`;
const USE_TA = `${OPS}/hooks/useThreatActors.ts`;
const MCP = "averrow-mcp/src/index.ts";

/** Closed string literal for `path` — any quote style, nothing after the path. */
const closedLiteral = (path: string) =>
  new RegExp(`['"\`]${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}['"\`]`);

/** Observatory hook: endpoint + `source_feed` sent empty for the `all` view. */
const observatoryHook = (endpoint: string): SourceCheck => ({
  file: USE_OBS,
  present: [
    closedLiteral(endpoint),
    // `source_feed: source === 'all' ? '' : source` — the empty value the
    // handlers normalise to the `all` key segment.
    /\bsource_feed\s*:\s*source\s*===\s*['"]all['"]\s*\?\s*(''|"")/,
    /\bsource\s*=\s*['"]all['"]/,
    /\bperiod\s*=\s*['"]7d['"]/,
  ],
});

/** ObservatoryV3 period toggle offers `period` (7d is the default state). */
const observatoryPeriod = (period: string): SourceCheck => ({
  file: OBS_V3,
  present: period === "7d"
    ? [/useState\(\s*['"]7d['"]\s*\)/]
    : [new RegExp(`\\bid\\s*:\\s*['"]${period}['"]`)],
});

const useOperationsHook: SourceCheck = {
  file: USE_OPS,
  present: [
    /\/api\/v1\/operations\?\$\{params\}/,
    /\blimit\s*:\s*String\(\s*limit\s*\)/,
    /\boffset\s*:\s*String\(\s*offset\s*\)/,
    /\boffset\s*=\s*0\b/,
    /params\.set\(\s*['"]status['"]\s*,\s*status\s*\)/,
  ],
};

const SOURCE_CHECKS: Record<string, SourceCheck[]> = {
  // Phase A / A2 — Observatory.
  ...Object.fromEntries(
    (["7d", "24h", "30d"] as const).flatMap((period) =>
      (["nodes", "arcs", "stats"] as const).map((kind) => [
        `/api/observatory/${kind}?period=${period}`,
        [observatoryHook(`/api/observatory/${kind}`), observatoryPeriod(period)],
      ]),
    ),
  ),
  "/api/observatory/live?limit=8": [
    { file: SIDE_PANEL, present: [/\/api\/observatory\/live\?limit=8\b/] },
  ],
  "/api/v1/operations?limit=4&offset=0&status=active": [
    {
      file: SIDE_PANEL,
      present: [
        /useOperations\(\s*\{[^}]*\bstatus\s*:\s*['"]active['"][^}]*\}\s*\)/,
        /useOperations\(\s*\{[^}]*\blimit\s*:\s*4\b[^}]*\}\s*\)/,
      ],
      // No explicit offset → the hook's default 0, which the warm sends.
      absent: [/useOperations\(\s*\{[^}]*\boffset\s*:[^}]*\}\s*\)/],
    },
    useOperationsHook,
  ],
  // Phase B.
  "/api/dashboard/overview": [
    { file: MCP, present: [/\bpath\s*:\s*['"]\/api\/dashboard\/overview['"]/] },
  ],
  "/api/agents": [{ file: `${OPS}/hooks/useAgents.ts`, present: [closedLiteral("/api/agents")] }],
  "/api/v1/operations?limit=12&offset=0": [
    {
      file: `${OPS}/features/campaigns/Campaigns.tsx`,
      // `useOperations({ limit: focusId ? 100 : 12 })` — default list is 12, no status.
      present: [/useOperations\(\s*\{[^}]*\blimit\s*:[^}]*:\s*12\b[^}]*\}\s*\)/],
      absent: [/useOperations\(\s*\{[^}]*\b(status|offset)\s*:[^}]*:\s*12\b[^}]*\}\s*\)/],
    },
    useOperationsHook,
  ],
  "/api/v1/operations/stats": [{ file: USE_OPS, present: [closedLiteral("/api/v1/operations/stats")] }],
  "/api/feeds/aggregate-stats": [{ file: `${OPS}/hooks/useFeeds.ts`, present: [closedLiteral("/api/feeds/aggregate-stats")] }],
  "/api/admin/dashboard": [{ file: `${OPS}/hooks/useDashboardSnapshot.ts`, present: [closedLiteral("/api/admin/dashboard")] }],
  // Phase C.
  "/api/brands?view=top&limit=8&offset=0&range=7d": [
    {
      file: SIDE_PANEL,
      present: [
        /useBrands\(\s*\{[^}]*\bview\s*:\s*['"]top['"][^}]*\}\s*\)/,
        /useBrands\(\s*\{[^}]*\blimit\s*:\s*8\b[^}]*\}\s*\)/,
        /useBrands\(\s*\{[^}]*\btimeRange\s*:\s*period\b[^}]*\}\s*\)/,
      ],
      absent: [/useBrands\(\s*\{[^}]*\b(offset|search)\s*:[^}]*\}\s*\)/],
    },
    {
      file: USE_BRANDS,
      present: [
        /\/api\/brands\?\$\{params\}/,
        /\bview\s*=\s*['"]top['"]/,
        /\boffset\s*=\s*0\b/,
        /\btimeRange\s*=\s*['"]7d['"]/,
        /\blimit\s*:\s*String\(\s*limit\s*\)/,
        /\boffset\s*:\s*String\(\s*offset\s*\)/,
        /\brange\s*:\s*timeRange\b/,
      ],
    },
  ],
  "/api/brands/stats": [{ file: USE_BRANDS, present: [closedLiteral("/api/brands/stats")] }],
  "/api/threat-actors?status=active": [
    {
      file: `${OPS}/features/threat-actors/ThreatActors.tsx`,
      // Default (non-broadened) view sends status=active.
      present: [/\bstatus\s*:[^,}]*['"]active['"]/],
    },
    {
      file: USE_TA,
      present: [
        /params\.set\(\s*['"]status['"]\s*,\s*status\s*\)/,
        /\/api\/threat-actors\$\{\s*qs\b/,
      ],
      // The warm sends no limit/offset; a client that starts paginating
      // the list changes the key.
      absent: [/params\.set\(\s*['"](limit|offset)['"]/],
    },
  ],
  "/api/threat-actors/stats": [{ file: USE_TA, present: [closedLiteral("/api/threat-actors/stats")] }],
};

const sourceCache = new Map<string, string>();
function readSource(file: string): string {
  let src = sourceCache.get(file);
  if (src === undefined) {
    src = readFileSync(resolve(PACKAGES_DIR, file), "utf-8");
    sourceCache.set(file, src);
  }
  return src;
}

/** Human-readable list of every failed expectation for `check` against `src`. */
function sourceViolations(check: SourceCheck, src: string): string[] {
  const out: string[] = [];
  for (const re of check.present) if (!re.test(src)) out.push(`${check.file}: missing ${re}`);
  for (const re of check.absent ?? []) if (re.test(src)) out.push(`${check.file}: unexpected ${re}`);
  return out;
}

describe("client source still sends what each warm mirrors", () => {
  it("every warm target has a source check", () => {
    const missing = NAVIGATOR_WARM_TARGETS.map((t) => t.path).filter((p) => !SOURCE_CHECKS[p]);
    expect(missing).toEqual([]);
  });

  for (const [warm, checks] of Object.entries(SOURCE_CHECKS)) {
    it(`${warm} — client source unchanged`, () => {
      const violations = checks.flatMap((c) => sourceViolations(c, readSource(c.file)));
      expect(
        violations,
        `client drifted from warm ${warm}; update the client or NAVIGATOR_WARM_TARGETS + CLIENT_REQUESTS`,
      ).toEqual([]);
    });
  }

  // Mutation check: apply a realistic client edit to an in-memory copy of
  // the real source (the ops files are never touched) and confirm the
  // matching check now reports it. Guards against regexes that silently
  // match anything.
  const MUTATIONS: Array<{ warm: string; file: string; from: RegExp; to: string }> = [
    { warm: "/api/observatory/live?limit=8", file: SIDE_PANEL, from: /live\?limit=8/, to: "live?limit=10" },
    { warm: "/api/observatory/nodes?period=7d", file: USE_OBS, from: /source_feed:/g, to: "feed:" },
    { warm: "/api/observatory/stats?period=7d", file: USE_OBS, from: /\? '' : source/g, to: "? 'all' : source" },
    { warm: "/api/observatory/arcs?period=30d", file: OBS_V3, from: /id: '30d'/, to: "id: '90d'" },
    { warm: "/api/v1/operations?limit=4&offset=0&status=active", file: SIDE_PANEL, from: /status: 'active', limit: 4/, to: "status: 'active', limit: 5" },
    { warm: "/api/v1/operations?limit=4&offset=0&status=active", file: USE_OPS, from: /params\.set\('status'/, to: "params.set('state'" },
    { warm: "/api/v1/operations?limit=12&offset=0", file: `${OPS}/features/campaigns/Campaigns.tsx`, from: /: 12 \}/, to: ": 20 }" },
    { warm: "/api/brands?view=top&limit=8&offset=0&range=7d", file: SIDE_PANEL, from: /view: 'top', limit: 8/, to: "view: 'top', limit: 8, offset: 8" },
    { warm: "/api/threat-actors?status=active", file: USE_TA, from: /if \(status\) params\.set\('status', status\);/, to: "if (status) params.set('status', status); params.set('limit', '50');" },
    { warm: "/api/agents", file: `${OPS}/hooks/useAgents.ts`, from: /'\/api\/agents'/, to: "'/api/agents?include=retired'" },
    { warm: "/api/brands/stats", file: USE_BRANDS, from: /'\/api\/brands\/stats'/, to: "`/api/brands/stats?range=${r}`" },
  ];

  for (const { warm, file, from, to } of MUTATIONS) {
    it(`mutation ${file.split("/").pop()} ${from} → ${to} is caught for ${warm}`, () => {
      const original = readSource(file);
      const mutated = original.replace(from, to);
      expect(mutated, `mutation pattern ${from} no longer matches ${file}`).not.toBe(original);
      const checks = SOURCE_CHECKS[warm].filter((c) => c.file === file);
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.flatMap((c) => sourceViolations(c, original))).toEqual([]);
      expect(checks.flatMap((c) => sourceViolations(c, mutated)).length).toBeGreaterThan(0);
    });
  }
});

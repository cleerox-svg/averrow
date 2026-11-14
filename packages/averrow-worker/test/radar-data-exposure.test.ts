// Pin: Cloudflare Radar-derived data stays on staff-only surfaces.
//
// Cloudflare Radar API data is licensed CC BY-NC 4.0. The low-risk reading
// for a paid product is that Radar-derived numbers never reach a tenant
// screen, a public/unauthenticated route or marketing. Today every reader
// is behind requireStaff:
//
//   bot_traffic_snapshots / radar_country_snapshots (feed cf_radar_bots)
//     → handlers/botTraffic.ts        GET /api/bot-traffic         (requireStaff)
//     → handlers/observatoryLenses.ts GET /api/observatory/overindex (requireStaff)
//       ↳ reused by handlers/observatoryEvents.ts spike events
//         (GET /api/observatory/events, requireStaff) and Navigator's KV warm
//   agent_outputs 'cf_email_<date>' (feed cloudflare_email, agent 'observer')
//     → GET /api/trends/intelligence, /api/agents/outputs,
//       /api/agents/:name/outputs, /api/agents/stats   (requireStaff)
//
// The router-level 401/403 behaviour of /api/bot-traffic and the
// /api/observatory/* routes is already pinned by
// test/bot-traffic-handler.test.ts and test/observatory-routes-auth.test.ts.
// This file pins the SOURCE graph so a new reader can't appear quietly:
//   1. only the allowlisted files reference the Radar tables;
//   2. only the allowlisted files import the Radar-bearing handlers;
//   3. no tenant / public file references any of them;
//   4. the agent_outputs routes that can return the cf_email insight are
//      requireStaff-wrapped.
// A new legitimate (staff-only) reader means updating the allowlist here —
// on purpose, after checking the licence.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

const FILES = walk(SRC)
  .map((abs) => ({ rel: relative(SRC, abs).split(sep).join("/"), text: readFileSync(abs, "utf8") }))
  // Generated architect snapshot: a static source index, not a reader.
  .filter((f) => f.rel !== "agents/architect/manifest.generated.ts");

/** Strip // and /* *\/ comments so a mention in prose doesn't count as a reader. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function filesMatching(re: RegExp): string[] {
  return FILES.filter((f) => re.test(code(f.text))).map((f) => f.rel).sort();
}

const RADAR_TABLES = /\b(bot_traffic_snapshots|radar_country_snapshots)\b/;
const RADAR_HANDLERS = /\b(handleBotTraffic|handleObservatoryOverindex|handleObservatoryEvents)\b/;
const CF_EMAIL = /cf_email_/;

describe("Radar-derived data: source graph stays staff-only", () => {
  it("only allowlisted files reference the Radar snapshot tables", () => {
    expect(filesMatching(RADAR_TABLES)).toEqual([
      "feeds/cf_radar_bots.ts",
      "handlers/botTraffic.ts",
      "handlers/observatoryLenses.ts",
    ]);
  });

  it("only allowlisted files reference the Radar-bearing handlers", () => {
    expect(filesMatching(RADAR_HANDLERS)).toEqual([
      "cron/navigator.ts",
      "handlers/botTraffic.ts",
      "handlers/observatoryEvents.ts",
      "handlers/observatoryLenses.ts",
      "routes/dashboard.ts",
    ]);
  });

  it("only the cloudflare_email feed writes/reads the cf_email_ keys", () => {
    expect(filesMatching(CF_EMAIL)).toEqual(["feeds/cloudflare_email.ts"]);
  });

  it("no tenant or public file touches Radar data", () => {
    const exposed = FILES
      .filter((f) => /(^|\/)(tenant|public)[^/]*\.ts$/i.test(f.rel) || f.rel === "routes/tenant.ts")
      .filter((f) => {
        const c = code(f.text);
        return RADAR_TABLES.test(c) || RADAR_HANDLERS.test(c) || CF_EMAIL.test(c) || /cloudflare_radar/.test(c);
      })
      .map((f) => f.rel);
    expect(exposed).toEqual([]);
  });

  it.each([
    ["routes/dashboard.ts", "/api/bot-traffic"],
    ["routes/dashboard.ts", "/api/trends/intelligence"],
    ["routes/agents.ts", "/api/agents/outputs"],
    ["routes/agents.ts", "/api/agents/:name/outputs"],
    ["routes/agents.ts", "/api/agents/stats"],
  ])("%s %s is requireStaff-wrapped", (file, path) => {
    const text = readFileSync(join(SRC, file), "utf8");
    const at = text.indexOf(`router.get("${path}"`);
    expect(at, `${path} route not found in ${file}`).toBeGreaterThan(-1);
    // The guard must be the first thing in the route body.
    const body = text.slice(at, at + 400);
    expect(body).toMatch(/=>\s*\{\s*const ctx = await requireStaff\(request, env\);\s*if \(!isAuthContext\(ctx\)\) return ctx;/);
  });
});

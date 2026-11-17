// Pin: IOK phishing-kit matches stay staff-only CONTEXT.
//
// The matches come from a third-party ruleset (IOK by phish.report, ODbL —
// src/data/iok/SOURCE.md). Two contracts:
//   1. they never reach a tenant / public surface (no ODbL §4.3 notice or
//      §4.6 offer is wired for that, and the product decision is staff-only);
//   2. they never drive alerts or triage — only lib/page-capture.ts writes
//      them, and only the staff detection detail reads them.
// This file pins the SOURCE graph so a new reader / writer can't appear
// quietly. Runtime behaviour (no createAlert, upserts, stamps) is pinned in
// test/page-capture.test.ts; the detail shape in test/identity-detections.test.ts.

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
  .filter((f) => f.rel !== "agents/architect/manifest.generated.ts");

/** Strip comments so a mention in prose doesn't count as a reader. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function filesMatching(re: RegExp): string[] {
  return FILES.filter((f) => re.test(code(f.text))).map((f) => f.rel).sort();
}

describe("IOK kit matches: source graph stays staff-only context", () => {
  it("only lib/iok-kit-matches.ts touches the matches table", () => {
    expect(filesMatching(/\bpage_capture_kit_matches\b/)).toEqual(["lib/iok-kit-matches.ts"]);
  });

  it("only the capture pipeline and the staff detection detail import the kit-match module", () => {
    expect(filesMatching(/["']\.\.?\/(?:lib\/)?iok-kit-matches["']/)).toEqual([
      "handlers/identityDetections.ts",
      "lib/page-capture.ts",
    ]);
    expect(filesMatching(/["']\.\.?\/(?:lib\/)?iok-ruleset["']/)).toEqual(["lib/page-capture.ts"]);
    expect(filesMatching(/["']\.\.?\/(?:lib\/)?iok-engine["']/)).toEqual([
      "lib/iok-kit-matches.ts",
      "lib/iok-ruleset.ts",
    ]);
  });

  it("the capture read model (toCaptureView / getIdentityDetection) has only staff readers", () => {
    expect(filesMatching(/\btoCaptureView\b/)).toEqual(["handlers/identityDetections.ts", "lib/page-capture.ts"]);
    expect(filesMatching(/["']\.\.?\/handlers\/identityDetections["']|["']\.\/identityDetections["']/)).toEqual([
      "routes/threats.ts",
    ]);
  });

  it("no tenant or public file references kit matches, captures or the IOK modules", () => {
    const exposed = FILES
      .filter((f) => /(^|\/)(tenant|public)[^/]*\.ts$/i.test(f.rel) || f.rel === "routes/tenant.ts")
      .filter((f) => /\b(kit_matching|page_capture_kit_matches|iok-kit-matches|iok-ruleset|iok-engine|toCaptureView|page_captures)\b/.test(code(f.text)))
      .map((f) => f.rel);
    expect(exposed).toEqual([]);
  });

  it("nothing in the kit-match path can raise an alert or write triage state", () => {
    for (const rel of ["lib/iok-kit-matches.ts", "lib/iok-engine.ts", "lib/iok-ruleset.ts"]) {
      const c = code(FILES.find((f) => f.rel === rel)!.text);
      expect(c, rel).not.toMatch(/createAlert|alert-triage|alert-fanout|\balerts\b|UPDATE\s+threats|severity/);
    }
  });

  it.each([
    "/api/intel/identity-threats/detections/:threatId",
    "/api/intel/identity-threats/detections",
  ])("%s is requireStaff-wrapped", (path) => {
    const text = readFileSync(join(SRC, "routes", "threats.ts"), "utf8");
    const at = text.indexOf(`router.get("${path}"`);
    expect(at).toBeGreaterThan(-1);
    const body = text.slice(at, at + 400);
    expect(body).toMatch(/^router\.get\("[^"]+", async \([^)]*\) => \{\s*const ctx = await requireStaff\(request, env\);\s*if \(!isAuthContext\(ctx\)\) return ctx;/);
  });
});

// ─── Network evidence (migration 0335): header / cookie values are private ───
// network.json holds response headers, cookie VALUES and the raw body. The
// object has no reader at all: this pins that it stays that way.
describe("network evidence object stays unreachable", () => {
  it("only the capture pipeline and the two browser drivers touch the network evidence module", () => {
    // lib/site-script-browser.ts (Site Script Watch) imports only the size
    // tracker / body-size verdict / caps and the interceptor's collector; it
    // never serializes, stores or reads a network.json object (pinned below).
    expect(filesMatching(/["']\.\.?\/(?:lib\/)?page-capture-network["']|["']\.\/page-capture-network["']/)).toEqual([
      "lib/page-capture-browser.ts",
      "lib/page-capture.ts",
      "lib/site-script-browser.ts",
    ]);
    const ssb = code(FILES.find((f) => f.rel === "lib/site-script-browser.ts")!.text);
    expect(ssb).not.toMatch(/serializeNetworkEvidence|toIokNetworkInput|summarizeNetworkEvidence|\.finish\(/);
  });

  it("only lib/page-capture.ts names the object key or its D1 columns", () => {
    expect(filesMatching(/network\.json/)).toEqual(["lib/page-capture.ts"]);
    expect(filesMatching(/\bnet_evidence_(?:status|sha256)\b|\bnet_(?:requests|headers|cookies)\b/)).toEqual(["lib/page-capture.ts"]);
  });

  it("the staff evidence routes can only read the three keys they always read", () => {
    const h = code(FILES.find((f) => f.rel === "handlers/pageCaptures.ts")!.text);
    expect(h).toMatch(/SELECT desktop_key, mobile_key, html_key FROM page_captures WHERE id = \?/);
    expect(h).not.toMatch(/network|net_evidence|net_(?:requests|headers|cookies)/);
    const routes = readFileSync(join(SRC, "routes", "threats.ts"), "utf8");
    expect([...routes.matchAll(/router\.\w+\("(\/api\/intel\/captures\/[^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
      "/api/intel/captures/:id/html",
      "/api/intel/captures/:id/screenshot",
    ]);
  });

  it("the staff detection read model never selects or returns the network columns", async () => {
    const { CAPTURE_DETAIL_SQL, toCaptureView } = await import("../src/lib/page-capture");
    expect(CAPTURE_DETAIL_SQL).not.toMatch(/\bnet_/);
    const view = toCaptureView({
      id: "pc_x", status: "captured", queued_at: "2026-11-15 00:00:00", captured_at: null, expires_at: null, final_url: null, http_status: 200,
      page_title: null, redirect_chain_json: null, form_action_hosts_json: null, anti_bot_wall: null, error: null,
      desktop_key: null, mobile_key: null, html_key: null, desktop_sha256: null, mobile_sha256: null, html_sha256: null,
      kit_ruleset_commit: null, kit_evaluated_at: null, kit_eval_status: null,
      // A row someone widened to SELECT * must still not surface these.
      net_evidence_status: "complete", net_evidence_sha256: "abc", net_requests: 3, net_headers: 2, net_cookies: 1,
    } as never);
    expect(JSON.stringify(view)).not.toMatch(/net_|network|cookie|header/i);
  });

  it("no tenant or public file reaches the evidence module, key or columns", () => {
    const exposed = FILES
      .filter((f) => /(^|\/)(tenant|public)[^/]*\.ts$/i.test(f.rel) || f.rel === "routes/tenant.ts")
      .filter((f) => /page-capture-network|network\.json|\bnet_evidence_|\bNetworkEvidence\b/.test(code(f.text)))
      .map((f) => f.rel);
    expect(exposed).toEqual([]);
  });

  it("the collector module neither logs nor makes a request of its own", () => {
    const c = code(FILES.find((f) => f.rel === "lib/page-capture-network.ts")!.text);
    expect(c).not.toMatch(/\bconsole\b|\bfetch\s*\(|XMLHttpRequest|\bWebSocket\b|navigator\.sendBeacon/);
    // No D1 / R2 either: it only builds data.
    expect(c).not.toMatch(/\.prepare\(|PHISH_CAPTURES|\.put\(/);
  });

  it("the IOK engine and kit-match glue do not import the evidence module (plain data only)", () => {
    for (const rel of ["lib/iok-engine.ts", "lib/iok-kit-matches.ts", "lib/iok-ruleset.ts"]) {
      expect(code(FILES.find((f) => f.rel === rel)!.text), rel).not.toMatch(/page-capture-network/);
    }
  });
});

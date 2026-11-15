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

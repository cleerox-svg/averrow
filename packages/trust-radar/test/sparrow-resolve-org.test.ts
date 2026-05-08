// Phase C C2 — verify Sparrow's takedown creators stamp the
// correct module_key. The org_id derivation lives in the helper
// (resolveOwningOrgId) which is exercised end-to-end via the
// takedown_authorizations + entitlements gates already covered
// elsewhere; this test pins down the SQL shape so a future edit
// can't silently drop the column.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SPARROW_SRC = readFileSync(
  resolve(__dirname, "../src/agents/sparrow.ts"),
  "utf-8",
);

interface Site {
  matcher: RegExp;
  expectedModuleKey: string;
}

const SITES: Site[] = [
  {
    matcher: /'url_scan'/,
    expectedModuleKey: "domain",
  },
  {
    matcher: /'social_profile', \?, \?, \?, 'social_profile'/,
    expectedModuleKey: "social",
  },
  {
    matcher: /'mobile_app', \?, \?, \?, 'app_store'/,
    expectedModuleKey: "app_store",
  },
  {
    matcher: /'paste', \?, \?, \?, 'dark_web_mention'/,
    expectedModuleKey: "dark_web",
  },
];

describe("Sparrow takedown creators stamp module_key", () => {
  for (const site of SITES) {
    it(`stamps module_key='${site.expectedModuleKey}' on the matching INSERT`, () => {
      const matchIndex = SPARROW_SRC.search(site.matcher);
      expect(matchIndex, `no INSERT matched ${site.matcher}`).toBeGreaterThan(-1);

      // Look 200 chars before the matched VALUES line for the column list.
      const window = SPARROW_SRC.slice(Math.max(0, matchIndex - 400), matchIndex + 50);
      expect(window).toContain("module_key");

      // The VALUES literal for module_key sits inside the same window.
      expect(window).toContain(`'${site.expectedModuleKey}'`);
    });
  }

  it("calls resolveOwningOrgId before each INSERT", () => {
    // 4 creators × 1 helper call each.
    const calls = SPARROW_SRC.match(/resolveOwningOrgId\(env,/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it("declares the helper itself", () => {
    expect(SPARROW_SRC).toContain("async function resolveOwningOrgId");
    expect(SPARROW_SRC).toContain("FROM org_brands");
    expect(SPARROW_SRC).toContain("ORDER BY is_primary DESC");
  });
});

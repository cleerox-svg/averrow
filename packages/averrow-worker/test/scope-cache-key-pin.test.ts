// Source pin for the cross-org cache-key fix (lib/scope-cache-key.ts).
//
// Org-scoped KV keys used to take their scope segment from
// `scope.brand_ids.slice(0, 3)`, which let two orgs sharing their first three
// brands read each other's cached results. Every org-scoped key now goes
// through `scopeCacheSegment(scope)`. This grep-style pin fails if any source
// file derives a key segment from a slice or join of `brand_ids` again — a
// regression tsc can't catch, since the old expression type-checks fine.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

// `scope.brand_ids.slice(` / `.join(` (any `…scope` / `…Scope` variable) in
// code, not comments, is how a prefix/list of an org's brand IDs ends up in a
// cache key. SQL placeholders are built with `.map(() => "?")`, so neither
// form has a legitimate use on an OrgScope today. Request-body arrays (e.g.
// `body.brand_ids.slice(0, 100)` caps in admin handlers) are not scopes and
// are deliberately not matched.
const FORBIDDEN = /scope\??\.brand_ids\s*\.\s*(slice|join)\s*\(/i;

function codeLines(source: string): Array<{ line: number; text: string }> {
  return source.split("\n").flatMap((text, i) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return [];
    return [{ line: i + 1, text }];
  });
}

describe("org-scoped cache keys use scopeCacheSegment", () => {
  it("no source file derives a key segment from brand_ids.slice/join", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      for (const { line, text } of codeLines(readFileSync(file, "utf8"))) {
        if (FORBIDDEN.test(text)) offenders.push(`${relative(SRC, file)}:${line}: ${text.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pattern catches the old key expression", () => {
    expect(FORBIDDEN.test('const scopeHash = scope ? scope.brand_ids.slice(0, 3).join(",") : "global";')).toBe(true);
    expect(FORBIDDEN.test("const k = orgScope?.brand_ids.join(':');")).toBe(true);
    expect(FORBIDDEN.test("const placeholders = scope.brand_ids.map(() => '?').join(',');")).toBe(false);
    expect(FORBIDDEN.test("const ids = body.brand_ids.slice(0, 100);")).toBe(false);
  });
});

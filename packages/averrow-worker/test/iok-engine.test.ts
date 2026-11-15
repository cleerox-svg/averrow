// IOK phishing-kit rule matching (lib/iok-engine.ts, scripts/iok-compile.ts,
// scripts/vendor-iok-rules.ts, src/data/iok/*):
//   - engine semantics mirror sigma-go v0.6.4 CaseSensitive (each modifier,
//     |all, list fields, missing fields, and/or/not, undefined selections);
//   - the compiler (conditions incl. `1 of x*` / `all of them`, base64, and
//     every drop reason);
//   - hostile input: unsafe regex shapes are refused at compile AND eval
//     time, regex input / evidence fields are capped, the work and clock
//     budgets end an evaluation early, evidence extraction stays linear;
//   - the vendored output (rules.json shape, LICENSE, SOURCE.md attribution).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  IOK_FIELDS,
  IOK_FIELD_FIDELITY,
  IOK_LIST_MAX,
  IOK_NEGATABLE_FIELDS,
  IOK_MAX_MATCHES,
  IOK_REGEX_INPUT_MAX,
  IOK_TEXT_MAX,
  assessRegexSafety,
  buildIokEvidence,
  evaluateIokRules,
  type IokCond,
  type IokEvidence,
  type IokRule,
  type IokRuleSet,
} from "../src/lib/iok-engine";
import { IOK_RULESET } from "../src/lib/iok-ruleset";
import { compileIokRule, isTokenLike, parseCondition } from "../scripts/iok-compile";
import { IOK_REGEX_ALLOWLIST, isAllowedIokRegex } from "../src/lib/iok-regex-allowlist";
import { compileIndicators, renderSourceMd, serializeRuleSet, IOK_ATTRIBUTION } from "../scripts/vendor-iok-rules";

const DATA = resolve(__dirname, "..", "src", "data", "iok");

function ev(over: Partial<IokEvidence> = {}): IokEvidence {
  return { html: "", dom: "", title: [], hostname: "", js: [], css: [], requests: [], ...over };
}

function rule(sel: IokRule["sel"], cond: IokCond, id = "r1"): IokRule {
  return { id, title: id, tags: [], sel, cond };
}

const ref = (n: string): IokCond => ({ t: "ref", n });
/** The one allowlisted regex (rule spox-chase-8b20b051). */
const SPOX_RE = String.raw`(Spox|Crax)\/Files`;

function hits(rules: IokRule[], e: IokEvidence): string[] {
  return evaluateIokRules({ rules }, e).matches.map((m) => m.rule_id);
}

/** Compile a YAML-shaped object (already parsed) → rule or throw. */
function compiled(doc: unknown, id = "x"): IokRule {
  const r = compileIokRule(id, doc);
  if (!r.ok) throw new Error(`dropped: ${r.reason}`);
  return r.rule;
}

describe("IOK engine — field match semantics (sigma-go CaseSensitive)", () => {
  it("contains / startswith / endswith are case-sensitive and literal (no wildcards)", () => {
    const e = ev({ html: "<form action=\"/Post.php\">a*b</form>" });
    const r = (op: "contains" | "startswith" | "endswith", v: string) => rule({ s: [[{ f: "html", op, v: [v] }]] }, ref("s"));
    expect(hits([r("contains", "Post.php")], e)).toEqual(["r1"]);
    expect(hits([r("contains", "post.php")], e)).toEqual([]);
    expect(hits([r("contains", "a*b")], e)).toEqual(["r1"]);
    expect(hits([r("contains", "a?b")], e)).toEqual([]); // `*`/`?` are not globs
    expect(hits([r("startswith", "<form")], e)).toEqual(["r1"]);
    expect(hits([r("startswith", "<FORM")], e)).toEqual([]);
    expect(hits([r("endswith", "</form>")], e)).toEqual(["r1"]);
    expect(hits([r("endswith", "</FORM>")], e)).toEqual([]);
  });

  it("the bare comparison is full equality, case-INsensitive", () => {
    const r = rule({ s: [[{ f: "title", op: "eq", v: ["Just a moment..."] }]] }, ref("s"));
    expect(hits([r], ev({ title: ["just a MOMENT..."] }))).toEqual(["r1"]);
    expect(hits([r], ev({ title: ["Just a moment... please"] }))).toEqual([]);
    const h = rule({ s: [[{ f: "hostname", op: "eq", v: ["pagopa.it"] }]] }, ref("s"));
    expect(hits([h], ev({ hostname: "PAGOPA.IT" }))).toEqual(["r1"]);
  });

  it("re is an unanchored, case-sensitive search (allowlisted patterns only)", () => {
    const r = rule({ s: [[{ f: "html", op: "re", v: [SPOX_RE] }]] }, ref("s"));
    expect(hits([r], ev({ html: "x src=\"Crax/Files/a.js\"" }))).toEqual(["r1"]);
    expect(hits([r], ev({ html: "crax/files" }))).toEqual([]);
    // The same source under a flag that was not reviewed is a different entry.
    const ri = rule({ s: [[{ f: "html", op: "re", v: [SPOX_RE], fl: "i" }]] }, ref("s"));
    expect(evaluateIokRules({ rules: [ri] }, ev({ html: "crax/files" }))).toMatchObject({ matches: [], regex_rejected: 1 });
  });

  it("several values: ANY matches; |all: EVERY value must match (each may hit a different list item)", () => {
    const any = rule({ s: [[{ f: "html", op: "contains", v: ["nope", "kit-a"] }]] }, ref("s"));
    const all = rule({ s: [[{ f: "html", op: "contains", all: true, v: ["kit-a", "kit-b"] }]] }, ref("s"));
    expect(hits([any], ev({ html: "kit-a" }))).toEqual(["r1"]);
    expect(hits([all], ev({ html: "kit-a" }))).toEqual([]);
    expect(hits([all], ev({ html: "kit-a kit-b" }))).toEqual(["r1"]);
    const allList = rule({ s: [[{ f: "js", op: "contains", all: true, v: ["one", "two"] }]] }, ref("s"));
    expect(hits([allList], ev({ js: ["var one;", "var two;"] }))).toEqual(["r1"]);
  });

  it("list fields match when any item matches; missing / empty fields match nothing (also under |all)", () => {
    const r = rule({ s: [[{ f: "requests", op: "endswith", v: ["/urlConfig.json"] }]] }, ref("s"));
    expect(hits([r], ev({ requests: ["https://a/x.js", "https://a/ResourceConfig/urlConfig.json"] }))).toEqual(["r1"]);
    expect(hits([r], ev())).toEqual([]);
    const all = rule({ s: [[{ f: "css", op: "contains", all: true, v: ["a"] }]] }, ref("s"));
    expect(hits([all], ev())).toEqual([]);
    const emptyHtml = rule({ s: [[{ f: "html", op: "eq", v: [""] }]] }, ref("s"));
    expect(hits([emptyHtml], ev())).toEqual([]);
  });

  it("a group is an AND of field matches; a selection is an OR of groups", () => {
    const r = rule({
      s: [
        [{ f: "title", op: "eq", v: ["login"] }, { f: "html", op: "contains", v: ["kit"] }],
        [{ f: "hostname", op: "endswith", v: [".evil.test"] }],
      ],
    }, ref("s"));
    expect(hits([r], ev({ title: ["Login"], html: "kit" }))).toEqual(["r1"]);
    expect(hits([r], ev({ title: ["Login"], html: "nothing" }))).toEqual([]);
    expect(hits([r], ev({ hostname: "a.evil.test" }))).toEqual(["r1"]);
  });
});

describe("IOK engine — conditions", () => {
  const sel = {
    a: [[{ f: "html" as const, op: "contains" as const, v: ["A"] }]],
    b: [[{ f: "html" as const, op: "contains" as const, v: ["B"] }]],
    host: [[{ f: "hostname" as const, op: "eq" as const, v: ["real.test"] }]],
  };
  const run = (cond: string, e: IokEvidence) => hits([rule(sel, parseCondition(cond, Object.keys(sel)))], e);

  it("and / or / not with precedence not > and > or, and parentheses", () => {
    expect(run("a and b", ev({ html: "A B" }))).toEqual(["r1"]);
    expect(run("a and b", ev({ html: "A" }))).toEqual([]);
    expect(run("a or b", ev({ html: "B" }))).toEqual(["r1"]);
    expect(run("a and not host", ev({ html: "A", hostname: "real.test" }))).toEqual([]);
    expect(run("a and not host", ev({ html: "A", hostname: "fake.test" }))).toEqual(["r1"]);
    // `a or b and host` = a or (b and host)
    expect(run("a or b and host", ev({ html: "A" }))).toEqual(["r1"]);
    expect(run("(a or b) and host", ev({ html: "A" }))).toEqual([]);
  });

  it("`1 of x*` / `all of them` expand over the rule's selection names (Go path.Match)", () => {
    expect(parseCondition("1 of php*", ["phpA", "phpB", "other"])).toEqual({ t: "or", c: [ref("phpA"), ref("phpB")] });
    expect(parseCondition("all of them", ["x", "y"])).toEqual({ t: "and", c: [ref("x"), ref("y")] });
    expect(parseCondition("1 of them", ["only"])).toEqual(ref("only"));
    expect(run("all of them", ev({ html: "A B", hostname: "real.test" }))).toEqual(["r1"]);
    expect(run("all of them", ev({ html: "A B" }))).toEqual([]);
    expect(run("1 of them", ev({ hostname: "real.test" }))).toEqual(["r1"]);
    // `1 of` over no names is false; `all of` over no names is true (sigma-go).
    expect(hits([rule(sel, parseCondition("a and 1 of zz*", Object.keys(sel)))], ev({ html: "A" }))).toEqual([]);
    expect(hits([rule(sel, parseCondition("a and all of zz*", Object.keys(sel)))], ev({ html: "A" }))).toEqual(["r1"]);
  });

  it("an undefined selection evaluates false (and the compiler drops such a rule)", () => {
    expect(hits([rule(sel, ref("missing"))], ev({ html: "A" }))).toEqual([]);
    const r = compileIokRule("x", { title: "t", detection: { a: { "html|contains": "A" }, condition: "a and ghost" } });
    expect(r).toEqual({ ok: false, reason: "undefined selection: ghost" });
  });
});

describe("IOK compiler — vendor-time conversion and drops", () => {
  it("compiles the IOK YAML shape (lists of maps, |all, base64, list conditions, tags, level)", () => {
    const r = compiled({
      title: "Kit X ",
      level: "potentially_malicious",
      tags: ["kit", "target.x", 7],
      detection: {
        formAction: [{ "html|contains|all": ["a", "b"] }, { "dom|endswith": "</html>" }],
        token: { "js|base64|contains": "hi" },
        condition: ["formAction", "token"],
      },
    });
    expect(r).toEqual({
      id: "x", title: "Kit X", level: "potentially_malicious", tags: ["kit", "target.x"],
      sel: {
        formAction: [[{ f: "html", op: "contains", all: true, v: ["a", "b"] }], [{ f: "dom", op: "endswith", v: ["</html>"] }]],
        token: [[{ f: "js", op: "contains", v: ["aGk="] }]],
      },
      cond: { t: "or", c: [ref("formAction"), ref("token")] },
    });
  });

  it.each([
    [{ title: "t", detection: { c: { "cookies|startswith": "cazanova=" }, d: { "dom|contains": "x" }, condition: "d and not c" } }, "negated non-exact field: cookies"],
    [{ title: "t", detection: { h: { "ip|contains": "1" }, condition: "h" } }, "unknown field: ip"],
    [{ title: "t", detection: { k: ["just", "keywords"], condition: "k" } }, "keyword selection unsupported"],
    [{ title: "t", detection: { k: { "html|cidr": "10.0.0.0/8" }, condition: "k" } }, "unsupported modifier: cidr"],
    [{ title: "t", detection: { k: { "html|contains": "x" }, condition: "k | count() > 3" } }, "aggregation condition unsupported"],
    [{ title: "t", detection: { a: { "dom|contains": "x" }, b: { "title": "Real" }, condition: "a and not b" } }, "negated non-exact field: title"],
    [{ title: "t", detection: { a: { "dom|contains": "x" }, b: { "js|contains": "y" }, condition: "a and not b" } }, "negated non-exact field: js"],
    [{ title: "t", detection: { a: { "html|re": "token=[a-f0-9]{32}" }, condition: "a" } }, "regex not on allowlist"],
    [{ title: "t", detection: { a: { "html|re": "(?i)(Spox|Crax)\\/Files" }, condition: "a" } }, "regex not on allowlist"],
    [{ title: "x".repeat(301), detection: { a: { "html|contains": "x" }, condition: "a" } }, "title too long"],
    [{ title: "t", detection: { a: { "html|contains": "x".repeat(4097) }, condition: "a" } }, "match value too long"],
    [{ title: "t", detection: { a: { "html|re": "data-content=\"([0-9]{2,3}).+\"" }, condition: "a" } }, "regex not on allowlist"],
    [{ detection: { a: { "html|contains": "x" }, condition: "a" } }, "missing title"],
  ])("drops %j → %s", (doc, reason) => {
    expect(compileIokRule("x", doc)).toEqual({ ok: false, reason });
  });

  it("bounds third-party ids and tags without editing kept content", () => {
    const doc = { title: "t", detection: { a: { "html|contains": "x" }, condition: "a" } };
    expect(compileIokRule("banco-de-crédito-del-perú-xejfkd", doc).ok).toBe(true);
    expect(compileIokRule("m&t-bank-6b1866b8", doc).ok).toBe(true);
    for (const bad of ["a b", "a/b", "a\"b", "<x>", "", "x".repeat(121)]) {
      expect(compileIokRule(bad, doc)).toEqual({ ok: false, reason: "bad rule id" });
    }
    const tags = [...Array.from({ length: 30 }, (_, i) => `t${i}`)];
    tags[1] = "y".repeat(101);
    const r = compiled({ ...doc, tags });
    expect(r.tags).toHaveLength(20);
    expect(r.tags).not.toContain(tags[1]);
    // A 300-char title is kept whole, never trimmed.
    expect(compiled({ ...doc, title: "T".repeat(300) }).title).toBe("T".repeat(300));
  });

  it("drops a rule whose value carries a credential-shaped token; keeps ordinary indicators", () => {
    const uuid = ["0a1b2c3d", "4e5f", "4a6b", "8c7d", "9e0f1a2b3c4d"].join("-");
    const mk = (v: string) => ({ title: "t", detection: { a: { "requests|contains": v }, condition: "a" } });
    expect(compileIokRule("x", mk(`bootstrap.min.css?alt=media&token=${uuid}`))).toEqual({ ok: false, reason: "token-like value" });
    expect(compileIokRule("x", mk(`?sentry_key=${"d7".repeat(16)}&sentry_version=7`))).toEqual({ ok: false, reason: "token-like value" });
    expect(compileIokRule("x", mk("/wp-login.php")).ok).toBe(true);
    for (const bad of [
      `https://h/x?key=${"A1b2".repeat(5)}`, `a&signature=${"0f".repeat(10)}`, `sig=${"9a".repeat(8)}`,
      `x?api_key=${"k9".repeat(12)}`, `password=${"p4ss".repeat(4)}`, `secret=${"s3".repeat(9)}`,
      `id AKIA${"A1".repeat(8)} x`, `AIza${"b2".repeat(17)}c`, `sk_live_${"c3".repeat(8)}`, `ghp_${"d4".repeat(18)}`, `xoxb-${"1234567890"}-abc`,
    ]) expect(isTokenLike(bad), bad).toBe(true);
    for (const ok of [
      "/wp-login.php", "choose.php", "?token=abc", "token=short1", "?key=value", "monkey=0123456789abcdef0123",
      "63c2690a6e94180ff183110c4cd9ff7719014722", "name=\"X-CSRF-Token\" value=\"63c2690a6e94180ff183110c4cd9ff77\"",
      "?token=abcdefghijklmnopqrstuvwx", "/ResourceConfig/urlConfig.json", "https://cdn.test/a.js?v=1234567890abcdef1234",
    ]) expect(isTokenLike(ok), ok).toBe(false);
  });

  it("keeps a negated EXACT field (hostname / dom): `kit and not realDomain`", () => {
    const r = compiled({ title: "t", detection: { kit: { "dom|contains": "rbx" }, real: { "hostname|endswith": ".roblox.com" }, condition: "kit and not real" } });
    expect(hits([r], ev({ dom: "rbx", hostname: "roblox-login.test" }))).toEqual(["x"]);
    expect(hits([r], ev({ dom: "rbx", hostname: "www.roblox.com" }))).toEqual([]);
  });

  it("compileIndicators parses YAML, sorts, counts drop reasons; serializeRuleSet round-trips", () => {
    const res = compileIndicators([
      { file: "b.yml", text: "title: B\ndetection:\n  s:\n    html|contains: 'kit-b'\n  condition: s\ntags:\n  - kit\n" },
      { file: "a.yml", text: "title: A\ndetection:\n  c:\n    ip|contains: x\n  condition: c\n" },
      { file: "c.yml", text: "title: [unclosed\n" },
    ], { repository: "r", commit: "c".repeat(40), commit_date: "2025-01-01", vendored_at: "2026-11-15", licence: "ODbL-1.0", attribution: IOK_ATTRIBUTION });
    expect(res.ruleset.stats).toEqual({ total: 3, kept: 1, dropped: 2, dropped_by_reason: { "unknown field": 1, "yaml parse error": 1 } });
    expect(res.ruleset.rules.map((r) => r.id)).toEqual(["b"]);
    const text = serializeRuleSet(res.ruleset);
    expect(JSON.parse(text)).toEqual(res.ruleset);
    expect(text.split("\n").length).toBe(4); // head, one rule per line, close, trailing newline
    const md = renderSourceMd(res, Buffer.byteLength(text));
    expect(md).toContain(IOK_ATTRIBUTION);
    expect(md).toContain("can miss AND over-match");
    expect(md).toContain("iok-regex-allowlist.ts");
    expect(md).not.toMatch(/never invent|no rule content\s+added or edited/);
  });

  it("vendor order is plain code-point order, not locale order", () => {
    const mk = (file: string) => ({ file, text: "title: T\ndetection:\n  s:\n    html|contains: 'k'\n  condition: s\n" });
    const res = compileIndicators([mk("b.yml"), mk("B.yml"), mk("a.yml"), mk("é.yml"), mk("Z.yml")],
      { repository: "r", commit: "c".repeat(40), commit_date: "d", vendored_at: "v", licence: "ODbL-1.0", attribution: IOK_ATTRIBUTION });
    expect(res.ruleset.rules.map((r) => r.id)).toEqual(["B", "Z", "a", "b", "é"]);
  });
});

describe("IOK safety — hostile regexes, caps and budgets", () => {
  it.each([
    ["(a+)+$", false],
    ["(a|aa)*b", false],
    ["(x*)*y", false],
    ["a+b", false],
    ["data-content=\"([0-9]{2,3}).+\"", false],
    ["(\\w+\\s?)+$", false],
    ["(a)\\1", false],
    ["(?=a)b", false],
    ["(?<!a)b", false],
    ["(?i)abc", false], // inline flags are translated by the compiler, never passed through
    ["\\p{L}", false],
    ["[[:alpha:]]", false],
    ["(?:a{100}){100}", false],
    ["a{2000}", false],
    ["x".repeat(300), false],
    ["a{", false],
    ["((a)", false],
    // Refused: 184 ms on adversarial 256K input (see iok-regex-allowlist.ts).
    ["class=\"(?:(?: |  )?(?:[A-Za-z0-9]{20})(?: |  )?){8}", false],
    // Review round: shapes the first screen let through.
    ["(\\w{1,30}){1,30}#", false],
    ["\\w{0,1000}\\w{0,1000}#", false],
    ["(a|ab){1,30}c", false],
    ["(?:\\w|\\d){24}!", false],
    ["(a|aa){20}c", false],
    ["(?:ab){3}c", true],
    ["[0-9]{2,3}-[a-z]{1,4}x", true],
    ["(Spox|Crax)\\/Files", true],
    ["^https?://[a-z0-9.-]+$", false], // unbounded inside: `+` not the final token
    ["token=[a-f0-9]{32}", true],
    ["kit-v\\d+", true], // unbounded quantifier as the final token is fine
    ["(?<grp>ab)c", true],
  ])("assessRegexSafety(%s) ok=%s", (src, ok) => {
    expect(assessRegexSafety(src).ok).toBe(ok);
  });

  it("a regex that is not on the allowlist never runs, even hand-edited into rules.json", () => {
    // Catastrophic, and one that passes the screen but nobody reviewed.
    for (const src of ["(a+)+$", "(\\w{1,30}){1,30}#", "aaa", "token=[a-f0-9]{32}"]) {
      const smuggled = rule({ s: [[{ f: "html", op: "re", v: [src] }]] }, ref("s"));
      const t0 = Date.now();
      const out = evaluateIokRules({ rules: [smuggled] }, ev({ html: `${"a".repeat(50_000)}token=${"a".repeat(32)}!` }));
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(out, src).toMatchObject({ matches: [], regex_rejected: 1, evaluated: 1 });
    }
  });

  it("the allowlist holds exact reviewed sources, each tied to a rule and commit, and each passes the screen", () => {
    expect(IOK_REGEX_ALLOWLIST.map((e) => e.source)).toEqual([SPOX_RE]);
    for (const e of IOK_REGEX_ALLOWLIST) {
      expect(e.reviewed_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(e.rule_id.length).toBeGreaterThan(0);
      expect(e.worst_ms).toBeLessThan(5);
      expect(assessRegexSafety(e.source)).toEqual({ ok: true });
      expect(isAllowedIokRegex(e.source, e.flags)).toBe(true);
    }
    expect(isAllowedIokRegex(`${SPOX_RE} `)).toBe(false);
    // Every regex in the vendored ruleset is on the list, under the listed rule.
    for (const r of IOK_RULESET.rules) {
      for (const groups of Object.values(r.sel)) for (const g of groups) for (const m of g) {
        if (m.op !== "re") continue;
        for (const v of m.v) {
          expect(IOK_REGEX_ALLOWLIST.some((e) => e.source === v && e.flags === (m.fl ?? "") && e.rule_id === r.id), `${r.id}: ${v}`).toBe(true);
        }
      }
    }
  });

  it("each allowlisted regex stays fast on adversarial input at the cap", () => {
    const unit = "Spox/FileSpox/FileCrax/File";
    const input = unit.repeat(Math.ceil(IOK_REGEX_INPUT_MAX / unit.length)).slice(0, IOK_REGEX_INPUT_MAX);
    const r = rule({ s: [[{ f: "html", op: "re", v: [SPOX_RE] }]] }, ref("s"));
    const t0 = performance.now();
    expect(hits([r], ev({ html: input }))).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it("regex input is capped at IOK_REGEX_INPUT_MAX chars, and the clip is reported", () => {
    const r = rule({ s: [[{ f: "html", op: "re", v: [SPOX_RE] }]] }, ref("s"));
    const filler = "x".repeat(IOK_REGEX_INPUT_MAX);
    const inside = evaluateIokRules({ rules: [r] }, ev({ html: `${filler.slice(20)}Spox/Files` }));
    expect(inside).toMatchObject({ status: "complete", input_clipped: false });
    expect(inside.matches).toHaveLength(1);
    const beyond = evaluateIokRules({ rules: [r] }, ev({ html: `${filler}Spox/Files` }));
    expect(beyond).toMatchObject({ matches: [], status: "truncated", input_clipped: true });
  });

  it("clipped evidence is reported as truncated, never as a clean result", () => {
    const html = `${"x".repeat(IOK_TEXT_MAX)}KITMARK`;
    const e = buildIokEvidence({ html, title: null, finalUrl: "https://h.test/", targetUrl: null, redirectChain: [] });
    expect(e.clipped).toBe(true);
    const r = rule({ s: [[{ f: "dom", op: "contains", v: ["KITMARK"] }]] }, ref("s"));
    expect(evaluateIokRules({ rules: [r] }, e)).toMatchObject({ matches: [], status: "truncated" });
    const small = buildIokEvidence({ html: "<html>KITMARK</html>", title: null, finalUrl: "https://h.test/", targetUrl: null, redirectChain: [] });
    expect(evaluateIokRules({ rules: [r] }, small)).toMatchObject({ status: "complete" });
  });

  it("the deterministic work budget ends an evaluation early and reports it", () => {
    const rules = Array.from({ length: 20 }, (_, i) => rule({ s: [[{ f: "html", op: "contains", v: [`nope${i}`] }]] }, ref("s"), `r${i}`));
    const out = evaluateIokRules({ rules }, ev({ html: "x".repeat(10_000) }), { workBudget: 55_000 });
    expect(out.budget_exhausted).toBe(true);
    expect(out.status).toBe("partial");
    expect(out.evaluated).toBe(5);
    expect(out.skipped).toBe(15);
  });

  it("the clock budget is honoured where time advances", () => {
    let t = 0;
    const rules = Array.from({ length: 10 }, (_, i) => rule({ s: [[{ f: "html", op: "contains", v: ["k"] }]] }, ref("s"), `r${i}`));
    const out = evaluateIokRules({ rules }, ev({ html: "k" }), { timeBudgetMs: 3, now: () => (t += 1) });
    expect(out.budget_exhausted).toBe(true);
    expect(out.evaluated).toBeLessThan(10);
  });

  it("caps matches per capture at IOK_MAX_MATCHES", () => {
    const rules = Array.from({ length: IOK_MAX_MATCHES + 5 }, (_, i) => rule({ s: [[{ f: "html", op: "contains", v: ["k"] }]] }, ref("s"), `r${i}`));
    const out = evaluateIokRules({ rules }, ev({ html: "k" }));
    expect(out.matches).toHaveLength(IOK_MAX_MATCHES);
    expect(out.truncated).toBe(true);
  });
});

describe("IOK evidence — built only from what a capture stores", () => {
  const html =
    "<html><head><title>Sign in</title>" +
    "<link rel=\"stylesheet\" href=\"/assets/kit.css?v=1&amp;x=2\">" +
    "<script src=\"https://cdn.evil.test/a.js\"></script>" +
    "<script>var kitId = 'zz9';</script>" +
    "<script type=\"application/ld+json\">{\"@type\":\"Org\"}</script>" +
    "<script type=\"module\">import x from './m.js';</script>" +
    "<style>.login{color:red}</style></head>" +
    "<body><img src=\"img/logo.png\"><a href=\"https://not-a-request.test/\">x</a>" +
    "<iframe src=\"javascript:alert(1)\"></iframe></body></html>";

  it("maps html/dom to the rendered DOM, title, hostname, inline js/css and referenced requests", () => {
    const e = buildIokEvidence({
      html, title: "Sign in", finalUrl: "https://Kit.Evil.test/login/index.php",
      targetUrl: "https://short.test/x", redirectChain: ["https://short.test/x", "https://kit.evil.test/login/index.php"],
    });
    expect(e.html).toBe(html);
    expect(e.dom).toBe(html);
    expect(e.title).toEqual(["Sign in"]);
    expect(e.hostname).toBe("kit.evil.test");
    expect(e.js).toEqual(["var kitId = 'zz9';", "import x from './m.js';"]);
    expect(e.css).toEqual([".login{color:red}"]);
    expect(e.requests).toEqual([
      "https://short.test/x",
      "https://kit.evil.test/login/index.php",
      "https://kit.evil.test/assets/kit.css?v=1&x=2",
      "https://cdn.evil.test/a.js",
      "https://kit.evil.test/login/img/logo.png",
    ]);
    expect(e.clipped).toBe(false);
  });

  it("requests come only from real start tags and fetched <link> rels (no script text, comments, canonical)", () => {
    const tricky =
      "<html><head>" +
      "<link rel=\"canonical\" href=\"https://x/recap.php\">" +
      "<link rel=\"alternate\" href=\"https://x/informations.php\">" +
      "<link rel=\"dns-prefetch\" href=\"https://x/loader.php\">" +
      "<link rel=\"preconnect\" href=\"https://x/choose.php\">" +
      "<link rel=\"shortcut icon\" href=\"/favicon.ico\">" +
      "<link rel=\"preload\" href=\"/font.woff2\">" +
      "<script>var a='<img src=\"https://y/fin.php\">'</script>" +
      "<style>/* <img src=\"https://y/keyb.png\"> */</style>" +
      "<!-- <script src=\"https://y/choose.php\"></script> -->" +
      "</head><body>" +
      "<noscript><img src=\"https://y/loader.php\"></noscript>" +
      "<p>text &lt;img src=\"https://y/recap.php\"&gt;</p>" +
      "<div title=\"<img src='https://y/fin.php'>\" data-x=' src=\"https://y/choose.php\"'>x</div>" +
      "<img alt=\"a>b\" src=\"/real.png\">" +
      "</body></html>";
    const e = buildIokEvidence({ html: tricky, title: null, finalUrl: "https://kit.test/", targetUrl: null, redirectChain: [] });
    expect(e.requests).toEqual([
      "https://kit.test/",
      "https://kit.test/favicon.ico",
      "https://kit.test/font.woff2",
      "https://kit.test/real.png",
    ]);
    expect(e.js).toEqual(["var a='<img src=\"https://y/fin.php\">'"]);
    expect(e.css).toEqual(["/* <img src=\"https://y/keyb.png\"> */"]);
    // The vendored pagopa rule (requests|contains choose.php / fin.php / … and
    // not the real hostname) must not fire on references that are not requests.
    const pagopa = IOK_RULESET.rules.find((r) => r.id === "pagopa-197bb96bc")!;
    expect(pagopa).toBeDefined();
    expect(evaluateIokRules({ rules: [pagopa] }, e).matches).toEqual([]);
    // …and does fire when the page really references the kit's file.
    const real = buildIokEvidence({ html: "<html><body><script src=\"fin.php\"></script></body></html>", title: null, finalUrl: "https://kit.test/", targetUrl: null, redirectChain: [] });
    expect(evaluateIokRules({ rules: [pagopa] }, real).matches.map((m) => [m.rule_id, m.approximate_fields])).toEqual([["pagopa-197bb96bc", ["requests"]]]);
  });

  it("falls back to the target host, and handles empty / missing values", () => {
    const e = buildIokEvidence({ html: "", title: null, finalUrl: null, targetUrl: "https://t.test/", redirectChain: [] });
    expect(e).toEqual({ html: "", dom: "", title: [], hostname: "t.test", js: [], css: [], requests: [], headers: [], cookies: [], fidelity: {}, clipped: false });
  });

  it("caps text / list sizes and stays linear on hostile markup", () => {
    const big = `<script>${"a".repeat(10)}`.repeat(200_000); // unclosed scripts, 3 MB
    const t0 = Date.now();
    const e = buildIokEvidence({ html: big, title: "x".repeat(10_000), finalUrl: "https://h.test/", targetUrl: null, redirectChain: [] });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(e.html.length).toBe(IOK_TEXT_MAX);
    expect(e.js).toEqual([]);
    const many = "<style>x</style>".repeat(IOK_LIST_MAX + 50) + " src=\"/a\"".repeat(10) + Array.from({ length: IOK_LIST_MAX + 50 }, (_, i) => ` src="/r${i}"`).join("");
    const e2 = buildIokEvidence({ html: many, title: null, finalUrl: "https://h.test/", targetUrl: null, redirectChain: [] });
    expect(e2.css).toHaveLength(IOK_LIST_MAX);
    expect(e2.clipped).toBe(true);
    // A tag that never closes, or runs past the tag-length bound, ends the scan.
    const openTag = `<img src="/a.png"><div ${"x ".repeat(40_000)}`;
    const e3 = buildIokEvidence({ html: openTag, title: null, finalUrl: "https://h.test/", targetUrl: null, redirectChain: [] });
    expect(e3.requests).toEqual(["https://h.test/", "https://h.test/a.png"]);
    expect(e2.requests.length).toBeLessThanOrEqual(IOK_LIST_MAX);
    expect(e2.title).toEqual([]);
  });
});

describe("vendored IOK ruleset (src/data/iok)", () => {
  const rs: IokRuleSet = IOK_RULESET;

  it("carries its source, licence and attribution", () => {
    expect(rs.format).toBe(1);
    expect(rs.source).toMatchObject({
      repository: "https://github.com/phish-report/IOK",
      licence: "ODbL-1.0",
      attribution: "Rules: IOK by phish.report (ODbL)",
    });
    expect(rs.source.commit).toMatch(/^[0-9a-f]{40}$/);
    const licence = readFileSync(resolve(DATA, "LICENSE"), "utf8");
    expect(licence).toContain("ODC Open Database License (ODbL)");
    const source = readFileSync(resolve(DATA, "SOURCE.md"), "utf8");
    expect(source).toContain("Rules: IOK by phish.report (ODbL)");
    expect(source).toContain(rs.source.commit);
  });

  it("carries no credential-shaped string (no third-party tokens in the repository)", () => {
    const text = readFileSync(resolve(DATA, "rules.json"), "utf8");
    expect(text).not.toMatch(/alt=media&token=/);
    expect(text).not.toMatch(/[?&;"'](?:[a-z0-9]+_)?(?:token|apikey|key|secret|password|signature|sig)=[A-Za-z0-9+/_=-]{16,}/i);
    expect(text).not.toMatch(/AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9A-Za-z]{16,}|ghp_[0-9A-Za-z]{36}|xox[bp]-[0-9A-Za-z-]{10,}/);
    expect(rs.stats.dropped_by_reason["token-like value"]).toBe(2);
    expect(rs.rules.some((r) => r.id === "generic-email-ec34bc68" || r.id === "transferwise-d777126")).toBe(false);
  });

  it("counts are consistent and ids unique", () => {
    expect(rs.stats.kept).toBe(rs.rules.length);
    expect(rs.stats.kept + rs.stats.dropped).toBe(rs.stats.total);
    expect(Object.values(rs.stats.dropped_by_reason).reduce((a, b) => a + b, 0)).toBe(rs.stats.dropped);
    expect(new Set(rs.rules.map((r) => r.id)).size).toBe(rs.rules.length);
    expect(rs.rules.length).toBeGreaterThan(200);
  });

  it("every kept rule is well-formed: stored fields only, safe regexes, defined refs, no negated approximate field", () => {
    const refs = (c: IokCond, neg: boolean, out: Array<[string, boolean]>): void => {
      if (c.t === "ref") out.push([c.n, neg]);
      else if (c.t === "not") refs(c.c, !neg, out);
      else c.c.forEach((x) => refs(x, neg, out));
    };
    for (const r of rs.rules) {
      expect(typeof r.title).toBe("string");
      expect(r.title.length).toBeLessThanOrEqual(300);
      expect(r.id).toMatch(/^[\p{L}\p{N}._&-]{1,120}$/u);
      expect(r.tags.length).toBeLessThanOrEqual(20);
      for (const t of r.tags) expect(t.length).toBeLessThanOrEqual(100);
      for (const groups of Object.values(r.sel)) {
        for (const g of groups) {
          for (const m of g) {
            expect(IOK_FIELDS).toContain(m.f);
            expect(["eq", "contains", "startswith", "endswith", "re"]).toContain(m.op);
            expect(m.v.length).toBeGreaterThan(0);
            if (m.op === "re") for (const v of m.v) expect(assessRegexSafety(v)).toEqual({ ok: true });
            for (const v of m.v) expect(v.length).toBeLessThanOrEqual(4096);
            for (const v of m.v) expect(isTokenLike(v), `${r.id}: token-like value`).toBe(false);
          }
        }
      }
      const out: Array<[string, boolean]> = [];
      refs(r.cond, false, out);
      for (const [n, neg] of out) {
        expect(r.sel[n], `${r.id}: ${n}`).toBeDefined();
        if (neg) for (const g of r.sel[n]!) for (const m of g) expect(IOK_NEGATABLE_FIELDS).toContain(m.f);
      }
    }
  });

  it("matches a known kit on rendered HTML and is quiet on a benign page", () => {
    const kit = buildIokEvidence({
      html: "<html><form><input type=\"hidden\" name=\"X-CSRF-Token\" value=\"63c2690a6e94180ff183110c4cd9ff7719014722\"></form></html>",
      title: "123 Reg", finalUrl: "https://123-reg-login.test/", targetUrl: null, redirectChain: [],
    });
    expect(evaluateIokRules(rs, kit).matches.map((m) => m.rule_id)).toContain("123-reg-63c26");
    const benign = buildIokEvidence({
      html: "<html><head><title>Hello</title></head><body><p>Nothing to see.</p></body></html>",
      title: "Hello", finalUrl: "https://example.test/", targetUrl: null, redirectChain: [],
    });
    const out = evaluateIokRules(rs, benign);
    expect(out).toMatchObject({ matches: [], status: "complete", budget_exhausted: false, regex_rejected: 0 });
    // The two rules that negate headers / html are not applicable without the artifacts.
    expect(out.not_applicable).toBe(2);
    expect(out.evaluated + out.not_applicable).toBe(rs.rules.length);
  });

  it("evaluates a worst-case 1 MB page within the work budget", () => {
    const html = `<html>${"<div class=\"x\">lorem ipsum dolor</div>".repeat(28_000)}</html>`.slice(0, IOK_TEXT_MAX);
    const e = buildIokEvidence({ html, title: "t", finalUrl: "https://h.test/", targetUrl: null, redirectChain: [] });
    const out = evaluateIokRules(rs, e);
    expect(out.budget_exhausted).toBe(false);
    expect(out.evaluated + out.not_applicable).toBe(rs.rules.length);
  });
});

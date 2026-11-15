/**
 * IOK rule compiler (dev-time only — never bundled into the Worker).
 *
 * Turns one parsed IOK indicator (Sigma-style YAML from
 * github.com/phish-report/IOK `indicators/*.yml`) into the compact JSON AST
 * that src/lib/iok-engine.ts evaluates, or a drop reason. Used by
 * scripts/vendor-iok-rules.ts; pure, so test/iok-engine.test.ts drives it.
 *
 * Semantics follow the reference implementation (iok.go on sigma-go v0.6.4
 * with `evaluator.CaseSensitive`) — see the header of lib/iok-engine.ts.
 * Compile-time work:
 *   - `field|mod…|all` keys → { f, op, all, v }; `base64` value modifier is
 *     applied here; any other modifier drops the rule;
 *   - condition strings (`a and not (b or c)`, `1 of x*`, `all of them`) are
 *     parsed (not > and > or) and `… of …` expanded into plain and/or over
 *     the rule's selection names (glob = Go path.Match `*` / `?`);
 *   - RE2 regexes are translated to JS (leading `(?i)` → flag, `(?P<n>` →
 *     `(?<n>`); the result must be on the hand-reviewed allowlist
 *     (lib/iok-regex-allowlist.ts) AND pass assessRegexSafety, else the rule
 *     is dropped;
 *   - rules using an unknown field, keyword selections, aggregations (`|` in
 *     the condition), or a field that can never be exact (title, js, css,
 *     cookies) under `not` are dropped with a counted reason. A rule that
 *     negates html / requests / headers is KEPT: those fields are exact on a
 *     capture that holds the real artifact (lib/page-capture-network.ts) and
 *     the engine evaluates such a rule only there (`not_applicable` else);
 *   - a rule whose match value carries a credential-shaped token
 *     (isTokenLike) is dropped — we do not vendor third-party secrets;
 *   - third-party strings are bounded, never edited: an id outside
 *     letters / digits / `._&-`, a title over MAX_TITLE_LENGTH or a value
 *     over MAX_VALUE_LENGTH drops the rule; tags beyond MAX_TAGS or longer
 *     than MAX_TAG_LENGTH are left out (tags are labels, not rule logic).
 */

import { isAllowedIokRegex } from "../src/lib/iok-regex-allowlist";
import {
  IOK_FIELDS,
  IOK_NEGATABLE_FIELDS,
  assessRegexSafety,
  negatedRefs,
  type IokCond,
  type IokField,
  type IokFieldMatch,
  type IokGroup,
  type IokOp,
  type IokRule,
} from "../src/lib/iok-engine";

export type CompileResult = { ok: true; rule: IokRule } | { ok: false; reason: string };

/** Longest expected value kept (the corpus max is ~1.4K). */
export const MAX_VALUE_LENGTH = 4096;
export const MAX_TITLE_LENGTH = 300;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 100;
/** Rule ids: letters (any script), digits and `._&-` only. */
export const RULE_ID_PATTERN = /^[\p{L}\p{N}._&-]{1,120}$/u;

/**
 * Credential-shaped strings. Some kits embed a live download token or API key
 * in a URL the rule matches on (e.g. a Firebase `?alt=media&token=<uuid>`).
 * We do not carry third-party credentials in the repository, so a rule with
 * such a value is dropped ("token-like value"). Deliberately narrow, so
 * ordinary indicators survive:
 *   - a `token` / `key` / `apikey` / `secret` / `password` / `signature` /
 *     `sig` query parameter, optionally with one `word_` prefix
 *     (`access_token`, `api_key`, `sentry_key`), after `?`, `&`, `;`, a
 *     quote, whitespace or at the start, whose value starts with ≥ 16 hex /
 *     base64 / uuid characters including at least one digit;
 *   - well-known key prefixes: AWS `AKIA…`, Google `AIza…`, Stripe
 *     `sk_live_…`, GitHub `ghp_…`, Slack `xoxb-` / `xoxp-`.
 */
const TOKEN_PARAM = /(?:^|[?&;\s"'])(?:[a-z0-9]+_)?(?:token|apikey|key|secret|password|signature|sig)=([A-Za-z0-9+/_=-]{16,})/gi;
const KEY_PREFIXES: readonly RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk_live_[0-9A-Za-z]{16,}/,
  /\bghp_[0-9A-Za-z]{36}\b/,
  /\bxox[bp]-[0-9A-Za-z-]{10,}/,
];

export function isTokenLike(value: string): boolean {
  TOKEN_PARAM.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_PARAM.exec(value)) !== null) {
    if (/[0-9]/.test(m[1]!)) return true;
  }
  return KEY_PREFIXES.some((re) => re.test(value));
}

const COMPARATORS: Record<string, IokOp> = {
  contains: "contains",
  startswith: "startswith",
  endswith: "endswith",
  re: "re",
};

class Drop extends Error {}
const drop = (reason: string): never => {
  throw new Drop(reason);
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scalarString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return drop("non-scalar match value");
}

/** RE2 → JS regex source + flags. */
export function translateRe2(src: string): { source: string; flags?: "i" } {
  let s = src;
  let flags: "i" | undefined;
  if (s.startsWith("(?i)")) {
    flags = "i";
    s = s.slice(4);
  }
  s = s.replace(/\(\?P</g, "(?<");
  if (/\\[AzQE]/.test(s)) drop("unsupported RE2 escape");
  if (!isAllowedIokRegex(s, flags ?? "")) drop("regex not on allowlist");
  const safety = assessRegexSafety(s);
  if (!safety.ok) drop(`unsafe regex: ${safety.reason}`);
  return flags ? { source: s, flags } : { source: s };
}

function compileFieldMatch(key: string, value: unknown): IokFieldMatch {
  const [field, ...mods] = key.split("|");
  if (!field) drop("empty field name");
  if (!(IOK_FIELDS as readonly string[]).includes(field!)) drop(`unknown field: ${field}`);
  let all = false;
  if (mods.length > 0 && mods[mods.length - 1] === "all") {
    all = true;
    mods.pop();
  }
  let op: IokOp = "eq";
  let base64 = false;
  for (let idx = 0; idx < mods.length; idx++) {
    const m = mods[idx]!;
    if (m === "base64" && idx < mods.length - 1) {
      base64 = true;
      continue;
    }
    const c = COMPARATORS[m];
    if (!c || idx !== mods.length - 1) drop(`unsupported modifier: ${m}`);
    op = c!;
  }
  if (base64 && op === "re") drop("unsupported modifier: base64|re");
  const rawValues = Array.isArray(value) ? value : [value];
  if (rawValues.length === 0) drop("empty value list");
  let flags: "i" | undefined;
  const values = rawValues.map((rv) => {
    if (rv === null || rv === undefined) drop("null match value");
    let s = scalarString(rv);
    if (isTokenLike(s)) drop("token-like value");
    if (base64) s = Buffer.from(s, "utf8").toString("base64");
    if (s.length > MAX_VALUE_LENGTH) drop("match value too long");

    if (op === "re") {
      const t = translateRe2(s);
      if (t.flags) flags = "i";
      else if (flags) drop("mixed regex flags");
      return t.source;
    }
    return s;
  });
  const m: IokFieldMatch = { f: field as IokField, op, v: values };
  if (all) m.all = true;
  if (flags) m.fl = flags;
  return m;
}

function compileSelection(value: unknown): IokGroup[] {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) drop("empty selection");
  return items.map((it) => {
    if (!isRecord(it)) return drop("keyword selection unsupported");
    const entries = Object.entries(it);
    if (entries.length === 0) drop("empty selection map");
    return entries.map(([k, v]) => compileFieldMatch(k, v));
  });
}

// ─── Condition parser ────────────────────────────────────────────────

type Tok = { k: "id"; v: string } | { k: "op"; v: "and" | "or" | "not" | "(" | ")" | "of" | "1" | "all" | "them" };

function tokenize(cond: string): Tok[] {
  if (cond.includes("|")) drop("aggregation condition unsupported");
  const out: Tok[] = [];
  const re = /\s*(\(|\)|[^\s()]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cond)) !== null) {
    const t = m[1]!;
    const low = t.toLowerCase();
    if (low === "and" || low === "or" || low === "not" || low === "of" || low === "1" || low === "all" || low === "them") {
      out.push({ k: "op", v: low });
    } else if (t === "(" || t === ")") {
      out.push({ k: "op", v: t });
    } else if (/^[A-Za-z0-9_*?.-]+$/.test(t)) {
      out.push({ k: "id", v: t });
    } else {
      drop(`bad condition token: ${t}`);
    }
  }
  return out;
}

/** Go path.Match subset used by sigma-go for `1 of x*`. */
function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
  return re.test(name);
}

export function parseCondition(cond: string, selections: string[]): IokCond {
  const toks = tokenize(cond);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const isOp = (t: Tok | undefined, v: string): boolean => !!t && t.k === "op" && t.v === v;

  const quantified = (kind: "1" | "all"): IokCond => {
    p++; // 1 | all
    if (!isOp(peek(), "of")) drop("expected 'of'");
    p++;
    const t = peek();
    let names: string[];
    if (isOp(t, "them")) names = selections;
    else if (t && t.k === "id") names = selections.filter((s) => globMatch(t.v, s));
    else return drop("expected 'them' or a pattern after 'of'");
    p++;
    const refs: IokCond[] = names.map((n) => ({ t: "ref", n }));
    // sigma-go: `1 of` over nothing is false, `all of` over nothing is true.
    if (refs.length === 1) return refs[0]!;
    return kind === "1" ? { t: "or", c: refs } : { t: "and", c: refs };
  };

  const primary = (): IokCond => {
    const t = peek();
    if (!t) return drop("unexpected end of condition");
    if (isOp(t, "(")) {
      p++;
      const e = orExpr();
      if (!isOp(peek(), ")")) drop("expected ')'");
      p++;
      return e;
    }
    if (isOp(t, "1")) return quantified("1");
    if (isOp(t, "all")) return quantified("all");
    if (t.k === "id") {
      if (t.v.includes("*") || t.v.includes("?")) drop("bare wildcard identifier");
      p++;
      return { t: "ref", n: t.v };
    }
    return drop(`unexpected token ${t.v}`);
  };
  const notExpr = (): IokCond => {
    if (isOp(peek(), "not")) {
      p++;
      return { t: "not", c: notExpr() };
    }
    return primary();
  };
  const andExpr = (): IokCond => {
    const c = [notExpr()];
    while (isOp(peek(), "and")) {
      p++;
      c.push(notExpr());
    }
    return c.length === 1 ? c[0]! : { t: "and", c };
  };
  function orExpr(): IokCond {
    const c = [andExpr()];
    while (isOp(peek(), "or")) {
      p++;
      c.push(andExpr());
    }
    return c.length === 1 ? c[0]! : { t: "or", c };
  }
  const e = orExpr();
  if (p !== toks.length) drop("trailing tokens in condition");
  return e;
}

function referencedNames(c: IokCond, out: Set<string> = new Set()): Set<string> {
  if (c.t === "ref") out.add(c.n);
  else if (c.t === "not") referencedNames(c.c, out);
  else for (const x of c.c) referencedNames(x, out);
  return out;
}

/** Compile one parsed indicator document. `id` = file stem (as iok.go). */
export function compileIokRule(id: string, doc: unknown): CompileResult {
  try {
    if (!RULE_ID_PATTERN.test(id)) drop("bad rule id");
    if (!isRecord(doc)) drop("not a mapping");
    const d = doc as Record<string, unknown>;
    const title = typeof d["title"] === "string" ? d["title"].trim() : "";
    if (!title) drop("missing title");
    if (title.length > MAX_TITLE_LENGTH) drop("title too long");
    const det = d["detection"];
    if (!isRecord(det)) return drop("missing detection");
    const condRaw = det["condition"];
    const condStr = Array.isArray(condRaw)
      ? condRaw.map((c) => `(${scalarString(c)})`).join(" or ")
      : typeof condRaw === "string" ? condRaw : drop("missing condition");
    const sel: Record<string, IokGroup[]> = {};
    for (const [name, v] of Object.entries(det)) {
      if (name === "condition") continue;
      if (name === "timeframe") drop("timeframe unsupported");
      sel[name] = compileSelection(v);
    }
    const names = Object.keys(sel);
    if (names.length === 0) drop("no selections");
    const cond = parseCondition(condStr, names);
    for (const n of referencedNames(cond)) {
      if (!sel[n]) drop(`undefined selection: ${n}`);
    }
    for (const n of negatedRefs(cond)) {
      for (const g of sel[n] ?? []) {
        for (const m of g) {
          if (!IOK_NEGATABLE_FIELDS.includes(m.f)) drop(`negated non-exact field: ${m.f}`);
        }
      }
    }
    const tags = Array.isArray(d["tags"])
      ? d["tags"].filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= MAX_TAG_LENGTH).slice(0, MAX_TAGS)
      : [];
    const rule: IokRule = { id, title, tags, sel, cond };
    if (typeof d["level"] === "string" && d["level"]) rule.level = d["level"];
    return { ok: true, rule };
  } catch (err) {
    if (err instanceof Drop) return { ok: false, reason: err.message };
    throw err;
  }
}

/** Bucket a drop reason for the SOURCE.md / stats table. */
export function reasonBucket(reason: string): string {
  if (reason.startsWith("field not stored: ")) return reason;
  if (reason.startsWith("unsafe regex")) return "unsafe regex";
  if (reason.startsWith("negated non-exact field: ")) return reason;
  if (reason.startsWith("unsupported modifier")) return "unsupported modifier";
  if (reason.startsWith("undefined selection")) return "undefined selection";
  if (reason.startsWith("unknown field")) return "unknown field";
  return reason;
}

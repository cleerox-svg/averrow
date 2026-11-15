// Averrow — IOK (Indicator of Kit) rule evaluator.
//
// Matches phishing-kit rules from the open IOK ruleset (phish.report,
// https://github.com/phish-report/IOK, ODbL — see src/data/iok/SOURCE.md)
// against evidence the page_capture agent ALREADY stores. No fetching: the
// evidence is derived from the rendered HTML (`page.html` in R2), the page
// title, the final URL and the redirect chain of one capture
// (lib/page-capture.ts).
//
// The rules are vendored and compiled by scripts/vendor-iok-rules.ts into a
// small JSON AST (src/data/iok/rules.json). This file is the pure evaluator:
// no D1, no KV, no network, no `eval` / `Function`.
//
// Semantics mirror the reference implementation (phish-report/IOK iok.go on
// github.com/bradleyjkemp/sigma-go v0.6.4, `evaluator.CaseSensitive`):
//   - a selection is an OR over groups; a group is an AND over field matches;
//   - a field match succeeds when ANY expected value matches ANY value of the
//     field (`|all`: EVERY expected value matches some value of the field);
//   - `contains` / `startswith` / `endswith` are case-SENSITIVE and literal —
//     sigma-go v0.6.4 compares with strings.Contains / HasPrefix / HasSuffix,
//     so `*` and `?` in a value are ordinary characters, not wildcards;
//   - the bare (no-modifier) comparison is case-INSENSITIVE full equality;
//   - `re` is an unanchored regex search;
//   - a missing / empty field matches nothing.
// `1 of x*` / `all of them` are expanded to plain and/or at vendor time.
//
// Evidence-field fidelity — what IOK means vs what a capture holds
// (IOK_FIELD_FIDELITY is the baseline for a capture WITHOUT network
// evidence; a capture that has the artifact upgrades the field, see
// `IokEvidence.fidelity` and lib/page-capture-network.ts):
//   exact       `dom` (the rendered HTML is IOK's `dom`), `hostname`; and,
//               when the capture holds the real artifact and nothing was
//               cut: `html` (the main response body as served), `headers`
//               (that response's headers, IOK's `Canonical-Name: value`),
//               `requests` (the browser's own request log).
//   subset      `title` (final title only), `js` / `css` (INLINE <script> /
//               <style> bodies only — external files are not stored), and
//               `cookies` (the page's own origin only; IOK also reads
//               third-party cookies). A real artifact that was cut by a cap
//               (body over the size cap, request list over 300, a header or
//               cookie value clipped) is a subset too. A subset can MISS a
//               match; it cannot invent one.
//   approximate `html` / `requests` on a capture WITHOUT the artifact —
//               `html` is evaluated against the rendered DOM (it can MISS
//               and OVER-MATCH: a string a script injected was never in the
//               response); `requests` is the redirect chain and final URL
//               plus sub-resource URLs the DOM's own start tags reference
//               (misses fetch / XHR, over-matches a referenced URL never
//               requested).
//   absent      `headers` / `cookies` on a capture without the artifact:
//               an empty list, so a positive match on them never happens.
// Policy, applied at vendor time (scripts/iok-compile.ts) and at run time:
//   - under `not`, only a field that CAN be exact is allowed (dom, hostname,
//     html, requests, headers); a rule negating title / js / css / cookies is
//     dropped (a missed match under negation is a false positive);
//   - at run time a rule that negates a field is evaluated ONLY on a capture
//     where that field is exact. On any other capture the rule is NOT
//     APPLICABLE (counted in `not_applicable`, never matches): an empty
//     `headers` list must not make `not nginxHeader` true;
//   - positive use of a non-exact field is KEPT. An over-match there still
//     means the kit's literal string is in the rendered page, or the page's
//     own markup points at the kit's file — the same evidence IOK's `dom`
//     field targets. That is acceptable for a staff-only context signal
//     that never alerts, and every match lists the non-exact fields its
//     rule reads (`approximate_fields`) so a reader can weigh it.
//
// Safety (rules are third-party input, HTML is attacker input):
//   - a regex is compiled only if its exact source is on the hand-reviewed
//     allowlist (lib/iok-regex-allowlist.ts) AND passes `assessRegexSafety`;
//     anything else never matches. A running `RegExp.test` cannot be
//     interrupted, so no budget substitutes for this;
//   - regex input is capped at IOK_REGEX_INPUT_MAX chars; every evidence
//     field is capped (IOK_TEXT_MAX / IOK_LIST_MAX / IOK_ITEM_MAX);
//   - a deterministic work budget (characters scanned, IOK_WORK_BUDGET) ends
//     the evaluation between comparisons — Workers freezes the clock during
//     synchronous work, so a wall-clock budget alone cannot be relied on; an
//     optional clock budget is honoured too where time does advance;
//   - clipped input and an exhausted budget are REPORTED (`status`
//     truncated / partial), never passed off as "checked, no match".

import { isAllowedIokRegex } from "./iok-regex-allowlist";

// ─── Ruleset shape (src/data/iok/rules.json) ─────────────────────────

export const IOK_FIELDS = ["html", "dom", "title", "hostname", "js", "css", "requests", "headers", "cookies"] as const;
export type IokField = (typeof IOK_FIELDS)[number];

/** `exact` = same data IOK evaluates. `subset` = part of it (can miss, cannot
 *  invent). `approximate` = a stand-in that can both miss and over-match.
 *  `absent` = no data on this capture (the field reads as an empty list). */
export type IokFidelity = "exact" | "subset" | "approximate" | "absent";

/** Baseline fidelity, for a capture WITHOUT network evidence. */
export const IOK_FIELD_FIDELITY: Readonly<Record<IokField, IokFidelity>> = {
  dom: "exact",
  hostname: "exact",
  title: "subset",
  js: "subset",
  css: "subset",
  html: "approximate",
  requests: "approximate",
  headers: "absent",
  cookies: "absent",
};

/** Fields a capture can hold exactly (with the real artifact): the only
 *  ones a rule may negate. title / js / css / cookies are never exact. */
export const IOK_NEGATABLE_FIELDS: readonly IokField[] = ["dom", "hostname", "html", "requests", "headers"];

export type IokOp = "eq" | "contains" | "startswith" | "endswith" | "re";

export interface IokFieldMatch {
  /** Field. */
  f: IokField;
  /** Comparator. */
  op: IokOp;
  /** `|all` — every value must match. */
  all?: true;
  /** Expected values (strings; `re` = JS-compatible regex source). */
  v: string[];
  /** Regex flags (only `i`, from a leading RE2 `(?i)`). */
  fl?: "i";
}

/** AND of field matches. */
export type IokGroup = IokFieldMatch[];

export type IokCond =
  | { t: "ref"; n: string }
  | { t: "and"; c: IokCond[] }
  | { t: "or"; c: IokCond[] }
  | { t: "not"; c: IokCond };

export interface IokRule {
  id: string;
  title: string;
  level?: string;
  tags: string[];
  /** Selection name → OR of groups. */
  sel: Record<string, IokGroup[]>;
  cond: IokCond;
}

export interface IokRuleSetSource {
  repository: string;
  commit: string;
  commit_date: string;
  vendored_at: string;
  licence: string;
  attribution: string;
}

export interface IokRuleSet {
  format: 1;
  source: IokRuleSetSource;
  /** Counts from the vendor run (also in SOURCE.md). */
  stats: { total: number; kept: number; dropped: number; dropped_by_reason: Record<string, number> };
  rules: IokRule[];
}

// ─── Limits ──────────────────────────────────────────────────────────

/** Max chars of html / dom evaluated (the capture itself is ≤ 2 MB). */
export const IOK_TEXT_MAX = 1_000_000;
/** Max items in a list field (js / css / requests / title). */
export const IOK_LIST_MAX = 300;
/** Max chars per list item. */
export const IOK_ITEM_MAX = 200_000;
/** Max total chars across one list field. */
export const IOK_LIST_TOTAL_MAX = 1_000_000;
/** Max chars of any one value a regex is run over. */
export const IOK_REGEX_INPUT_MAX = 256_000;
/** Regex sources longer than this are rejected. */
export const IOK_REGEX_MAX_LENGTH = 256;
/** Max repetition count of one bounded quantifier. */
export const IOK_REGEX_MAX_REPEAT = 1000;
/** Max product of (max − min + 1) over a pattern's variable-width quantifiers. */
export const IOK_REGEX_MAX_AMBIGUITY = 64;
/** Deterministic work budget per evaluation: characters handed to string
 *  comparators (regex input weighted ×IOK_REGEX_WORK_WEIGHT). */
export const IOK_WORK_BUDGET = 400_000_000;
export const IOK_REGEX_WORK_WEIGHT = 4;
/** Max matches returned / stored per capture. */
export const IOK_MAX_MATCHES = 50;
/** Longest start tag the DOM scanner will read (attacker markup). */
const MAX_TAG_CHARS = 65_536;

// ─── Regex safety screen (second check; the allowlist is the first) ──

export type RegexSafety = { ok: true } | { ok: false; reason: string };

interface ReNode {
  /** Contains a quantifier. */
  quant: boolean;
  /** Contains an alternation. */
  alt: boolean;
}

class RegexUnsafe extends Error {}

/**
 * Conservative static screen of a JS regex source (non-`u` mode). It is NOT
 * the trust boundary — lib/iok-regex-allowlist.ts is; a screen can always be
 * fooled by a shape nobody listed. Accepts: literals, escapes (\d \w \s \b,
 * punctuation, \n \t \xHH \uHHHH), `.`, classes (no POSIX `[:x:]`), groups
 * `( )` / `(?: )` / `(?<name> )`, alternation, quantifiers. Rejects:
 *   - backreferences, lookaround, inline flags, unicode property escapes;
 *   - any unbounded quantifier (`*`, `+`, `{n,}`) that is not the FINAL
 *     token of the pattern;
 *   - a quantifier that can repeat (max > 1) applied to a group that itself
 *     contains a quantifier or an alternation — `(\w{1,30}){1,30}`,
 *     `(a|ab){1,30}`, `(?:\w|\d){24}`, `(a|aa){20}`;
 *   - variable-width quantifiers whose combined choices exceed
 *     IOK_REGEX_MAX_AMBIGUITY — `\w{0,1000}\w{0,1000}`;
 *   - repetition counts above IOK_REGEX_MAX_REPEAT, stray braces, sources
 *     longer than IOK_REGEX_MAX_LENGTH.
 */
export function assessRegexSafety(src: string): RegexSafety {
  if (src.length === 0) return { ok: false, reason: "empty pattern" };
  if (src.length > IOK_REGEX_MAX_LENGTH) return { ok: false, reason: `pattern longer than ${IOK_REGEX_MAX_LENGTH} chars` };
  let i = 0;
  let ambiguity = 1;

  const fail = (reason: string): never => {
    throw new RegexUnsafe(reason);
  };

  const parseEscape = (inClass: boolean): void => {
    const c = src[i + 1];
    if (c === undefined) return fail("trailing backslash");
    if (/[1-9]/.test(c)) fail("backreference");
    if (c === "k") fail("named backreference");
    if (c === "p" || c === "P") fail("unicode property escape");
    if (c === "c") fail("control escape");
    if (c === "x") {
      if (!/^[0-9A-Fa-f]{2}$/.test(src.slice(i + 2, i + 4))) fail("bad \\x escape");
      i += 4;
      return;
    }
    if (c === "u") {
      if (!/^[0-9A-Fa-f]{4}$/.test(src.slice(i + 2, i + 6))) fail("bad \\u escape");
      i += 6;
      return;
    }
    if (/[dDwWsSnrtfv0]/.test(c) || (!inClass && /[bB]/.test(c)) || /[^A-Za-z0-9]/.test(c)) {
      i += 2;
      return;
    }
    fail(`unsupported escape \\${c}`);
  };

  const parseClass = (): void => {
    i++;
    if (src[i] === "^") i++;
    if (src[i] === "]") i++; // literal ] first
    while (i < src.length && src[i] !== "]") {
      if (src[i] === "[" && src[i + 1] === ":") fail("POSIX class");
      if (src[i] === "\\") parseEscape(true);
      else i++;
    }
    if (src[i] !== "]") fail("unterminated class");
    i++;
  };

  /** Quantifier at i (if any). */
  const parseQuantifier = (): { min: number; max: number; present: boolean } => {
    const c = src[i];
    let min = 1;
    let max = 1;
    let present = false;
    if (c === "*" || c === "+") {
      min = c === "*" ? 0 : 1;
      max = Infinity;
      present = true;
      i++;
    } else if (c === "?") {
      min = 0;
      present = true;
      i++;
    } else if (c === "{") {
      const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(src.slice(i));
      if (!m) return fail("stray brace");
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (max < min) fail("bad quantifier range");
      present = true;
      i += m[0].length;
    }
    if (present && src[i] === "?") i++; // lazy
    if (present && (src[i] === "*" || src[i] === "+" || src[i] === "?" || src[i] === "{")) fail("stacked quantifier");
    return { min, max, present };
  };

  const parseSeq = (depth: number): ReNode => {
    let quant = false;
    let alt = false;
    while (i < src.length && src[i] !== ")") {
      if (src[i] === "|") {
        alt = true;
        i++;
        continue;
      }
      const atomStart = i;
      let inner: ReNode = { quant: false, alt: false };
      const c = src[i]!;
      if (c === "(") {
        if (src.startsWith("(?:", i)) i += 3;
        else if (src.startsWith("(?<", i) && /^\(\?<[A-Za-z_][A-Za-z0-9_]*>/.test(src.slice(i))) {
          i = src.indexOf(">", i) + 1;
        } else if (src[i + 1] === "?") fail("lookaround / inline flag group");
        else i++;
        inner = parseSeq(depth + 1);
        if (src[i] !== ")") fail("unterminated group");
        i++;
      } else if (c === "[") {
        parseClass();
      } else if (c === "\\") {
        parseEscape(false);
      } else if (c === "*" || c === "+" || c === "?" || c === "{" || c === "}") {
        fail(c === "}" || c === "{" ? "stray brace" : "quantifier without atom");
      } else {
        i++;
      }
      if (atomStart === i) fail("parse stalled");
      const q = parseQuantifier();
      if (q.present) {
        if (q.max > 1 && (inner.quant || inner.alt)) fail("repeated group contains a quantifier or alternation");
        if (q.max === Infinity) {
          if (!(depth === 0 && i === src.length)) fail("unbounded quantifier before the end of the pattern");
        } else {
          if (q.max > IOK_REGEX_MAX_REPEAT) fail("bounded repetition too large");
          ambiguity *= q.max - q.min + 1;
          if (ambiguity > IOK_REGEX_MAX_AMBIGUITY) fail("too many variable-width quantifier choices");
        }
        quant = true;
      } else {
        quant = quant || inner.quant;
      }
      alt = alt || inner.alt;
    }
    return { quant, alt };
  };

  try {
    parseSeq(0);
    if (i !== src.length) fail("unbalanced parenthesis");
  } catch (err) {
    if (err instanceof RegexUnsafe) return { ok: false, reason: err.message };
    throw err;
  }
  try {
    new RegExp(src);
  } catch {
    return { ok: false, reason: "does not compile" };
  }
  return { ok: true };
}

/** Per-isolate compiled-regex cache (rules are static). null = refused. */
const regexCache = new Map<string, RegExp | null>();

/** Compile only an allowlisted pattern that also passes the screen. */
function compiledRegex(src: string, flags: string): RegExp | null {
  const key = `${flags}/${src}`;
  const hit = regexCache.get(key);
  if (hit !== undefined) return hit;
  let re: RegExp | null = null;
  if ((flags === "" || flags === "i") && isAllowedIokRegex(src, flags) && assessRegexSafety(src).ok) {
    try {
      re = new RegExp(src, flags);
    } catch {
      re = null;
    }
  }
  regexCache.set(key, re);
  return re;
}

// ─── Evidence ────────────────────────────────────────────────────────

export interface IokEvidence {
  html: string;
  dom: string;
  title: string[];
  hostname: string;
  js: string[];
  css: string[];
  requests: string[];
  /** `Name: value` entries of the main response (empty = none / not obtained). */
  headers?: string[];
  /** `name=value` entries (empty = none / not obtained). */
  cookies?: string[];
  /** Per-field overrides of IOK_FIELD_FIDELITY for THIS capture. */
  fidelity?: Partial<Record<IokField, IokFidelity>>;
  /** Some input was cut to fit a cap (text, list or item size). */
  clipped?: boolean;
}

/** The real artifacts of a capture (lib/page-capture-network.ts), as plain data. */
export interface IokNetworkInput {
  /** Main response body as served; null = not obtained. */
  rawHtml: string | null;
  rawHtmlTruncated: boolean;
  /** `Name: value`; null = headers not obtained. */
  headers: string[] | null;
  headersComplete: boolean;
  /** `name=value`; null = cookies not read. */
  cookies: string[] | null;
  /** Request URLs; null = no log. */
  requests: string[] | null;
  requestsComplete: boolean;
  /** The decoded body is the text IOK would compare (clean UTF-8 / ASCII).
   *  false = decoded with another charset or lossily: `html` is a subset.
   *  Absent = true. */
  rawHtmlTextExact?: boolean;
  /** Headers and body belong to the document the page ended on. false = a
   *  JS / meta-refresh navigation followed, so they belong to an earlier
   *  document: `html` and `headers` are subsets. Absent = true. */
  mainMatchesFinal?: boolean;
}

/** Fidelity of a field on THIS capture. */
export function fidelityOf(ev: Pick<IokEvidence, "fidelity">, f: IokField): IokFidelity {
  return ev.fidelity?.[f] ?? IOK_FIELD_FIDELITY[f];
}

export interface IokEvidenceInput {
  /** Rendered HTML (document.documentElement.outerHTML) as stored. */
  html: string;
  title: string | null;
  finalUrl: string | null;
  targetUrl: string | null;
  redirectChain: string[];
  /** Real artifacts (response body / headers, request log, cookies) when the capture holds them. */
  network?: IokNetworkInput | null;
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function decodeAttr(v: string): string {
  return v.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** `<link rel>` tokens whose href the browser fetches as a sub-resource.
 *  canonical / alternate / dns-prefetch / preconnect / prefetch are not. */
const FETCHED_LINK_RELS: ReadonlySet<string> = new Set(["stylesheet", "icon", "preload", "modulepreload", "manifest"]);
const JS_SCRIPT_TYPE = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|module)$/i;

/** Elements whose content the serializer writes as raw text (not escaped)
 *  and the browser does not load: skipped whole, like a comment. */
const RAW_TEXT_SKIP: ReadonlySet<string> = new Set(["noscript", "iframe", "noembed", "noframes", "xmp", "plaintext"]);

interface DomScan {
  js: string[];
  css: string[];
  /** Raw (still relative / entity-encoded) sub-resource references. */
  refs: string[];
  clipped: boolean;
}

function isNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
}
function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

/**
 * One forward pass over the serialized DOM (Chrome's outerHTML: lowercase
 * tag names, text-node `<` escaped as `&lt;`). Only REAL start tags are
 * read: comments are skipped, and the bodies of <script> / <style> are raw
 * text — collected as inline js / css, never scanned for tags. So a `src=`
 * inside a script string, a comment or page text is not a reference.
 * indexOf / charCode only; every loop moves forward (linear).
 */
function scanDom(html: string): DomScan {
  const out: DomScan = { js: [], css: [], refs: [], clipped: false };
  const budget = { js: IOK_LIST_TOTAL_MAX, css: IOK_LIST_TOTAL_MAX };
  const pushBody = (kind: "js" | "css", body: string): void => {
    const list = out[kind];
    if (body.length === 0) return;
    if (list.length >= IOK_LIST_MAX || budget[kind] <= 0) {
      out.clipped = true;
      return;
    }
    let v = body;
    if (v.length > IOK_ITEM_MAX) {
      v = v.slice(0, IOK_ITEM_MAX);
      out.clipped = true;
    }
    if (v.length > budget[kind]) {
      v = v.slice(0, budget[kind]);
      out.clipped = true;
    }
    budget[kind] -= v.length;
    list.push(v);
  };

  const n = html.length;
  let pos = 0;
  while (pos < n) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      pos = end + 3;
      continue;
    }
    const first = html.charCodeAt(lt + 1);
    if (!((first >= 97 && first <= 122) || (first >= 65 && first <= 90))) {
      pos = lt + 1; // `</x>`, `<!doctype`, a stray `<`
      continue;
    }
    // Tag name.
    let p = lt + 1;
    while (p < n && isNameChar(html.charCodeAt(p))) p++;
    const tag = html.slice(lt + 1, p).toLowerCase();
    // Attributes up to the closing `>` (quotes respected), bounded.
    const limit = Math.min(n, lt + MAX_TAG_CHARS);
    let src: string | null = null;
    let href: string | null = null;
    let rel = "";
    let type: string | null = null;
    let closed = false;
    while (p < limit) {
      const c = html.charCodeAt(p);
      if (c === 62 /* > */) {
        closed = true;
        p++;
        break;
      }
      if (isSpace(c) || c === 47 /* / */) {
        p++;
        continue;
      }
      const nameStart = p;
      while (p < limit) {
        const d = html.charCodeAt(p);
        if (d === 61 || d === 62 || d === 47 || isSpace(d)) break;
        p++;
      }
      if (p === nameStart) {
        p++; // a lone `=` — skip it
        continue;
      }
      const name = html.slice(nameStart, p).toLowerCase();
      let value = "";
      if (html.charCodeAt(p) === 61 /* = */) {
        p++;
        const q = html.charCodeAt(p);
        if (q === 34 || q === 39) {
          const end = html.indexOf(q === 34 ? "\"" : "'", p + 1);
          if (end === -1 || end >= limit) {
            p = limit;
            break;
          }
          value = html.slice(p + 1, end);
          p = end + 1;
        } else {
          const vs = p;
          while (p < limit) {
            const d = html.charCodeAt(p);
            if (d === 62 || isSpace(d)) break;
            p++;
          }
          value = html.slice(vs, p);
        }
      }
      if (name === "src") src = value;
      else if (name === "href") href = value;
      else if (name === "rel") rel = value;
      else if (name === "type") type = value;
    }
    if (!closed) break; // unterminated or oversized tag: stop, don't guess

    if (src !== null && src.length > 0 && src.length <= 2048) out.refs.push(src);
    if (tag === "link" && href !== null && href.length > 0 && href.length <= 2048) {
      const rels = rel.toLowerCase().split(/\s+/);
      if (rels.some((r) => FETCHED_LINK_RELS.has(r))) out.refs.push(href);
    }
    if (out.refs.length > IOK_LIST_MAX * 4) {
      out.refs.length = IOK_LIST_MAX * 4;
      out.clipped = true;
    }

    if (tag === "script" || tag === "style" || RAW_TEXT_SKIP.has(tag)) {
      const close = `</${tag}`;
      const end = html.indexOf(close, p);
      if (end === -1) break; // unclosed raw-text element: the rest is its body
      if (tag === "style") pushBody("css", html.slice(p, end));
      else if (tag === "script" && src === null && (type === null || type === "" || JS_SCRIPT_TYPE.test(type))) pushBody("js", html.slice(p, end));
      pos = end + close.length;
    } else {
      pos = p;
    }
  }
  return out;
}

/** Max chars of one header / cookie entry kept as evidence. */
const IOK_PAIR_MAX = 8_192;

/** Cap a `name: value` / `name=value` list; true when anything was cut. */
function capPairs(list: string[]): { out: string[]; clipped: boolean } {
  let clipped = list.length > IOK_LIST_MAX;
  const out: string[] = [];
  for (const e of list.slice(0, IOK_LIST_MAX)) {
    if (e.length > IOK_PAIR_MAX) {
      out.push(e.slice(0, IOK_PAIR_MAX));
      clipped = true;
    } else {
      out.push(e);
    }
  }
  return { out, clipped };
}

/** Build the evidence object from what one capture stores. Pure. */
export function buildIokEvidence(input: IokEvidenceInput): IokEvidence {
  const net = input.network ?? null;
  let clipped = input.html.length > IOK_TEXT_MAX;
  const dom = clipped ? input.html.slice(0, IOK_TEXT_MAX) : input.html;
  const base = input.finalUrl ?? input.targetUrl;
  const scan = scanDom(dom);
  clipped = clipped || scan.clipped;
  const fidelity: Partial<Record<IokField, IokFidelity>> = {};

  // html: the response as served when we have it, else the rendered DOM.
  let html = dom;
  if (net && net.rawHtml !== null) {
    const rawClipped = net.rawHtml.length > IOK_TEXT_MAX;
    html = rawClipped ? net.rawHtml.slice(0, IOK_TEXT_MAX) : net.rawHtml;
    clipped = clipped || rawClipped;
    fidelity.html = net.rawHtmlTruncated || rawClipped || net.rawHtmlTextExact === false || net.mainMatchesFinal === false ? "subset" : "exact";
  }

  const requests: string[] = [];
  const seen = new Set<string>();
  let requestsCut = false;
  const add = (u: string): void => {
    if (!u || seen.has(u)) return;
    if (requests.length >= IOK_LIST_MAX) {
      clipped = true;
      requestsCut = true;
      return;
    }
    seen.add(u);
    requests.push(u.length > 2048 ? u.slice(0, 2048) : u);
  };
  for (const rawUrl of [...input.redirectChain, input.finalUrl ?? ""]) {
    let u = rawUrl;
    try {
      u = rawUrl ? new URL(rawUrl).toString() : "";
    } catch { /* keep as stored */ }
    add(u);
  }
  if (net && net.requests !== null) {
    // The browser's own request log: nothing is inferred from markup, so a
    // URL that was never requested cannot match.
    for (const r of net.requests) add(r);
    fidelity.requests = net.requestsComplete && !requestsCut ? "exact" : "subset";
  } else {
    for (const r of scan.refs) {
      try {
        const u = base ? new URL(decodeAttr(r), base) : new URL(decodeAttr(r));
        if (u.protocol === "http:" || u.protocol === "https:") add(u.toString());
      } catch { /* not a URL */ }
    }
  }

  let headers: string[] = [];
  if (net && net.headers !== null) {
    const c = capPairs(net.headers);
    headers = c.out;
    clipped = clipped || c.clipped;
    fidelity.headers = net.headersComplete && !c.clipped && net.mainMatchesFinal !== false ? "exact" : "subset";
  }
  let cookies: string[] = [];
  if (net && net.cookies !== null) {
    const c = capPairs(net.cookies);
    cookies = c.out;
    clipped = clipped || c.clipped;
    // Own-origin cookies only: IOK also reads third-party ones.
    fidelity.cookies = "subset";
  }

  let title = input.title ?? "";
  if (title.length > 2048) {
    title = title.slice(0, 2048);
    clipped = true;
  }
  return {
    html,
    dom,
    title: title ? [title] : [],
    hostname: hostOf(input.finalUrl) || hostOf(input.targetUrl),
    js: scan.js,
    css: scan.css,
    requests,
    headers,
    cookies,
    fidelity,
    clipped,
  };
}

// ─── Evaluation ──────────────────────────────────────────────────────

export interface IokMatch {
  rule_id: string;
  title: string;
  tags: string[];
  /** Non-exact fields the rule reads on THIS capture (fidelity ≠ exact; a
   *  field with no data on the capture is left out), sorted. Empty = the
   *  match rests on exact fields only. */
  approximate_fields: IokField[];
  /** The subset of `approximate_fields` whose fidelity is `subset` (incomplete
   *  evidence: another rule may have been MISSED, this match is not an
   *  over-match). The rest are `approximate` (can over-match). */
  subset_fields: IokField[];
}

/** complete = every rule saw all the evidence. truncated = every rule ran,
 *  but some input was clipped to a cap (a match may have been missed).
 *  partial = a budget ended the run before every rule was evaluated. */
export type IokEvalStatus = "complete" | "truncated" | "partial";

export interface IokEvaluation {
  matches: IokMatch[];
  status: IokEvalStatus;
  /** Rules fully evaluated. */
  evaluated: number;
  /** Rules not evaluated because a budget ran out. */
  skipped: number;
  /** Rules that negate a field this capture does not hold exactly: not
   *  evaluated (they cannot match), not a budget skip. */
  not_applicable: number;
  /** A budget (work or clock) ended the evaluation early. */
  budget_exhausted: boolean;
  /** Evidence or a regex input was clipped to a cap. */
  input_clipped: boolean;
  /** Characters scanned (regex weighted). */
  work: number;
  /** Regex sources refused (not allowlisted / failed the screen). */
  regex_rejected: number;
  /** More rules matched than IOK_MAX_MATCHES (list truncated). */
  truncated: boolean;
}

export interface IokEvalOptions {
  workBudget?: number;
  /** Optional wall-clock budget; honoured only where `now()` advances. */
  timeBudgetMs?: number;
  now?: () => number;
}

class BudgetExhausted extends Error {}

function fieldValues(ev: IokEvidence, f: IokField): readonly string[] {
  const v = ev[f];
  if (typeof v === "string") return v.length > 0 ? [v] : [];
  return v ?? [];
}

function eqFold(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();
}

/** Selection names referenced under an odd number of `not`. */
export function negatedRefs(c: IokCond, neg = false, out: Set<string> = new Set()): Set<string> {
  switch (c.t) {
    case "ref":
      if (neg) out.add(c.n);
      break;
    case "not":
      negatedRefs(c.c, !neg, out);
      break;
    case "and":
    case "or":
      for (const x of c.c) negatedRefs(x, neg, out);
      break;
  }
  return out;
}

const negatedFieldsCache = new WeakMap<object, IokField[]>();

/** Fields read inside a negated selection, sorted. */
export function negatedFieldsOf(rule: Pick<IokRule, "sel" | "cond">): IokField[] {
  const hit = negatedFieldsCache.get(rule);
  if (hit) return hit;
  const out = new Set<IokField>();
  for (const n of negatedRefs(rule.cond)) {
    for (const g of rule.sel[n] ?? []) for (const m of g) out.add(m.f);
  }
  const list = [...out].sort();
  negatedFieldsCache.set(rule, list);
  return list;
}

/** A rule that negates a field is evaluated only where that field is exact. */
export function negationApplicable(rule: Pick<IokRule, "sel" | "cond">, ev: Pick<IokEvidence, "fidelity">): boolean {
  return negatedFieldsOf(rule).every((f) => fidelityOf(ev, f) === "exact");
}

/** Fields a rule reads whose fidelity on this capture is `subset`. */
export function subsetFieldsOf(rule: Pick<IokRule, "sel">, ev?: Pick<IokEvidence, "fidelity">): IokField[] {
  const out = new Set<IokField>();
  for (const groups of Object.values(rule.sel)) {
    for (const g of groups) {
      for (const m of g) {
        if ((ev ? fidelityOf(ev, m.f) : IOK_FIELD_FIDELITY[m.f]) === "subset") out.add(m.f);
      }
    }
  }
  return [...out].sort();
}

/** Non-exact fields a rule reads. Without `ev`, the baseline (no network
 *  evidence); a field with no data (`absent`) is left out either way. */
export function approximateFieldsOf(rule: Pick<IokRule, "sel">, ev?: Pick<IokEvidence, "fidelity">): IokField[] {
  const out = new Set<IokField>();
  for (const groups of Object.values(rule.sel)) {
    for (const g of groups) {
      for (const m of g) {
        const fid = ev ? fidelityOf(ev, m.f) : IOK_FIELD_FIDELITY[m.f];
        if (fid !== "exact" && fid !== "absent") out.add(m.f);
      }
    }
  }
  return [...out].sort();
}

export function evaluateIokRules(ruleset: Pick<IokRuleSet, "rules">, ev: IokEvidence, opts: IokEvalOptions = {}): IokEvaluation {
  const workBudget = opts.workBudget ?? IOK_WORK_BUDGET;
  const now = opts.now;
  const deadline = now && opts.timeBudgetMs !== undefined ? now() + opts.timeBudgetMs : Infinity;
  let work = 0;
  let regexRejected = 0;
  let inputClipped = ev.clipped === true;
  const rejectedSeen = new Set<string>();

  const charge = (n: number): void => {
    work += n;
    if (work > workBudget) throw new BudgetExhausted();
  };

  const valueMatches = (m: IokFieldMatch, expected: string, actual: string): boolean => {
    switch (m.op) {
      case "contains":
        charge(actual.length);
        return actual.includes(expected);
      case "startswith":
        charge(Math.min(actual.length, expected.length));
        return actual.startsWith(expected);
      case "endswith":
        charge(Math.min(actual.length, expected.length));
        return actual.endsWith(expected);
      case "eq":
        charge(Math.min(actual.length, expected.length));
        return eqFold(actual, expected);
      case "re": {
        const re = compiledRegex(expected, m.fl ?? "");
        if (!re) {
          if (!rejectedSeen.has(expected)) {
            rejectedSeen.add(expected);
            regexRejected++;
          }
          return false;
        }
        let input = actual;
        if (input.length > IOK_REGEX_INPUT_MAX) {
          input = input.slice(0, IOK_REGEX_INPUT_MAX);
          inputClipped = true;
        }
        charge(input.length * IOK_REGEX_WORK_WEIGHT);
        return re.test(input);
      }
    }
  };

  const fieldMatch = (m: IokFieldMatch): boolean => {
    const actual = fieldValues(ev, m.f);
    if (m.all) {
      for (const exp of m.v) {
        let hit = false;
        for (const a of actual) {
          if (valueMatches(m, exp, a)) { hit = true; break; }
        }
        if (!hit) return false;
      }
      return true;
    }
    for (const exp of m.v) {
      for (const a of actual) {
        if (valueMatches(m, exp, a)) return true;
      }
    }
    return false;
  };

  const matches: IokMatch[] = [];
  let evaluated = 0;
  let notApplicable = 0;
  let truncated = false;
  let exhausted = false;
  const rules = ruleset.rules;
  for (let r = 0; r < rules.length; r++) {
    const rule = rules[r]!;
    if (now && now() > deadline) {
      exhausted = true;
      break;
    }
    if (!negationApplicable(rule, ev)) {
      notApplicable++;
      continue;
    }
    const memo = new Map<string, boolean>();
    const selection = (name: string): boolean => {
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const groups = rule.sel[name];
      // Undefined selection → false (sigma-go SearchIdentifier).
      let res = false;
      if (groups) {
        for (const g of groups) {
          let all = true;
          for (const m of g) {
            if (!fieldMatch(m)) { all = false; break; }
          }
          if (all) { res = true; break; }
        }
      }
      memo.set(name, res);
      return res;
    };
    const cond = (c: IokCond): boolean => {
      switch (c.t) {
        case "ref": return selection(c.n);
        case "not": return !cond(c.c);
        case "and": return c.c.every(cond);
        case "or": return c.c.some(cond);
      }
    };
    let hit: boolean;
    try {
      hit = cond(rule.cond);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        exhausted = true;
        break;
      }
      throw err;
    }
    evaluated++;
    if (hit) {
      if (matches.length >= IOK_MAX_MATCHES) truncated = true;
      else matches.push({ rule_id: rule.id, title: rule.title, tags: rule.tags, approximate_fields: approximateFieldsOf(rule, ev), subset_fields: subsetFieldsOf(rule, ev) });
    }
  }
  return {
    matches,
    status: exhausted ? "partial" : inputClipped || truncated ? "truncated" : "complete",
    evaluated,
    skipped: rules.length - evaluated - notApplicable,
    not_applicable: notApplicable,
    budget_exhausted: exhausted,
    input_clipped: inputClipped,
    work,
    regex_rejected: regexRejected,
    truncated,
  };
}

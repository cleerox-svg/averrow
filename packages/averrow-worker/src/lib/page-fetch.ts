/**
 * SSRF-safe suspect-page fetcher (S2.4 / D6 increment 1).
 *
 * Fetches the LIVE HTML of ATTACKER-CONTROLLED lookalike domains so the
 * deterministic page-phishing scorer (lib/page-phishing-scorer.ts) can
 * grade it. Because the target is attacker-controlled, every layer here
 * is a security control. Read the enumerated controls below before
 * changing anything.
 *
 * ── SSRF controls (each maps to a task requirement) ────────────────
 *  1. Scheme allow-list: only http: / https: (phishing pages are often
 *     plain http). No file:/ftp:/gopher:/data: — enforced per hop.
 *  2. Static host block (url-guard.pageFetchHostStaticBlockReason):
 *     rejects IP-literal hosts in private/loopback/link-local/CGNAT/
 *     metadata ranges, localhost, *.local/*.internal/*.workers.dev,
 *     and the platform's own hosts — reusing the SAME range helpers
 *     used for outbound webhooks (no re-implemented IP math).
 *  3. Resolve-then-validate (DNS-rebinding defense): DoH-resolve A AND
 *     AAAA FIRST, run EVERY resolved IP through
 *     url-guard.resolvedIpBlockReason, reject 169.254.169.254 + all
 *     private ranges, THEN connect. Fail CLOSED — an unresolvable host
 *     is rejected, never fetched.
 *  4. Manual redirects: redirect:'manual', follow <= MAX_REDIRECTS
 *     hops, RE-VALIDATING host + resolved IP at EACH hop. Never
 *     auto-follow.
 *  5. Per-fetch timeout (AbortSignal.timeout) + a caller-supplied
 *     wall-clock deadline so a slow host can't approach the reap window.
 *  6. Response-size cap: stream and REJECT past MAX_BYTES; never buffer
 *     unbounded attacker content (also honours a declared Content-Length).
 *  7. Content-Type gate: process text/html only.
 *  8. Untrusted-HTML parsing via HTMLRewriter ONLY — streaming, bounded,
 *     no DOM, no script execution, no eval, no catastrophic-backtracking
 *     regex over attacker input.
 *
 * ── RESIDUAL RISK (flagged for appsec) ─────────────────────────────
 * TOCTOU DNS rebinding: Cloudflare Workers `fetch` performs its own DNS
 * resolution and does not expose IP pinning, so a low-TTL record could
 * flip to a private IP between our DoH validation (control 3) and the
 * actual connect. This is the same inherent limitation url-guard.ts
 * documents. Mitigations that bound the blast radius even on a
 * successful rebind: we only ever GET + parse HTML with HTMLRewriter
 * (no script execution, no credential/cookie forwarding — fetch is
 * called with no credentials), the body is size-capped, and redirects
 * are manually re-validated. Worst case is reading a bounded chunk of
 * an internal HTTP endpoint's HTML into page_signals — no write, no
 * code execution, no secret exfil path.
 *
 * NO AI anywhere in this module.
 */

import {
  pageFetchHostStaticBlockReason,
  resolvedIpBlockReason,
} from './url-guard';
import type { ParsedPageSignals } from './page-phishing-scorer';

// ── Tunables ───────────────────────────────────────────────────────
export const MAX_REDIRECTS = 2;
export const FETCH_TIMEOUT_MS = 5_000;
/** Hard body cap. Beyond this the fetch is rejected as oversize. */
export const MAX_BYTES = 512 * 1024;
/** Default per-run wall-clock budget for a whole fetch (all hops). */
export const DEFAULT_DEADLINE_MS = 12_000;

const FETCH_HEADERS: Record<string, string> = {
  // Benign, honest UA. We are a security scanner, not pretending to be
  // a browser; a real phishing page still serves HTML to a plain GET.
  'User-Agent': 'AverrowSafeFetch/1.0 (+https://averrow.com/security)',
  Accept: 'text/html,application/xhtml+xml',
};

/**
 * Interstitial phrases that mark a Cloudflare managed-challenge / generic
 * "checking your browser" wall (cloaking-as-signal, rec 4). All lowercase,
 * matched case-insensitively via bounded `.includes` on lowercased text —
 * NO regex over attacker HTML (SSRF contract). Consumed in two places:
 * the fetcher's `cf_challenge` phrase scan (parseSuspectHtml) and the
 * scorer's brand-relative `js_challenge` co-signal (page-phishing-scorer).
 */
export const CHALLENGE_PHRASES: readonly string[] = [
  'just a moment',
  'attention required',
  'verifying you are human',
  'checking your browser',
];

// ── Injected dependencies (real by default; overridden in tests) ────
export interface FetchDeps {
  /** Resolve a hostname to its A + AAAA IP strings (DoH). */
  resolve: (host: string) => Promise<string[]>;
  /** fetch implementation (global fetch by default). */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
}

export interface SuspectPageResult {
  ok: boolean;
  /** Set when the fetch was rejected (SSRF block, network, oversize, …). */
  rejectedReason?: string;
  /** True when rejection was an SSRF/policy block (vs a transient miss). */
  blocked?: boolean;
  httpStatus?: number;
  contentType?: string;
  truncated?: boolean;
  /** SHA-256 hex of the (capped) HTML bytes. */
  contentHash?: string;
  /**
   * Raw `cf-mitigated` response-header value (lowercased), when present —
   * forensic instrumentation for the anti-bot-wall signal (rec 4). The
   * one response header this module surfaces.
   */
  cfMitigated?: string;
  signals?: ParsedPageSignals;
}

// ── DoH A/AAAA resolver (real dependency) ──────────────────────────
interface DohJson {
  Status: number;
  Answer?: Array<{ type: number; data: string }>;
}

async function dohResolveOne(
  host: string,
  rrType: 'A' | 'AAAA',
  fetchImpl: FetchDeps['fetchImpl'],
): Promise<string[]> {
  try {
    const res = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${rrType}`,
      { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) } as RequestInit,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as DohJson;
    if (data.Status !== 0 || !data.Answer) return [];
    const wanted = rrType === 'A' ? 1 : 28;
    return data.Answer.filter((a) => a.type === wanted).map((a) => a.data);
  } catch {
    return [];
  }
}

/** Default resolver: A + AAAA via Cloudflare DoH. */
export async function defaultResolve(host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([
    dohResolveOne(host, 'A', globalThis.fetch),
    dohResolveOne(host, 'AAAA', globalThis.fetch),
  ]);
  return [...a, ...aaaa];
}

const realDeps: FetchDeps = {
  resolve: defaultResolve,
  fetchImpl: (url, init) => globalThis.fetch(url, init),
};

// ── Target validation (control 2 + 3) ──────────────────────────────
export type TargetCheck =
  | { ok: true }
  | { ok: false; reason: string; blocked: boolean };

/**
 * Validate a canonical hostname: static block-list, then DoH-resolve
 * and validate EVERY resolved IP. Fails closed. `cache` memoizes DoH
 * results across schemes/hops within one fetchSuspectPage call.
 */
export async function assertResolvedHostSafe(
  host: string,
  deps: FetchDeps,
  cache: Map<string, string[]>,
): Promise<TargetCheck> {
  const staticReason = pageFetchHostStaticBlockReason(host);
  if (staticReason) return { ok: false, reason: `static: ${staticReason}`, blocked: true };

  let ips = cache.get(host);
  if (!ips) {
    ips = await deps.resolve(host);
    cache.set(host, ips);
  }
  // Fail closed: an unresolvable host is never fetched. Treated as a
  // transient miss (not an SSRF block) so the caller may try the other
  // scheme, but it never connects.
  if (ips.length === 0) return { ok: false, reason: 'unresolvable', blocked: false };

  for (const ip of ips) {
    const ipReason = resolvedIpBlockReason(ip);
    if (ipReason) return { ok: false, reason: `resolved ${ip} blocked: ${ipReason}`, blocked: true };
  }
  return { ok: true };
}

// ── Redirect-following (control 1 + 4 + 5) ─────────────────────────
type FollowResult =
  | { ok: true; response: Response; finalUrl: string }
  | { ok: false; reason: string; blocked: boolean };

/**
 * Fetch `startUrl`, manually following up to MAX_REDIRECTS redirects,
 * re-validating scheme + host + resolved IP at each hop. Returns the
 * first non-redirect response, or a rejection.
 */
export async function followToFinalResponse(
  startUrl: URL,
  deps: FetchDeps,
  deadlineAt: number,
  cache: Map<string, string[]>,
): Promise<FollowResult> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() > deadlineAt) return { ok: false, reason: 'deadline_exceeded', blocked: false };

    // Control 1: scheme allow-list, re-checked every hop.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: `disallowed_scheme: ${url.protocol}`, blocked: true };
    }

    // Control 2 + 3: validate the CANONICAL host (url.hostname strips
    // userinfo like evil.com@169.254.169.254 → 169.254.169.254).
    const safe = await assertResolvedHostSafe(url.hostname, deps, cache);
    if (!safe.ok) return { ok: false, reason: safe.reason, blocked: safe.blocked };

    let res: Response;
    try {
      res = await deps.fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'manual', // control 4 — never auto-follow
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // control 5
        headers: FETCH_HEADERS,
      } as RequestInit);
    } catch {
      return { ok: false, reason: 'fetch_error', blocked: false };
    }

    if (res.status >= 300 && res.status < 400) {
      if (hop === MAX_REDIRECTS) return { ok: false, reason: 'too_many_redirects', blocked: false };
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, reason: 'redirect_without_location', blocked: false };
      try {
        url = new URL(loc, url);
      } catch {
        return { ok: false, reason: 'bad_redirect_location', blocked: false };
      }
      continue;
    }

    return { ok: true, response: res, finalUrl: url.toString() };
  }
  return { ok: false, reason: 'too_many_redirects', blocked: false };
}

// ── Size cap + content-type gate (control 6 + 7) ───────────────────
export type LimitsResult =
  | { ok: true; bytes: Uint8Array; contentType: string; truncated: boolean }
  | { ok: false; reason: string; contentType: string };

/**
 * Enforce content-type (text/html only) and a hard body cap. Rejects
 * oversize responses (declared or streamed) rather than buffering
 * unbounded attacker content. Cancels the stream as soon as the cap is
 * crossed.
 */
export async function enforceResponseLimits(
  response: Response,
  maxBytes = MAX_BYTES,
): Promise<LimitsResult> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html')) {
    return { ok: false, reason: 'non_html_content_type', contentType };
  }

  // Early reject on a declared oversize length — avoids streaming at all.
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: 'oversize_declared', contentType };
  }

  const body = response.body;
  if (!body) return { ok: true, bytes: new Uint8Array(0), contentType, truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > maxBytes) {
        // Control 6: abort past the cap; do NOT parse partial oversize.
        try { await reader.cancel(); } catch { /* already closed */ }
        return { ok: false, reason: 'oversize', contentType };
      }
      chunks.push(value);
      total += value.length;
    }
  } catch {
    try { await reader.cancel(); } catch { /* ignore */ }
    // Use whatever we safely buffered so far (already <= maxBytes).
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { ok: true, bytes, contentType, truncated: false };
}

// ── HTMLRewriter parse (control 8 — Workers runtime only) ──────────
const MAX_FORM_ACTIONS = 64;
const MAX_RESOURCE_URLS = 256;
const MAX_ICON_HREFS = 16;
const MAX_TITLE_LEN = 300;
const MAX_BODY_SAMPLE = 20_000;
const MAX_SCRIPT_SAMPLE = 40_000;
/**
 * Total character budget across ALL captured HTML comments (Lane 3 §3.2).
 * Same bounded-accumulator idiom as MAX_BODY_SAMPLE above: attacker
 * content is never buffered past a fixed cap.
 *
 * Kept as an ARRAY of per-comment slices rather than one blob because the
 * `agent_scaffold_comment` rule is scoped to a SINGLE comment — a
 * checklist split across two unrelated comments is not the signal.
 */
export const MAX_COMMENT_SAMPLE = 8_192;
/** Hard cap on the number of comment slices retained. */
export const MAX_COMMENTS = 64;
/** Cap on `<meta name="generator">` content (metadata, weight 0). */
const MAX_GENERATOR_LEN = 64;

/**
 * Characters stripped from a captured `<meta name="generator">` value.
 * The column is a GROUPING DIMENSION (weight 0) that spec §3.5 plans to
 * render — and the likeliest sinks are NOT auto-escaping React: a CSV
 * export, the briefing email, the §5.5 takedown-notice template. Markup
 * and quote characters carry no grouping information whatsoever, so
 * dropping them at capture costs nothing and removes the whole class of
 * downstream injection from an attacker-controlled string.
 * Control characters (< 0x20, and 0x7F) go for the same reason.
 */
const GENERATOR_BANNED_CHARS = '<>"\'`';

/** Strip markup/quote/control characters from an attacker-supplied
 *  generator token. No regex (SSRF/ReDoS contract) — a character walk. */
function sanitizeGenerator(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (GENERATOR_BANNED_CHARS.includes(ch)) continue;
    out += ch;
    if (out.length >= MAX_GENERATOR_LEN) break;
  }
  return out.trim();
}

/**
 * HTMLRewriter's `Element` exposes its attribute list as
 * `attributes: IterableIterator<string[]>` — each entry a
 * `[name, value]` pair (@cloudflare/workers-types
 * `latest/index.d.ts:1753`). It is NOT "attributes by name only", which
 * is what the old closed SVG-event-attribute list was justified by.
 *
 * The narrowing through `unknown` is needed because `lib.dom` is pulled
 * into this project transitively, so the GLOBAL `Element` identifier is
 * the merged lib.dom + workers-types interface and the DOM's
 * `NamedNodeMap` wins the `attributes` slot in the type system while the
 * runtime object is the Workers one. A structural runtime check is the
 * honest narrowing here — no `any`, no `@ts-ignore`. Returns null when
 * the shape isn't iterable, so the caller degrades to "no on* attribute"
 * rather than throwing.
 */
function elementAttributes(el: unknown): IterableIterator<string[]> | null {
  if (el === null || typeof el !== 'object') return null;
  const attrs: unknown = (el as { attributes?: unknown }).attributes;
  if (attrs === null || typeof attrs !== 'object') return null;
  if (!(Symbol.iterator in attrs)) return null;
  return attrs as IterableIterator<string[]>;
}

/** Download filename extensions that a data:image/svg+xml href disguises. */
const DISGUISED_DOWNLOAD_EXTS: readonly string[] = ['.pdf', '.docx', '.xlsx'];

/**
 * Extract JS-redirect targets from inline script text WITHOUT regex
 * that can backtrack: locate a small set of location-assignment markers
 * and read the first quoted string that follows. Bounded iterations.
 */
export function extractJsRedirectTargets(script: string): string[] {
  const targets: string[] = [];
  const markers = [
    'location.href', 'location.replace', 'location.assign',
    'window.location', 'document.location', 'location=',
  ];
  const lower = script.toLowerCase();
  const quotes = ['"', "'", '`'];

  for (const marker of markers) {
    let from = 0;
    for (let i = 0; i < 32 && targets.length < 32; i++) {
      const at = lower.indexOf(marker, from);
      if (at === -1) break;
      const segStart = at + marker.length;
      const seg = script.slice(segStart, Math.min(script.length, segStart + 300));
      // First quote char in the window.
      let qi = -1;
      let qc = '';
      for (const q of quotes) {
        const idx = seg.indexOf(q);
        if (idx !== -1 && (qi === -1 || idx < qi)) { qi = idx; qc = q; }
      }
      if (qi !== -1) {
        const rest = seg.slice(qi + 1);
        const close = rest.indexOf(qc);
        if (close > 0) targets.push(rest.slice(0, close));
      }
      from = segStart;
    }
  }
  return targets;
}

/**
 * Extract candidate EXFIL SINK targets from inline script text (Lane 3
 * §3.1 B1). Structurally identical to extractJsRedirectTargets above —
 * locate a small set of request-shaped markers and read the first quoted
 * string that follows, bounded iterations, NO regex over attacker HTML
 * (SSRF/ReDoS contract).
 *
 * This is the leg that closes the live false negative in
 * `offdomain_form_exfil`, which reads `<form action>` ONLY and therefore
 * cannot see a kit that POSTs credentials from script to a Telegram bot
 * or a Discord webhook.
 *
 * Markers are lowercase because the scan runs over a lowercased copy, the
 * same convention as extractJsRedirectTargets.
 *
 * Known limitation, deliberate: for `.open(` the FIRST quoted segment is
 * the HTTP method (`xhr.open('POST', url)`), not the URL, so that marker
 * contributes a useless 'post' token. It is kept because `.open(` is also
 * written as `.open("https://…")` in generated one-liners, and because
 * widening the walk to "the next N quoted segments" would deviate from
 * the extractJsRedirectTargets shape this is specified to mirror. The
 * `fetch(` / `sendBeacon(` / `axios.post(` markers carry the recall.
 */
export function extractScriptSinkTargets(script: string): string[] {
  const targets: string[] = [];
  const markers = [
    'fetch(', '.open(', 'xmlhttprequest',
    'navigator.sendbeacon(', 'axios.post(',
  ];
  const lower = script.toLowerCase();
  const quotes = ['"', "'", '`'];

  for (const marker of markers) {
    let from = 0;
    for (let i = 0; i < 32 && targets.length < 32; i++) {
      const at = lower.indexOf(marker, from);
      if (at === -1) break;
      const segStart = at + marker.length;
      const seg = script.slice(segStart, Math.min(script.length, segStart + 300));
      // First quote char in the window.
      let qi = -1;
      let qc = '';
      for (const q of quotes) {
        const idx = seg.indexOf(q);
        if (idx !== -1 && (qi === -1 || idx < qi)) { qi = idx; qc = q; }
      }
      if (qi !== -1) {
        const rest = seg.slice(qi + 1);
        const close = rest.indexOf(qc);
        if (close > 0) targets.push(rest.slice(0, close));
      }
      from = segStart;
    }
  }
  return targets;
}

/**
 * Parse suspect HTML into raw signals using HTMLRewriter ONLY.
 * Streaming, bounded, no DOM, no script execution. Requires the
 * Cloudflare Workers runtime (HTMLRewriter global).
 */
export async function parseSuspectHtml(bytes: Uint8Array): Promise<ParsedPageSignals> {
  let hasPasswordInput = false;
  const formActions: string[] = [];
  const resourceUrls: string[] = [];
  const iconHrefs: string[] = [];
  let metaRefresh: string | null = null;
  let title = '';
  let bodyTextSample = '';
  let scriptText = '';
  // ── Lane 3 accumulators (AI-build artifacts / exfil sinks) ────────
  // HTML comments were previously COMPLETELY invisible to this parser —
  // there was no comments() handler anywhere. They are the carrier for
  // `agent_scaffold_comment` and part of `build_placeholder_text`.
  const commentSamples: string[] = [];
  let commentBudget = MAX_COMMENT_SAMPLE;
  let metaGenerator: string | null = null;
  /** Inline <svg> subtree carrying <script>/<foreignObject>/an on* attr. */
  let svgScriptPayload = false;
  /** <a download="invoice.pdf"> whose href is a data:image/svg+xml URI. */
  let svgDownloadDisguise = false;
  // Anti-bot-wall family recorded by the fetcher (brand-agnostic tiers
  // only — the brand-relative `js_challenge` is resolved in the scorer).
  // First match wins by rank (widget families 1-3 outrank cf_challenge);
  // the "already set → skip" guard on every hook enforces precedence so a
  // later loose marker never downgrades a stronger structural one.
  let antiBotWall: string | null = null;

  // Rank precedence: lower number = higher priority. Used by the script
  // hook so a lower-rank script marker (cf_challenge) can never overwrite
  // a higher-rank family already recorded, and a higher-rank marker
  // upgrades a lower-rank one. null / unset ranks last.
  const wallRank = (fam: string | null): number => {
    switch (fam) {
      case 'turnstile': return 1;
      case 'recaptcha': return 2;
      case 'hcaptcha': return 3;
      case 'cf_challenge': return 4;
      default: return 99;
    }
  };

  const pushBounded = (arr: string[], val: string | null, max: number) => {
    if (val && arr.length < max) arr.push(val);
  };

  // Whole-class-token match without regex (SSRF/ReDoS contract): the vendor
  // class must appear delimited by HTML whitespace or a string end, so a
  // benign fragment like `search-captcha` does NOT match `h-captcha`, and
  // `flag-recaptcha` does NOT match `g-recaptcha`. Operates on a single
  // (already length-bounded) class attribute value.
  const isClassBoundary = (c: string): boolean =>
    c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const hasClassToken = (classAttr: string, token: string): boolean => {
    let from = 0;
    for (;;) {
      const idx = classAttr.indexOf(token, from);
      if (idx === -1) return false;
      const before = idx === 0 ? ' ' : classAttr[idx - 1]!;
      const afterIdx = idx + token.length;
      const after = afterIdx >= classAttr.length ? ' ' : classAttr[afterIdx]!;
      if (isClassBoundary(before) && isClassBoundary(after)) return true;
      from = idx + 1;
    }
  };

  /**
   * True when `el` carries ANY `on*` event-handler attribute.
   *
   * HTMLRewriter DOES expose the attribute list —
   * `Element.attributes: IterableIterator<string[]>` — so this is a real
   * prefix test over the element's actual attributes rather than a
   * guessed closed list. The previous closed list silently missed
   * `onmouseout`, `onpointerdown`, `onwheel`, `oninput`, `onauxclick`,
   * `oncopy`, `onscroll` and the rest of the (open-ended, vendor-
   * extensible) handler set, on a weight-15 signal whose false-positive
   * population is near zero. No regex; the walk is bounded by the
   * MAX_BYTES body cap.
   */
  const hasSvgEventAttr = (el: unknown): boolean => {
    const attrs = elementAttributes(el);
    if (!attrs) return false;
    for (const attr of attrs) {
      const name = attr[0];
      if (name !== undefined && name.toLowerCase().startsWith('on')) return true;
    }
    return false;
  };

  const rewriter = new HTMLRewriter()
    // Lane 3 §3.2 — bounded HTML-comment capture, DOCUMENT-WIDE.
    //
    // This was previously registered as `.on('*', { comments })`. The `*`
    // selector matches ELEMENTS, so a comment with no open element
    // ancestor — before `<!DOCTYPE html>`/`<html>`, or after `</html>` —
    // was never delivered. That prologue/epilogue is exactly where
    // builder banner comments live (`<!-- Generated by … -->`), which is
    // intended recall for `agent_scaffold_comment` and for the comment
    // leg of `build_placeholder_text`. `onDocument` fires document-wide
    // and costs nothing per element, so it also removes the per-element
    // selector match over up to MAX_BYTES of hostile input.
    //
    // (It is NOT a fix for duplicate dispatch: verified against the real
    // Workers runtime, `.on('*')` delivered one whole comment per
    // callback, not once per ancestor.)
    //
    // Both bounds and the single-comment scoping are preserved exactly:
    // HTMLRewriter delivers a comment whole (unlike text(), which
    // chunks), so each entry is one comment — which is what the A5 rule
    // requires — and the retained total is capped by MAX_COMMENT_SAMPLE /
    // MAX_COMMENTS.
    .onDocument({
      comments(c) {
        if (commentBudget <= 0 || commentSamples.length >= MAX_COMMENTS) return;
        const raw = c.text;
        if (!raw) return;
        const slice = raw.slice(0, commentBudget);
        commentSamples.push(slice);
        commentBudget -= slice.length;
      },
    })
    // Lane 3 §3.1 C1 leg (a) — an inline <svg> subtree containing
    // <script>, <foreignObject>, or an on* event attribute. Two bounded
    // registrations rather than depth tracking: the descendant selector
    // does the subtree scoping for us, so there is no end-tag bookkeeping
    // to get wrong on self-closing foreign content.
    .on('svg', {
      element(el) {
        if (!svgScriptPayload && hasSvgEventAttr(el)) svgScriptPayload = true;
      },
    })
    .on('svg *', {
      element(el) {
        if (svgScriptPayload) return;
        const tag = el.tagName.toLowerCase();
        if (tag === 'script' || tag === 'foreignobject' || hasSvgEventAttr(el)) {
          svgScriptPayload = true;
        }
      },
    })
    // Lane 3 §3.1 C1 leg (b) — a download link that advertises a
    // document but hands over an SVG. A genuine PDF is not an SVG, so the
    // FP population here is approximately zero.
    .on('a', {
      element(el) {
        if (svgDownloadDisguise) return;
        const dl = el.getAttribute('download');
        if (dl === null) return;
        const href = (el.getAttribute('href') ?? '').trim().toLowerCase();
        if (!href.startsWith('data:image/svg+xml')) return;
        const name = dl.trim().toLowerCase();
        if (DISGUISED_DOWNLOAD_EXTS.some((ext) => name.endsWith(ext))) {
          svgDownloadDisguise = true;
        }
      },
    })
    .on('input', {
      element(el) {
        if (hasPasswordInput) return;
        const type = el.getAttribute('type');
        if (type && type.toLowerCase() === 'password') hasPasswordInput = true;
      },
    })
    // Anti-bot-wall widget detection (rec 4) — brand-agnostic tiers 1-3.
    // Widgets render into any tag (div/span/custom element), so match on
    // the `class` attribute, not a tag whitelist. O(1) with an early exit
    // once a family is recorded; body is already MAX_BYTES-capped so the
    // work over the many `[class]` elements is bounded. Bounded `.includes`
    // only — NO regex over attacker HTML (SSRF contract).
    .on('[class]', {
      element(el) {
        // Early-out once the top-rank family (turnstile) is recorded —
        // nothing outranks it, so the remaining `[class]` work stays bounded.
        if (antiBotWall !== null && wallRank(antiBotWall) === 1) return;
        const cls = (el.getAttribute('class') ?? '').toLowerCase();
        let candidate: string | null = null;
        if (hasClassToken(cls, 'cf-turnstile')) candidate = 'turnstile';
        else if (hasClassToken(cls, 'g-recaptcha')) candidate = 'recaptcha';
        else if (hasClassToken(cls, 'h-captcha')) candidate = 'hcaptcha';
        // Rank-aware upgrade (mirrors the script hook): a widget (ranks 1-3)
        // always beats a cf_challenge (4) recorded earlier in document order,
        // and a higher-rank widget upgrades a lower-rank one.
        if (candidate && wallRank(candidate) < wallRank(antiBotWall)) antiBotWall = candidate;
      },
    })
    .on('form', {
      element(el) {
        pushBounded(formActions, el.getAttribute('action'), MAX_FORM_ACTIONS);
      },
    })
    .on('img', {
      element(el) {
        pushBounded(resourceUrls, el.getAttribute('src'), MAX_RESOURCE_URLS);
      },
    })
    .on('script', {
      element(el) {
        const src = el.getAttribute('src');
        pushBounded(resourceUrls, src, MAX_RESOURCE_URLS);
        // Anti-bot-wall script-host detection (rec 4). Bounded `.includes`
        // on the lowercased `src` only — NO regex. Respect rank precedence:
        // only overwrite when the candidate is strictly higher priority, so
        // a rank-4 cf_challenge script never downgrades a widget family.
        if (src) {
          const s = src.toLowerCase();
          let candidate: string | null = null;
          if (s.includes('challenges.cloudflare.com')) candidate = 'turnstile';
          else if (s.includes('www.google.com/recaptcha') || s.includes('gstatic.com/recaptcha')) candidate = 'recaptcha';
          else if (s.includes('hcaptcha.com')) candidate = 'hcaptcha';
          else if (s.includes('/cdn-cgi/challenge-platform/')) candidate = 'cf_challenge';
          if (candidate && wallRank(candidate) < wallRank(antiBotWall)) antiBotWall = candidate;
        }
      },
      text(t) {
        if (scriptText.length < MAX_SCRIPT_SAMPLE) {
          scriptText = (scriptText + t.text).slice(0, MAX_SCRIPT_SAMPLE);
        }
      },
    })
    .on('link', {
      element(el) {
        const href = el.getAttribute('href');
        const rel = (el.getAttribute('rel') ?? '').toLowerCase();
        // An icon link belongs ONLY to the favicon-clone signal — do NOT
        // also count it as a hotlinked resource, or a single brand favicon
        // would double-fire brand_asset_hotlink + favicon_clone.
        if (href && rel.includes('icon')) {
          pushBounded(iconHrefs, href, MAX_ICON_HREFS);
        } else {
          pushBounded(resourceUrls, href, MAX_RESOURCE_URLS);
        }
      },
    })
    .on('meta', {
      element(el) {
        const equiv = (el.getAttribute('http-equiv') ?? '').toLowerCase();
        if (equiv === 'refresh' && metaRefresh === null) {
          metaRefresh = el.getAttribute('content');
        }
        // Lane 3 §3.1 M1 — <meta name="generator">, first one wins.
        // METADATA ONLY, weight 0: this is a grouping dimension for
        // builder mix, never a scored signal (spec §8 item 5).
        if (metaGenerator === null) {
          const name = (el.getAttribute('name') ?? '').trim().toLowerCase();
          if (name === 'generator') {
            // Charset-restricted at CAPTURE (not at render): see
            // sanitizeGenerator. Bounded to MAX_GENERATOR_LEN by the
            // same walk.
            const content = sanitizeGenerator((el.getAttribute('content') ?? '').trim());
            if (content) metaGenerator = content;
          }
        }
      },
    })
    .on('title', {
      text(t) {
        if (title.length < MAX_TITLE_LEN) title = (title + t.text).slice(0, MAX_TITLE_LEN);
      },
    })
    .on('body', {
      text(t) {
        if (bodyTextSample.length < MAX_BODY_SAMPLE) {
          bodyTextSample = (bodyTextSample + t.text).slice(0, MAX_BODY_SAMPLE);
        }
      },
    });

  // HTMLRewriter transforms a Response stream; we fully drain it here so
  // all handlers fire before we read the accumulators.
  await rewriter.transform(new Response(toArrayBuffer(bytes))).arrayBuffer();

  // Post-transform cf_challenge phrase scan (rec 4, rank 4 — loosest
  // marker, evaluated last). Only fills an empty slot, so a rank-1..3
  // widget family already recorded from HTML is never downgraded.
  // Bounded `.includes` on already-accumulated (bounded) text — NO regex.
  if (antiBotWall === null) {
    const t = title.toLowerCase();
    const b = bodyTextSample.toLowerCase();
    for (const phrase of CHALLENGE_PHRASES) {
      if (t.includes(phrase) || b.includes(phrase)) { antiBotWall = 'cf_challenge'; break; }
    }
  }

  return {
    hasPasswordInput,
    formActions,
    resourceUrls,
    iconHrefs,
    metaRefresh,
    scriptRedirectTargets: extractJsRedirectTargets(scriptText),
    title,
    bodyTextSample,
    antiBotWall,
    // ── Lane 3 (shadow mode) ──────────────────────────────────────
    scriptTextSample: scriptText,
    scriptSinkTargets: extractScriptSinkTargets(scriptText),
    commentSamples,
    metaGenerator,
    svgScriptPayload,
    svgDownloadDisguise,
  };
}

// ── SHA-256 hex (available in both Node + Workers) ─────────────────
/** Copy a Uint8Array into a freshly-sized, ArrayBuffer-backed buffer.
 *  Sidesteps the ArrayBufferLike vs ArrayBuffer generic friction between
 *  the Workers typed-array types and lib.dom's BufferSource/BodyInit. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Orchestrator ───────────────────────────────────────────────────
export interface FetchSuspectOptions {
  /** Absolute epoch-ms deadline for the whole fetch (all hops). */
  deadlineAt?: number;
  /** Injected deps (tests). Real DoH + fetch by default. */
  deps?: FetchDeps;
}

/**
 * Fetch + parse a suspect lookalike page under the SSRF controls above.
 *
 * POPULATION LOCK: `host` MUST be a platform-generated, already-gated
 * lookalike hostname (registered + resolving + has_web, org-monitored
 * brand). NEVER pass raw user input — the guards below reduce but, per
 * the residual-risk note, cannot fully eliminate SSRF, so the input set
 * must stay platform-controlled.
 */
export async function fetchSuspectPage(
  host: string,
  opts: FetchSuspectOptions = {},
): Promise<SuspectPageResult> {
  const deps = opts.deps ?? realDeps;
  const deadlineAt = opts.deadlineAt ?? Date.now() + DEFAULT_DEADLINE_MS;
  const cache = new Map<string, string[]>();

  // Reject obviously-malformed input before building any URL.
  const staticReason = pageFetchHostStaticBlockReason(host);
  if (staticReason) return { ok: false, blocked: true, rejectedReason: `static: ${staticReason}` };

  // Try https first, then http (phishing pages are often plain http).
  // An SSRF/policy BLOCK on either scheme aborts entirely (the host is
  // unsafe regardless of scheme); only a transient miss falls through.
  let follow: FollowResult | null = null;
  for (const scheme of ['https://', 'http://'] as const) {
    let startUrl: URL;
    try {
      startUrl = new URL(`${scheme}${host}`);
    } catch {
      return { ok: false, blocked: true, rejectedReason: 'unparseable_host' };
    }
    const r = await followToFinalResponse(startUrl, deps, deadlineAt, cache);
    if (r.ok) { follow = r; break; }
    if (r.blocked) return { ok: false, blocked: true, rejectedReason: r.reason };
    follow = r; // remember last transient reason; maybe next scheme works
  }

  if (!follow || !follow.ok) {
    return { ok: false, blocked: false, rejectedReason: follow?.reason ?? 'unreachable' };
  }

  const response = follow.response;
  const httpStatus = response.status;

  const limits = await enforceResponseLimits(response, MAX_BYTES);
  if (!limits.ok) {
    return { ok: false, httpStatus, contentType: limits.contentType, rejectedReason: limits.reason };
  }

  const contentHash = await sha256Hex(limits.bytes);
  const signals = await parseSuspectHtml(limits.bytes);

  // Anti-bot-wall cf_challenge header tier (rec 4). The `cf-mitigated`
  // header can only FILL an empty slot — a widget family already recorded
  // from HTML wins. Bounded `.includes`, no regex.
  const mit = (response.headers.get('cf-mitigated') ?? '').toLowerCase();
  if (signals.antiBotWall === null && mit.includes('challenge')) {
    signals.antiBotWall = 'cf_challenge';
  }

  return {
    ok: true,
    httpStatus,
    contentType: limits.contentType,
    truncated: limits.truncated,
    contentHash,
    cfMitigated: mit || undefined,
    signals,
  };
}

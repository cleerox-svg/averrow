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

  const pushBounded = (arr: string[], val: string | null, max: number) => {
    if (val && arr.length < max) arr.push(val);
  };

  const rewriter = new HTMLRewriter()
    .on('input', {
      element(el) {
        if (hasPasswordInput) return;
        const type = el.getAttribute('type');
        if (type && type.toLowerCase() === 'password') hasPasswordInput = true;
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
        pushBounded(resourceUrls, el.getAttribute('src'), MAX_RESOURCE_URLS);
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
        pushBounded(resourceUrls, href, MAX_RESOURCE_URLS);
        const rel = (el.getAttribute('rel') ?? '').toLowerCase();
        if (href && rel.includes('icon')) pushBounded(iconHrefs, href, MAX_ICON_HREFS);
      },
    })
    .on('meta', {
      element(el) {
        const equiv = (el.getAttribute('http-equiv') ?? '').toLowerCase();
        if (equiv === 'refresh' && metaRefresh === null) {
          metaRefresh = el.getAttribute('content');
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

  return {
    hasPasswordInput,
    formActions,
    resourceUrls,
    iconHrefs,
    metaRefresh,
    scriptRedirectTargets: extractJsRedirectTargets(scriptText),
    title,
    bodyTextSample,
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

  return {
    ok: true,
    httpStatus,
    contentType: limits.contentType,
    truncated: limits.truncated,
    contentHash,
    signals,
  };
}

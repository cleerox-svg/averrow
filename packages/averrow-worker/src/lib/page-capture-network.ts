// Averrow — network evidence for a page capture (migration 0335).
//
// What the Browser Rendering driver (lib/page-capture-browser.ts) records
// during ONE capture, besides the screenshots and the rendered DOM, so the
// IOK kit rules (lib/iok-engine.ts) can run on the real artifacts:
//
//   main_response  the final main-document response: status, URL, headers
//                  (IOK form `Canonical-Name: value`) and the body AS SERVED
//                  (before any script ran) — IOK's `html` and `headers`
//   requests       every request the page made (method, resource type, URL),
//                  logged when the browser issued it — IOK's `requests`
//   cookies        cookies the page's own origin holds at the end of the
//                  capture (name, value, domain, path, flags) — IOK's `cookies`
//
// Everything here is attacker-controlled, so every list and string is
// size-capped and the collector NEVER throws into the capture: a failure
// becomes a flag (`status`), and the capture is stored without the artifact.
// The collector is passive: it reads events the browser already produces and
// the response body the browser already downloaded. It issues no request and
// follows nothing.
//
// STORAGE / EXPOSURE. One compact JSON object per capture in the private R2
// bucket (`<prefix>/network.json`), SHA-256 in `page_captures.net_evidence_sha256`
// and in meta.json, expiring with the other evidence (180-day sweep). Header
// and cookie values can carry tracking identifiers, so the object has NO
// reader route: no staff download, no tenant path, never in D1, logs or
// agent_outputs (only counters and the status flag reach D1).
//
// This module does not import lib/page-capture.ts (which imports it).

/** Same cap as the stored rendered HTML (CAPTURE_HTML_MAX_BYTES; a test pins equality). */
export const NET_MAX_BODY_BYTES = 2 * 1024 * 1024;
/** The body is read over CDP (`Network.getResponseBody`: the WHOLE decoded
 *  body, base64, in one message) only when its real size is known to be at
 *  most this — there is no value in buffering more than is stored. */
export const NET_MAX_BODY_FETCH_BYTES = NET_MAX_BODY_BYTES;
/** Distinct request ids the body-size tracker follows (the main document is first). */
export const NET_SIZE_TRACK_IDS = 500;
/** Time allowed to open the CDP session and clear the cookie jar. */
export const NET_COOKIE_CLEAR_TIMEOUT_MS = 1_000;
export const NET_MAX_REQUESTS = 300;
export const NET_MAX_URL_LENGTH = 2048;
export const NET_MAX_HEADERS = 100;
export const NET_MAX_HEADER_NAME = 128;
export const NET_MAX_HEADER_VALUE = 4096;
export const NET_MAX_COOKIES = 50;
export const NET_MAX_COOKIE_NAME = 128;
export const NET_MAX_COOKIE_VALUE = 512;
export const NET_MAX_COOKIE_ATTR = 256;
/** Largest serialized evidence object; over it the body is dropped first. */
export const NET_MAX_OBJECT_BYTES = 6 * 1024 * 1024;
/** Time allowed to read the body + cookies after the page settled. */
export const NET_FINISH_TIMEOUT_MS = 3_000;
export const NET_EVIDENCE_VERSION = 1;

export type NetworkStatus = "complete" | "partial" | "failed";

export interface NetworkRequestEntry {
  /** HTTP method. */
  m: string;
  /** Resource type as the browser names it (document, script, xhr, …). */
  t: string;
  /** URL, ≤ NET_MAX_URL_LENGTH. */
  u: string;
  /** 1 = our interception aborted it (guard, host cap, non-http, media/font). */
  b?: 1;
}

export interface NetworkCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}

export type BodySkipReason = "too_large" | "redirect" | "timeout" | "unavailable" | "no_response";

export interface NetworkMainResponse {
  url: string;
  status: number;
  /** `Canonical-Name: value`, one entry per header value, sorted. */
  headers: string[];
  /** Every header was kept (count and value-length caps not hit). */
  headers_complete: boolean;
  /** The body as served, decoded with the response's charset (UTF-8 when none). */
  body: string | null;
  body_bytes: number;
  /** The body was cut at NET_MAX_BODY_BYTES. */
  body_truncated: boolean;
  body_skipped: BodySkipReason | null;
  /** Charset label used to decode (null = UTF-8 assumed, no label). */
  body_charset: string | null;
  /** The decoded text is the bytes IOK would compare: UTF-8 that decoded
   *  cleanly, or pure ASCII. false = lossy / non-UTF-8 with non-ASCII bytes /
   *  unsupported label — `html` is then a subset, never exact. */
  body_text_exact: boolean;
  /** This response is the document the page ended on (same URL as
   *  `page.url()` at the end, fragment ignored). false = a JS / meta-refresh
   *  navigation followed: headers and body belong to an EARLIER document. */
  matches_final: boolean;
}

export interface NetworkAborts {
  /** Refused by the SSRF / navigation guard. */
  guard: number;
  /** New host past CAPTURE_MAX_HOSTS_PER_PAGE. */
  host_cap: number;
  /** Non-http(s) sub-resource. */
  scheme: number;
  /** Media / font (never fetched; they spawn no further requests). */
  resource: number;
}

/** Sanitised, capped evidence of one capture (the R2 object minus its envelope). */
export interface NetworkEvidence {
  status: NetworkStatus;
  main_response: NetworkMainResponse | null;
  requests: NetworkRequestEntry[];
  /** Requests seen (before dedup and the cap). */
  requests_total: number;
  /** Distinct requests not stored because of the cap. */
  requests_dropped: number;
  /** The log can be treated as every request the page made: no cap hit, no
   *  guard / host-cap / scheme abort (those cut off what a blocked response
   *  would have requested next), listener never failed. */
  requests_complete: boolean;
  aborted: NetworkAborts;
  /** null = cookies could not be read. */
  cookies: NetworkCookie[] | null;
  cookies_dropped: number;
  /** A cookie value was cut at NET_MAX_COOKIE_VALUE. */
  cookies_clipped: boolean;
}

// ─── Small helpers ───────────────────────────────────────────────────

function clipStr(s: unknown, n: number): string {
  const v = typeof s === "string" ? s : "";
  return v.length > n ? v.slice(0, n) : v;
}

const TOKEN_CHARS = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** Go's `http.CanonicalHeaderKey` (what IOK renders header names with):
 *  first letter and each letter after a hyphen upper-cased, the rest lower;
 *  a name with a character outside the token set is returned unchanged. */
export function canonicalHeaderKey(name: string): string {
  if (!TOKEN_CHARS.test(name)) return name;
  let up = true;
  let out = "";
  for (const ch of name) {
    out += up ? ch.toUpperCase() : ch.toLowerCase();
    up = ch === "-";
  }
  return out;
}

/** CDP joins repeated headers with "\n"; IOK has one entry per value. */
export function headerEntries(headers: Record<string, unknown>): { entries: string[]; complete: boolean } {
  const out: string[] = [];
  let complete = true;
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== "string") {
      complete = false;
      continue;
    }
    if (rawName.length > NET_MAX_HEADER_NAME) {
      complete = false;
      continue;
    }
    const name = canonicalHeaderKey(rawName);
    for (const v of rawValue.split("\n")) {
      if (out.length >= NET_MAX_HEADERS) return { entries: out.sort(), complete: false };
      let value = v;
      if (value.length > NET_MAX_HEADER_VALUE) {
        value = value.slice(0, NET_MAX_HEADER_VALUE);
        complete = false;
      }
      out.push(`${name}: ${value}`);
    }
  }
  return { entries: out.sort(), complete };
}

/** `name=value`, IOK's cookie form. */
export function cookieEntry(c: Pick<NetworkCookie, "name" | "value">): string {
  return `${c.name}=${c.value}`;
}

function hostOnly(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** RFC 6265 domain match of a cookie's Domain attribute against a host. */
export function cookieDomainMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.toLowerCase().replace(/^\./, "");
  const h = host.toLowerCase();
  return d.length > 0 && h.length > 0 && (h === d || h.endsWith(`.${d}`));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  // A late rejection after the timeout wins must not surface.
  p.catch(() => undefined);
  return Promise.race([p, t]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

// ─── Collector ───────────────────────────────────────────────────────

/** What the driver hands over for the final main-document response
 *  (structurally an `@cloudflare/puppeteer` HTTPResponse). */
export interface MainResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  buffer(): Promise<Uint8Array>;
}

/** What is known about the DECODED size of the main document's body. */
export interface BodySizeProbe {
  /** Decoded bytes seen so far exceeded NET_MAX_BODY_FETCH_BYTES. */
  exceeded: boolean;
  /** The browser reported the request finished (the total is final). */
  finished: boolean;
  /** Decoded bytes seen; null = no data event for this request. */
  bytes: number | null;
}

/**
 * Follows `Network.dataReceived` (decoded chunk length) and
 * `Network.loadingFinished` on a CDP session, per request id, so the driver
 * knows the real decoded size of the main document BEFORE it asks for the
 * body. `Content-Length` cannot tell: it is the compressed size (or absent
 * for chunked / endless responses). Bounded: the first NET_SIZE_TRACK_IDS ids.
 */
export class BodySizeTracker {
  private readonly bytes = new Map<string, number>();
  private readonly finished = new Set<string>();

  noteData(requestId: unknown, dataLength: unknown): void {
    try {
      if (typeof requestId !== "string" || typeof dataLength !== "number" || !(dataLength >= 0)) return;
      const have = this.bytes.get(requestId);
      if (have === undefined) {
        if (this.bytes.size >= NET_SIZE_TRACK_IDS) return;
        this.bytes.set(requestId, dataLength);
      } else {
        this.bytes.set(requestId, have + dataLength);
      }
    } catch { /* evidence only */ }
  }

  noteFinished(requestId: unknown): void {
    try {
      if (typeof requestId === "string" && this.finished.size < NET_SIZE_TRACK_IDS * 2) this.finished.add(requestId);
    } catch { /* evidence only */ }
  }

  probe(requestId: string): BodySizeProbe {
    const b = this.bytes.get(requestId);
    return { exceeded: b !== undefined && b > NET_MAX_BODY_FETCH_BYTES, finished: this.finished.has(requestId), bytes: b ?? null };
  }
}

export type BodyVerdict = "fetch" | "too_large" | "unknown";

/**
 * May the body be read over CDP? Only when its decoded size is KNOWN and
 * small. 1) The tracker's decoded total, once the request finished.
 * 2) Without it: `Content-Length` present, within the cap, no
 * `Content-Encoding` (so it is the decoded size) and not chunked. Anything
 * else — chunked, endless, gzip / br (a decompression bomb) — is never read.
 */
export function bodyFetchVerdict(headers: Record<string, string>, probe: BodySizeProbe | null): BodyVerdict {
  if (probe?.exceeded) return "too_large";
  if (probe && probe.finished && probe.bytes !== null) {
    return probe.bytes <= NET_MAX_BODY_FETCH_BYTES ? "fetch" : "too_large";
  }
  const h = (n: string): string => String(headers[n] ?? "").trim().toLowerCase();
  const encoding = h("content-encoding");
  if (encoding !== "" && encoding !== "identity") return "unknown";
  if (h("transfer-encoding").includes("chunked")) return "unknown";
  const len = h("content-length");
  if (!/^\d{1,12}$/.test(len)) return "unknown";
  return Number(len) <= NET_MAX_BODY_FETCH_BYTES ? "fetch" : "too_large";
}

const CHARSET_RE = /charset\s*=\s*"?([A-Za-z0-9_.:-]{1,40})"?/i;

/** Decode a body with the response's charset. Pure. */
export function decodeBody(bytes: Uint8Array, contentType: string | undefined): { text: string; charset: string | null; exact: boolean } {
  const label = contentType ? CHARSET_RE.exec(contentType)?.[1]?.toLowerCase() ?? null : null;
  const ascii = bytes.every((b) => b < 0x80);
  if (label && label !== "utf-8" && label !== "utf8") {
    try {
      const text = new TextDecoder(label, { fatal: false }).decode(bytes);
      // Decoded per the page's charset; IOK compares the raw bytes, so only
      // pure ASCII is the same text either way.
      return { text, charset: label, exact: ascii };
    } catch {
      return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), charset: label, exact: false };
    }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), charset: label, exact: true };
  } catch {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), charset: label, exact: false };
  }
}

/** URL identity for "same document": fragment ignored. */
function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = "";
    y.hash = "";
    return x.href === y.href;
  } catch {
    return false;
  }
}

export interface FinishOptions {
  /** Decoded-size knowledge for the main document (see BodySizeTracker). */
  probe?: BodySizeProbe | null;
  /** false = the cookie jar could not be cleared at the start of this
   *  capture: its cookies are not attributable to this page and are dropped. */
  cookiesTrusted?: boolean;
}

/** What the driver hands over to read cookies (a `Page`). */
export interface CookiePageLike {
  cookies(): Promise<Array<{ name?: unknown; value?: unknown; domain?: unknown; path?: unknown; secure?: unknown; httpOnly?: unknown }>>;
  url(): string;
}

export type AbortKind = keyof NetworkAborts;

export class NetworkCollector {
  private frozen = false;
  private listenerFailed = false;
  private readonly requests: NetworkRequestEntry[] = [];
  private readonly byKey = new Map<string, NetworkRequestEntry>();
  private total = 0;
  private dropped = 0;
  private readonly aborts: NetworkAborts = { guard: 0, host_cap: 0, scheme: 0, resource: 0 };

  /** Log one request as the browser issues it. Never throws. */
  noteRequest(method: unknown, url: unknown, resourceType: unknown): void {
    if (this.frozen) return;
    try {
      if (typeof url !== "string" || url.length === 0) return;
      this.total++;
      const m = clipStr(method, 16).toUpperCase() || "GET";
      const t = clipStr(resourceType, 32).toLowerCase() || "other";
      const u = clipStr(url, NET_MAX_URL_LENGTH);
      const key = `${m} ${u}`;
      if (this.byKey.has(key)) return;
      if (this.requests.length >= NET_MAX_REQUESTS) {
        this.dropped++;
        return;
      }
      const entry: NetworkRequestEntry = { m, t, u };
      this.requests.push(entry);
      this.byKey.set(key, entry);
    } catch {
      this.listenerFailed = true;
    }
  }

  /** Our interception aborted a request. Never throws. */
  noteAbort(kind: AbortKind, method: unknown, url: unknown): void {
    if (this.frozen) return;
    try {
      this.aborts[kind]++;
      if (typeof url === "string") {
        const entry = this.byKey.get(`${clipStr(method, 16).toUpperCase() || "GET"} ${clipStr(url, NET_MAX_URL_LENGTH)}`);
        if (entry) entry.b = 1;
      }
    } catch {
      this.listenerFailed = true;
    }
  }

  /** Stop recording (the mobile reload and later events are not evidence). */
  freeze(): void {
    this.frozen = true;
  }

  /**
   * Read the main response (headers + body) and the cookies, each bounded,
   * and return the sanitised evidence. Never throws: a part that cannot be
   * read is recorded as missing and the status says `partial` / `failed`.
   */
  async finish(
    response: MainResponseLike | null,
    page: CookiePageLike | null,
    timeoutMs: number = NET_FINISH_TIMEOUT_MS,
    opts: FinishOptions = {},
  ): Promise<NetworkEvidence> {
    this.frozen = true;
    const deadline = Date.now() + Math.max(250, timeoutMs);
    const left = (): number => Math.max(100, deadline - Date.now());
    const [main, cookies] = await Promise.all([
      this.readMain(response, page, opts.probe ?? null, left),
      opts.cookiesTrusted === false ? Promise.resolve(null) : this.readCookies(page, left),
    ]);
    return this.assemble(main, cookies);
  }

  private async readMain(
    response: MainResponseLike | null,
    page: CookiePageLike | null,
    probe: BodySizeProbe | null,
    left: () => number,
  ): Promise<NetworkMainResponse | null> {
    if (!response) return null;
    try {
      const status = Number(response.status());
      const url = clipStr(response.url(), NET_MAX_URL_LENGTH);
      const rawHeaders = response.headers() ?? {};
      const hdr = headerEntries(rawHeaders);
      let finalUrl = "";
      try { finalUrl = page ? page.url() : ""; } catch { finalUrl = ""; }
      const out: NetworkMainResponse = {
        url,
        status: Number.isFinite(status) ? status : 0,
        headers: hdr.entries,
        headers_complete: hdr.complete,
        body: null,
        body_bytes: 0,
        body_truncated: false,
        body_skipped: null,
        body_charset: null,
        body_text_exact: false,
        matches_final: finalUrl !== "" && sameDocument(url, finalUrl),
      };
      if (out.status >= 300 && out.status < 400) {
        out.body_skipped = "redirect";
        return out;
      }
      // Never ask the browser for a body whose decoded size is not known to be small.
      const verdict = bodyFetchVerdict(rawHeaders, probe);
      if (verdict !== "fetch") {
        out.body_skipped = verdict === "too_large" ? "too_large" : "unavailable";
        return out;
      }
      try {
        const got = await withTimeout(response.buffer(), left());
        if (got === "timeout") {
          // The reply may still arrive; it is bounded by the size check above.
          out.body_skipped = "timeout";
          return out;
        }
        const all = got instanceof Uint8Array ? got : new Uint8Array(0);
        const bytes = all.byteLength > NET_MAX_BODY_BYTES ? all.subarray(0, NET_MAX_BODY_BYTES) : all;
        out.body_truncated = all.byteLength > NET_MAX_BODY_BYTES;
        out.body_bytes = bytes.byteLength;
        const dec = decodeBody(bytes, String(rawHeaders["content-type"] ?? ""));
        out.body = dec.text;
        out.body_charset = dec.charset;
        out.body_text_exact = dec.exact;
      } catch {
        // Evicted, preflight, page closed: the headers above are still real.
        out.body_skipped = "unavailable";
      }
      return out;
    } catch {
      return null;
    }
  }

  private async readCookies(page: CookiePageLike | null, left: () => number): Promise<{ list: NetworkCookie[]; dropped: number; clipped: boolean } | null> {
    if (!page) return null;
    try {
      const got = await withTimeout(page.cookies(), left());
      if (got === "timeout" || !Array.isArray(got)) return null;
      const host = hostOnly(page.url());
      // No attributable origin → no cookies (never guess whose they are).
      if (!host) return null;
      const list: NetworkCookie[] = [];
      let dropped = 0;
      let clipped = false;
      for (const c of got) {
        if (typeof c?.name !== "string" || c.name.length === 0 || c.name.length > NET_MAX_COOKIE_NAME) {
          dropped++;
          continue;
        }
        const domain = clipStr(c.domain, NET_MAX_COOKIE_ATTR);
        // Own origin only: a cookie whose domain does not cover the page's host is not stored.
        if (!cookieDomainMatches(domain, host)) {
          dropped++;
          continue;
        }
        if (list.length >= NET_MAX_COOKIES) {
          dropped++;
          continue;
        }
        const rawValue = typeof c.value === "string" ? c.value : "";
        if (rawValue.length > NET_MAX_COOKIE_VALUE) clipped = true;
        list.push({
          name: c.name,
          value: clipStr(rawValue, NET_MAX_COOKIE_VALUE),
          domain,
          path: clipStr(c.path, NET_MAX_COOKIE_ATTR),
          secure: c.secure === true,
          httpOnly: c.httpOnly === true,
        });
      }
      return { list, dropped, clipped };
    } catch {
      return null;
    }
  }

  private assemble(
    main: NetworkMainResponse | null,
    cookies: { list: NetworkCookie[]; dropped: number; clipped: boolean } | null,
  ): NetworkEvidence {
    const guardAborts = this.aborts.guard + this.aborts.host_cap + this.aborts.scheme;
    const requestsComplete = !this.listenerFailed && this.dropped === 0 && guardAborts === 0 && this.requests.length > 0;
    const usable = main !== null && main.status > 0 ? main : null;
    const gotAnything = this.requests.length > 0 || usable !== null || cookies !== null;
    const full = usable !== null && usable.body !== null && cookies !== null && this.requests.length > 0 && !this.listenerFailed;
    return {
      status: !gotAnything ? "failed" : full ? "complete" : "partial",
      main_response: usable,
      requests: this.requests,
      requests_total: this.total,
      requests_dropped: this.dropped,
      requests_complete: requestsComplete,
      aborted: { ...this.aborts },
      cookies: cookies ? cookies.list : null,
      cookies_dropped: cookies ? cookies.dropped : 0,
      cookies_clipped: cookies ? cookies.clipped : false,
    };
  }
}

// ─── Evidence object + IOK input ─────────────────────────────────────

export interface NetworkEvidenceSummary {
  status: NetworkStatus;
  requests: number;
  cookies: number;
  headers: number;
  /** Raw response body bytes stored (0 = none). */
  body_bytes: number;
}

export function summarizeNetworkEvidence(ev: NetworkEvidence): NetworkEvidenceSummary {
  return {
    status: ev.status,
    requests: ev.requests.length,
    cookies: ev.cookies?.length ?? 0,
    headers: ev.main_response?.headers.length ?? 0,
    body_bytes: ev.main_response?.body != null ? ev.main_response.body_bytes : 0,
  };
}

/** Serialise the R2 object. Over NET_MAX_OBJECT_BYTES the body (the one
 *  large part) is dropped and the evidence marked partial. Pure. */
export function serializeNetworkEvidence(
  ev: NetworkEvidence,
  envelope: { capture_id: string; captured_at: string },
): { bytes: Uint8Array; evidence: NetworkEvidence } {
  const enc = (e: NetworkEvidence): Uint8Array =>
    new TextEncoder().encode(JSON.stringify({ version: NET_EVIDENCE_VERSION, ...envelope, ...e }));
  let bytes = enc(ev);
  let out = ev;
  if (bytes.byteLength > NET_MAX_OBJECT_BYTES && ev.main_response?.body) {
    out = { ...ev, status: "partial", main_response: { ...ev.main_response, body: null, body_bytes: 0, body_skipped: "too_large" } };
    bytes = enc(out);
  }
  return { bytes, evidence: out };
}

/** What lib/iok-engine.ts needs from the evidence (plain data, no module link). */
export interface IokNetworkInput {
  /** Raw main response body; null = not obtained. */
  rawHtml: string | null;
  rawHtmlTruncated: boolean;
  /** `Name: value` entries; null = headers not obtained. */
  headers: string[] | null;
  headersComplete: boolean;
  /** `name=value`; null = cookies not read. */
  cookies: string[] | null;
  /** Request URLs; null = no log. */
  requests: string[] | null;
  requestsComplete: boolean;
  /** The decoded body is the text IOK would compare (clean UTF-8 / ASCII). */
  rawHtmlTextExact: boolean;
  /** Headers / body belong to the document the page ended on. */
  mainMatchesFinal: boolean;
}

export function toIokNetworkInput(ev: NetworkEvidence): IokNetworkInput {
  const m = ev.main_response;
  const body = m ? m.body : null;
  return {
    rawHtml: body,
    rawHtmlTruncated: m !== null && body !== null ? m.body_truncated : false,
    rawHtmlTextExact: m !== null ? m.body_text_exact : false,
    mainMatchesFinal: m !== null ? m.matches_final : false,
    headers: m ? m.headers : null,
    headersComplete: m ? m.headers_complete : false,
    cookies: ev.cookies ? ev.cookies.map(cookieEntry) : null,
    requests: ev.requests.length > 0 ? ev.requests.map((r) => r.u) : null,
    requestsComplete: ev.requests_complete,
  };
}

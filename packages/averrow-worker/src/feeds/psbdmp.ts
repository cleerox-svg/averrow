/**
 * PSBDMP — Pastebin archive search client.
 *
 * PSBDMP (psbdmp.ws) indexes public pastes from Pastebin-like services
 * and exposes a free keyword search API. No authentication, generous
 * rate limits. Cloudflare caches responses at the edge via cf.cacheTtl.
 *
 * Failure mode is "return empty" rather than "throw" for the search
 * endpoint — PSBDMP has a history of intermittent outages and we want
 * the scanner to keep running against other sources if this one blips.
 * The body-fetch endpoint throws so the scanner can distinguish
 * "no content available" from "search returned zero hits".
 *
 * This client intentionally returns a provider-neutral `PasteMention`
 * shape so alternative paste search providers (Pastebin Pro, Flare,
 * SerpAPI paste dorks) can swap in without touching the scanner.
 */

import { logger } from "../lib/logger";

// ─── Types ──────────────────────────────────────────────────────

export interface PasteMention {
  paste_id: string;
  url: string;                     // canonical pastebin URL
  archive_url: string;             // psbdmp mirror URL
  posted_at: string | null;        // ISO8601 when known
  length_bytes: number | null;
  content: string | null;          // populated only after fetchPasteContent()
}

interface PSBDMPSearchItem {
  id?: string;
  time?: string | number;
  length?: number;
  pastebinUrl?: string;
  url?: string;
}

interface PSBDMPSearchResponse {
  // PSBDMP has used multiple shapes over the years — be tolerant.
  data?: PSBDMPSearchItem[];
  count?: number;
  // Older responses were a bare array.
}

// ─── Internal helpers ───────────────────────────────────────────

const PSBDMP_BASE = "https://psbdmp.ws/api";
const MAX_RESULTS = 50;
const DEFAULT_CACHE_TTL = 600; // 10 minutes

function normalizePosted(raw: string | number | undefined): string | null {
  if (raw == null) return null;
  // API sometimes returns unix seconds, sometimes ISO strings.
  if (typeof raw === "number") {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalize(item: PSBDMPSearchItem): PasteMention | null {
  const pasteId = item.id ? String(item.id) : null;
  if (!pasteId) return null;

  const pastebinUrl = item.pastebinUrl ?? item.url ?? `https://pastebin.com/${pasteId}`;
  return {
    paste_id: pasteId,
    url: pastebinUrl,
    archive_url: `${PSBDMP_BASE}/dump/get/${pasteId}`,
    posted_at: normalizePosted(item.time),
    length_bytes: typeof item.length === "number" ? item.length : null,
    content: null,
  };
}

// ─── Public API ─────────────────────────────────────────────────

export interface PasteSearchOptions {
  /** Max results to return. PSBDMP's own cap is modest; we default to 50. */
  limit?: number;
  /** Override edge cache TTL (seconds). Pass 0 to disable caching. */
  cacheTtl?: number;
}

/**
 * Search the PSBDMP archive for a keyword. Returns up to `limit` hits
 * without their body content. Returns an empty array on any upstream
 * failure (logged) — caller should proceed against other sources.
 */
export async function searchPastes(
  term: string,
  opts: PasteSearchOptions = {},
): Promise<PasteMention[]> {
  const limit = Math.max(1, Math.min(MAX_RESULTS, opts.limit ?? MAX_RESULTS));
  const cacheTtl = opts.cacheTtl ?? DEFAULT_CACHE_TTL;

  // PSBDMP's search path is /search/<term>. The term is URL-encoded; we
  // trim to a reasonable length to avoid pathological queries.
  const trimmed = term.trim().slice(0, 200);
  if (!trimmed) return [];

  const url = `${PSBDMP_BASE}/search/${encodeURIComponent(trimmed)}`;

  let res: Response;
  try {
    const init: RequestInit = {
      headers: { Accept: "application/json", "User-Agent": "Averrow/1.0 (+https://averrow.com)" },
      signal: AbortSignal.timeout(30_000),
    };
    if (cacheTtl > 0) {
      (init as RequestInit & { cf?: unknown }).cf = { cacheTtl, cacheEverything: true };
    }
    res = await fetch(url, init);
  } catch (err) {
    logger.warn("psbdmp_search_network_error", {
      term: trimmed,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  if (!res.ok) {
    logger.warn("psbdmp_search_http_error", {
      term: trimmed,
      status: res.status,
    });
    return [];
  }

  let body: PSBDMPSearchResponse | PSBDMPSearchItem[];
  try {
    body = await res.json() as PSBDMPSearchResponse | PSBDMPSearchItem[];
  } catch (err) {
    logger.warn("psbdmp_search_parse_error", {
      term: trimmed,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const items: PSBDMPSearchItem[] = Array.isArray(body)
    ? body
    : Array.isArray(body.data) ? body.data : [];

  return items
    .slice(0, limit)
    .map(normalize)
    .filter((m): m is PasteMention => m !== null);
}

/**
 * Fetch a single paste's full content by ID. Throws on upstream
 * failure so the caller can distinguish transient errors from content
 * that genuinely returned empty. Content is truncated at the caller's
 * discretion.
 */
export async function fetchPasteContent(pasteId: string): Promise<string> {
  const url = `${PSBDMP_BASE}/dump/get/${encodeURIComponent(pasteId)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000), headers: { Accept: "text/plain, application/json", "User-Agent": "Averrow/1.0 (+https://averrow.com)" },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) {
    throw new Error(`PSBDMP fetch failed for ${pasteId}: ${res.status} ${res.statusText}`);
  }
  // PSBDMP occasionally wraps content in `{data: "..."}` and other times
  // returns the raw text. Handle both.
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { data?: string };
    if (parsed && typeof parsed.data === "string") return parsed.data;
  } catch {
    // Not JSON; treat as raw paste content.
  }
  return text;
}

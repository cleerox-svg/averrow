// TAXII 2.1 client — minimal, just enough to pull STIX bundles from a
// known (server, collection) pair.
//
// We intentionally skip the full discovery flow:
//   GET /taxii/            → API roots
//   GET <api-root>/        → collections
//   GET <api-root>/collections/<id>/objects/?added_after=...
//
// In our model each TAXII collection is configured per-row in
// feed_configs (taxii_root_url, taxii_collection_id, etc.), so we
// jump straight to the objects endpoint and trust the operator to
// have populated the root URL correctly. Discovery is something
// the operator does once when setting up a new feed, not something
// the runtime needs to repeat hourly.
//
// Spec: https://docs.oasis-open.org/cti/taxii/v2.1/cs01/taxii-v2.1-cs01.html
//
// Tested via test/taxii-client.test.ts.

import type { StixBundle } from "./stix-parser";

export type TaxiiAuth =
  | { type: "none" }
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string };

export interface TaxiiFetchOptions {
  /** TAXII API root URL — must end with a slash (RFC-style URI). */
  rootUrl: string;
  /** UUID/string identifier of the collection to pull. */
  collectionId: string;
  /** Auth credential. `none` for public servers. */
  auth: TaxiiAuth;
  /** STIX `added_after` cursor — ISO-8601 string. Omit to pull from epoch. */
  addedAfter?: string | null;
  /** Server-side page size. TAXII servers cap this; 500 is a safe default. */
  limit?: number;
  /** Per-request timeout. Default 30s — TAXII responses can be large. */
  timeoutMs?: number;
}

export interface TaxiiFetchResult {
  /** Parsed bundle from the response body. Empty objects[] when no new content. */
  bundle: StixBundle;
  /** X-TAXII-Date-Added-Last response header — the cursor to use on the next call. */
  nextCursor: string | null;
  /** X-TAXII-Date-Added-First — useful for logging the window we pulled. */
  firstCursor: string | null;
  /** True when the server signals more pages via `more: true` envelope OR a next cursor. */
  hasMore: boolean;
  /** HTTP status — exposed for callers that want to log non-2xx outcomes. */
  status: number;
}

const TAXII_MEDIA_TYPE = "application/taxii+json;version=2.1";
const TAXII_STIX_MEDIA_TYPE = "application/stix+json;version=2.1";

/**
 * Build the GET URL for a TAXII 2.1 objects-in-a-collection request.
 *
 * Exported for testability — callers don't normally need this.
 */
export function buildObjectsUrl(
  rootUrl: string,
  collectionId: string,
  addedAfter?: string | null,
  limit?: number,
): string {
  // Normalize to a trailing slash for safe path joining (TAXII URIs
  // are spec'd to be slash-terminated).
  const root = rootUrl.endsWith("/") ? rootUrl : `${rootUrl}/`;
  const url = new URL(`collections/${encodeURIComponent(collectionId)}/objects/`, root);
  if (addedAfter) url.searchParams.set("added_after", addedAfter);
  if (limit && limit > 0) url.searchParams.set("limit", String(limit));
  return url.toString();
}

function authHeader(auth: TaxiiAuth): Record<string, string> {
  switch (auth.type) {
    case "none":
      return {};
    case "basic": {
      // RFC 7617 — `Authorization: Basic <base64(user:pass)>`.
      const encoded = btoa(`${auth.username}:${auth.password}`);
      return { Authorization: `Basic ${encoded}` };
    }
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
  }
}

/**
 * Fetch one page of STIX objects from a TAXII 2.1 collection.
 *
 * The TAXII envelope returned by the server wraps the STIX bundle:
 *
 *   { "more": false, "objects": [ {…stix…}, {…stix…} ] }
 *
 * We unwrap it into a synthetic `bundle` with the same `objects[]`
 * so downstream code (`iterParsedIndicators`) can stay agnostic of
 * the envelope format.
 */
export async function fetchTaxiiObjects(
  opts: TaxiiFetchOptions,
): Promise<TaxiiFetchResult> {
  const {
    rootUrl,
    collectionId,
    auth,
    addedAfter,
    limit = 500,
    timeoutMs = 30_000,
  } = opts;

  const url = buildObjectsUrl(rootUrl, collectionId, addedAfter, limit);

  const headers: Record<string, string> = {
    Accept: TAXII_MEDIA_TYPE,
    ...authHeader(auth),
  };

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // 304 — no new content since added_after. Treat as an empty bundle.
  if (res.status === 304) {
    return {
      bundle: { type: "bundle", objects: [] },
      nextCursor: addedAfter ?? null,
      firstCursor: null,
      hasMore: false,
      status: 304,
    };
  }

  if (!res.ok) {
    throw new Error(`TAXII HTTP ${res.status} from ${url}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  // TAXII servers MAY return either application/taxii+json (envelope)
  // or application/stix+json (raw STIX bundle). Tolerate both.
  if (
    !contentType.includes("taxii+json") &&
    !contentType.includes("stix+json") &&
    !contentType.includes("application/json")
  ) {
    throw new Error(`TAXII: unexpected content-type "${contentType}" from ${url}`);
  }

  // Parse the body. TAXII envelope is `{ more, next, objects }`; STIX
  // bundle is `{ type: "bundle", id, objects }`. Convert to the
  // bundle shape for downstream parsers.
  const body = (await res.json()) as
    | { more?: boolean; next?: string; objects?: unknown[] }
    | StixBundle;

  let objects: unknown[];
  if (Array.isArray((body as { objects?: unknown }).objects)) {
    objects = (body as { objects: unknown[] }).objects;
  } else {
    objects = [];
  }

  const bundle: StixBundle = {
    type: "bundle",
    objects: objects as Array<{ type: string; [k: string]: unknown }>,
  };

  const nextCursor = res.headers.get("x-taxii-date-added-last");
  const firstCursor = res.headers.get("x-taxii-date-added-first");
  const moreFlag = (body as { more?: boolean }).more === true;

  return {
    bundle,
    nextCursor,
    firstCursor,
    hasMore: moreFlag || (nextCursor !== null && nextCursor !== addedAfter),
    status: res.status,
  };
}

void TAXII_STIX_MEDIA_TYPE; // reserved for future content-negotiation tightening

/**
 * iTunes Search API client — public, no auth required.
 * Docs: https://performance-partners.apple.com/search-api
 *
 * Two entry points:
 *   searchITunesApps(term)   — keyword search across the iOS App Store
 *   lookupITunesByBundle(id) — exact lookup by CFBundleIdentifier
 *
 * Both return a normalized `ITunesApp[]`. Failures are thrown — caller decides
 * whether to swallow or surface.
 */

const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const ITUNES_LOOKUP_URL = "https://itunes.apple.com/lookup";

export interface ITunesApp {
  app_id: string;           // trackId
  bundle_id: string | null; // CFBundleIdentifier
  app_name: string;         // trackName
  developer_name: string | null;
  developer_id: string | null;
  seller_url: string | null;
  app_url: string | null;   // trackViewUrl
  icon_url: string | null;  // artworkUrl512 preferred
  price: number | null;
  currency: string | null;
  rating: number | null;
  rating_count: number | null;
  release_date: string | null;
  store_updated_at: string | null;
  version: string | null;
  categories: string[];
  description: string | null;
  country: string;
}

interface ITunesRawApp {
  trackId?: number;
  bundleId?: string;
  trackName?: string;
  sellerName?: string;
  artistId?: number;
  sellerUrl?: string;
  trackViewUrl?: string;
  artworkUrl512?: string;
  artworkUrl100?: string;
  artworkUrl60?: string;
  price?: number;
  currency?: string;
  averageUserRating?: number;
  userRatingCount?: number;
  releaseDate?: string;
  currentVersionReleaseDate?: string;
  version?: string;
  genres?: string[];
  description?: string;
  wrapperType?: string;
  kind?: string;
}

interface ITunesResponse {
  resultCount: number;
  results: ITunesRawApp[];
}

function normalize(raw: ITunesRawApp, country: string): ITunesApp | null {
  if (!raw.trackId || !raw.trackName) return null;
  // Only software (apps). iTunes returns music/movies/etc. when media isn't filtered.
  if (raw.wrapperType && raw.wrapperType !== "software") return null;

  return {
    app_id: String(raw.trackId),
    bundle_id: raw.bundleId ?? null,
    app_name: raw.trackName,
    developer_name: raw.sellerName ?? null,
    developer_id: raw.artistId != null ? String(raw.artistId) : null,
    seller_url: raw.sellerUrl ?? null,
    app_url: raw.trackViewUrl ?? null,
    icon_url: raw.artworkUrl512 ?? raw.artworkUrl100 ?? raw.artworkUrl60 ?? null,
    price: raw.price ?? null,
    currency: raw.currency ?? null,
    rating: raw.averageUserRating ?? null,
    rating_count: raw.userRatingCount ?? null,
    release_date: raw.releaseDate ?? null,
    store_updated_at: raw.currentVersionReleaseDate ?? null,
    version: raw.version ?? null,
    categories: raw.genres ?? [],
    description: raw.description ?? null,
    country,
  };
}

export interface ITunesSearchOpts {
  /** ISO country code — default "US" */
  country?: string;
  /** Max results from the API — iTunes caps at 200; we default 50 */
  limit?: number;
}

/**
 * Keyword search. Returns up to `limit` apps matching the term.
 */
export async function searchITunesApps(
  term: string,
  opts: ITunesSearchOpts = {},
): Promise<ITunesApp[]> {
  const country = opts.country ?? "US";
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const url = new URL(ITUNES_SEARCH_URL);
  url.searchParams.set("term", term);
  url.searchParams.set("media", "software");
  url.searchParams.set("entity", "software,iPadSoftware");
  url.searchParams.set("country", country);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" },
    // iTunes CDN is cacheable; Cloudflare will dedupe concurrent scans for hot terms.
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) {
    throw new Error(`iTunes search failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as ITunesResponse;
  return (data.results ?? [])
    .map((r) => normalize(r, country))
    .filter((a): a is ITunesApp => a !== null);
}

/**
 * Exact bundle-ID lookup. Returns zero or one app.
 */
export async function lookupITunesByBundle(
  bundleId: string,
  country: string = "US",
): Promise<ITunesApp | null> {
  const url = new URL(ITUNES_LOOKUP_URL);
  url.searchParams.set("bundleId", bundleId);
  url.searchParams.set("country", country);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(30_000), headers: { Accept: "application/json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) {
    throw new Error(`iTunes lookup failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json() as ITunesResponse;
  const first = data.results?.[0];
  return first ? normalize(first, country) : null;
}

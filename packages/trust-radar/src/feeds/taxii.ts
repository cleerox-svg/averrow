// Generic TAXII 2.1 collection ingest.
//
// One feed module shared across every TAXII collection we subscribe
// to. Each subscribed collection is a feed_configs row whose
// feed_name is dispatched in feeds/index.ts to THIS module — the
// runtime reads back the TAXII-specific config columns
// (taxii_root_url, taxii_collection_id, taxii_auth_type,
// taxii_username, taxii_api_key_env, taxii_next_added_after) and
// drains pages until the per-tick budget runs out.
//
// The wire shape is defined by the OASIS TAXII 2.1 spec; the parse
// path lives in lib/stix-parser.ts (single-comparison patterns;
// 95% of public-feed content).
//
// PR-BG — multi-page draining with per-page cursor commits.
//   Previous v1 only pulled ONE page per tick. With an 8-year
//   AlienVault OTX backlog the cursor never advanced past 2018
//   (production audit 2026-05-18: cursor stuck at 2018-08-06,
//   38h of no successful ingest, every 12-min tick timing out).
//   The new pattern: loop pages until the per-tick budget runs
//   out OR the server signals !hasMore. Cursor commits after
//   every page, so progress survives if a page times out
//   mid-processing. Survives any duration of upstream slowness
//   or any size of backlog without losing place.

import type { Env } from "../types";
import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId } from "./types";
import { insertThreat } from "../lib/feedRunner";
import { fetchTaxiiObjects, type TaxiiAuth } from "../lib/taxii-client";
import { iterParsedIndicators, type ParsedIndicator } from "../lib/stix-parser";

interface TaxiiConfigRow {
  feed_name: string;
  batch_size: number;
  taxii_root_url: string | null;
  taxii_collection_id: string | null;
  taxii_auth_type: string | null;
  taxii_username: string | null;
  taxii_api_key_env: string | null;
  taxii_next_added_after: string | null;
}

// Per-tick wall-clock budget for the multi-page loop. Sized at
// 9 min so the existing 12-min Promise.race timeout below stays
// the outer guard for the worst case. We bail out of the loop
// before the budget so the LAST page is guaranteed to commit its
// cursor; otherwise we'd risk the 12-min timeout firing while a
// page write is in flight.
const INGEST_BUDGET_MS = 9 * 60_000;

// Safety multiplier on observed per-page duration. If the last
// page took 30s, we won't start a new one unless at least
// 30s × 1.5 = 45s of budget remains.
const PAGE_DURATION_SAFETY = 1.5;

// Floor for "next page might take this long" estimate. Used until
// we've observed actual page durations. 30s matches the per-fetch
// timeout in the TAXII client.
const INITIAL_PAGE_ESTIMATE_MS = 60_000;

function resolveAuth(
  env: Env,
  authType: string | null,
  username: string | null,
  apiKeyEnv: string | null,
): TaxiiAuth {
  if (!authType || authType === "none") return { type: "none" };

  // The secret is named in apiKeyEnv and looked up on env. Tolerate
  // a missing secret by degrading to anonymous — better to emit a
  // pull-history failure than to crash the whole runFeed.
  const secretValue = apiKeyEnv
    ? (env as unknown as Record<string, string | undefined>)[apiKeyEnv]
    : undefined;

  if (!secretValue) return { type: "none" };

  switch (authType) {
    case "bearer":
      return { type: "bearer", token: secretValue };
    case "basic":
      // For basic, treat the secret as the password and the username
      // column as the username. Empty-username basic auth is also
      // valid (some servers accept the key as the username and an
      // empty password); the TAXII client supports either shape.
      return { type: "basic", username: username ?? "", password: secretValue };
    default:
      return { type: "none" };
  }
}

/**
 * Map our `ParsedIndicator` shape onto the ThreatRow columns and
 * push through insertThreat. Returns the row id for cursor logging.
 */
function buildThreatRow(
  feedName: string,
  parsed: ParsedIndicator,
): ThreatRow {
  // threatId expects (source, iocType, iocValue) — for the IOC type
  // we collapse iocField onto the canonical short labels used by
  // other feeds (ip, domain, url, ioc) so the dedup ID space is
  // consistent.
  const iocTypeLabel =
    parsed.iocField === "ip_address"
      ? "ip"
      : parsed.iocField === "malicious_domain"
        ? "domain"
        : parsed.iocField === "malicious_url"
          ? "url"
          : "ioc";

  const row: ThreatRow = {
    id: threatId(feedName, iocTypeLabel, parsed.iocValue),
    source_feed: feedName,
    threat_type: parsed.threatType,
    malicious_url: parsed.iocField === "malicious_url" ? parsed.iocValue : null,
    malicious_domain: parsed.iocField === "malicious_domain" ? parsed.iocValue : null,
    ip_address: parsed.iocField === "ip_address" ? parsed.iocValue : null,
    ioc_value: parsed.iocField === "ioc_value" ? parsed.iocValue : null,
    confidence_score: parsed.confidence,
    severity: parsed.severity,
    status: "active",
  };
  return row;
}

export const taxii: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    // Outer wall-clock guard. Feeds dispatched via the standard
    // FeedRunner already get a feed-pull-reaper at 15 min, but a
    // clean Promise.race bail-out at 12 min surfaces a descriptive
    // error in pull-history INSTEAD of the generic "reaped by
    // navigator" stamp. The inner loop has its own 9-min budget
    // that bails earlier so the LAST page always commits its
    // cursor — this outer guard is just defense-in-depth.
    const TAXII_WALLTIME_MS = 12 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`taxii: ${ctx.feedName} ingest timed out after ${TAXII_WALLTIME_MS}ms`)),
        TAXII_WALLTIME_MS,
      );
    });
    try {
      return await Promise.race([taxiiIngest(ctx), timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  },
};

async function taxiiIngest(ctx: FeedContext): Promise<FeedResult> {
  const { env, feedName } = ctx;
  const start = Date.now();
  const deadline = start + INGEST_BUDGET_MS;

  // Pull the TAXII-specific config back from feed_configs. The
  // standard FeedContext only carries feed_name + source_url, so
  // every TAXII-backed feed has to look up its own row to find
  // its collection ID, auth params, and cursor.
  const cfg = await env.DB.prepare(`
    SELECT feed_name, batch_size,
           taxii_root_url, taxii_collection_id, taxii_auth_type,
           taxii_username, taxii_api_key_env, taxii_next_added_after
      FROM feed_configs
     WHERE feed_name = ?
  `).bind(feedName).first<TaxiiConfigRow>();

  if (!cfg) {
    throw new Error(`taxii: no feed_configs row for ${feedName}`);
  }
  if (!cfg.taxii_root_url || !cfg.taxii_collection_id) {
    throw new Error(
      `taxii: feed ${feedName} is missing taxii_root_url and/or taxii_collection_id`,
    );
  }

  const auth = resolveAuth(
    env,
    cfg.taxii_auth_type,
    cfg.taxii_username,
    cfg.taxii_api_key_env,
  );

  let itemsFetched = 0;
  let itemsNew = 0;
  let itemsDuplicate = 0;
  let itemsError = 0;
  let pageCount = 0;
  let nextEstimateMs = INITIAL_PAGE_ESTIMATE_MS;
  let cursor: string | null = cfg.taxii_next_added_after;

  // ── Multi-page drain loop ──
  // Each iteration pulls one page, processes its objects, and
  // commits the cursor. We keep going until either the server
  // signals !hasMore (caught up) OR the next page wouldn't safely
  // fit in the remaining budget.
  for (;;) {
    const now = Date.now();
    const remaining = deadline - now;
    if (remaining < nextEstimateMs * PAGE_DURATION_SAFETY) {
      // Not enough budget left to safely complete another page +
      // commit its cursor. Bail with what we've done.
      break;
    }

    const pageStart = now;
    let fetched;
    try {
      fetched = await fetchTaxiiObjects({
        rootUrl: cfg.taxii_root_url,
        collectionId: cfg.taxii_collection_id,
        auth,
        addedAfter: cursor,
        limit: cfg.batch_size,
      });
    } catch (err) {
      // Fetch failure on page N>0 isn't fatal — we already
      // committed earlier pages' cursors. Surface as a partial-
      // success error message, returning what we got.
      if (pageCount > 0) {
        console.warn(
          `[taxii:${feedName}] page ${pageCount + 1} fetch failed (kept ${itemsNew} from earlier pages):`,
          err,
        );
        break;
      }
      throw err;
    }

    pageCount++;
    let pageInserts = 0;

    for (const { parsed } of iterParsedIndicators(fetched.bundle)) {
      itemsFetched++;
      try {
        const row = buildThreatRow(feedName, parsed);
        const before = await env.DB.prepare(
          `SELECT 1 FROM threats WHERE id = ? LIMIT 1`,
        ).bind(row.id).first<{ 1: number }>();
        if (before) {
          itemsDuplicate++;
          continue;
        }
        await insertThreat(env.DB, row);
        itemsNew++;
        pageInserts++;
      } catch (err) {
        itemsError++;
        console.error(`[taxii:${feedName}] insert error:`, err);
      }
    }

    // Commit cursor after each page. NEVER move backwards: if a
    // server returned a cursor older than what we already had
    // (rare but possible during clock skew or replay), keep the
    // existing value.
    if (fetched.nextCursor && (!cursor || fetched.nextCursor > cursor)) {
      try {
        await env.DB.prepare(
          `UPDATE feed_configs
              SET taxii_next_added_after = ?,
                  updated_at = datetime('now')
            WHERE feed_name = ?`,
        ).bind(fetched.nextCursor, feedName).run();
        cursor = fetched.nextCursor;
      } catch (err) {
        // Cursor write failure means the next tick re-pulls this
        // page. Dedup absorbs the cost. Surface as a non-fatal
        // log line. Don't break the loop — let following pages
        // try to advance.
        console.error(`[taxii:${feedName}] cursor update failed:`, err);
      }
    }

    // Update the next-page-duration estimate based on actuals.
    const pageDuration = Date.now() - pageStart;
    nextEstimateMs = Math.max(INITIAL_PAGE_ESTIMATE_MS / 4, pageDuration);

    console.log(
      `[taxii:${feedName}] page ${pageCount}: fetched=${pageInserts + itemsDuplicate - (itemsDuplicate - 0)}, new=${pageInserts}, cursor→${cursor?.slice(0, 19) ?? 'null'}, dur=${pageDuration}ms, hasMore=${fetched.hasMore}`,
    );

    // Caught up — server has nothing newer.
    if (!fetched.hasMore) break;
  }

  console.log(
    `[taxii:${feedName}] drained ${pageCount} page(s) in ${Date.now() - start}ms — new=${itemsNew} dup=${itemsDuplicate} err=${itemsError} fetched=${itemsFetched}`,
  );

  return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
}

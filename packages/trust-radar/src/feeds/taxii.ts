// Generic TAXII 2.1 collection ingest.
//
// One feed module shared across every TAXII collection we subscribe
// to. Each subscribed collection is a feed_configs row whose
// feed_name is dispatched in feeds/index.ts to THIS module — the
// runtime reads back the TAXII-specific config columns
// (taxii_root_url, taxii_collection_id, taxii_auth_type,
// taxii_username, taxii_api_key_env, taxii_next_added_after) and
// pulls one cursor-bounded page of objects per tick.
//
// The wire shape is defined by the OASIS TAXII 2.1 spec; the parse
// path lives in lib/stix-parser.ts (single-comparison patterns;
// 95% of public-feed content).
//
// Multi-page draining is OUT OF SCOPE for v1: we pull one TAXII
// page per tick and let the next hourly cron pick up where we
// left off via the cursor column. Looping would risk pinning the
// Worker on a backfilled collection (some OTX/MISP feeds will
// return ~10k objects on a cold cursor). If steady-state inflow
// outpaces the per-tick page, bump batch_size + add looping
// later.

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
    const { env, feedName } = ctx;

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

    const fetched = await fetchTaxiiObjects({
      rootUrl: cfg.taxii_root_url,
      collectionId: cfg.taxii_collection_id,
      auth,
      addedAfter: cfg.taxii_next_added_after,
      limit: cfg.batch_size,
    });

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

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
      } catch (err) {
        itemsError++;
        console.error(`[taxii:${feedName}] insert error:`, err);
      }
    }

    // Advance the cursor if the server gave us one. NEVER move it
    // backwards: if a server returned a cursor older than what we
    // already had (rare but possible during clock skew or replay),
    // keep the existing value.
    if (fetched.nextCursor) {
      const current = cfg.taxii_next_added_after;
      if (!current || fetched.nextCursor > current) {
        try {
          await env.DB.prepare(
            `UPDATE feed_configs
                SET taxii_next_added_after = ?,
                    updated_at = datetime('now')
              WHERE feed_name = ?`,
          ).bind(fetched.nextCursor, feedName).run();
        } catch (err) {
          // Cursor write failure means the next tick re-pulls the
          // same window. Dedup absorbs the cost; surface as a
          // non-fatal log line.
          console.error(`[taxii:${feedName}] cursor update failed:`, err);
        }
      }
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

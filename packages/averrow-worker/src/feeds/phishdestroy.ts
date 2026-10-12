import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { calculateConfidence, calculateSeverity, reclassifyThreatType } from "../lib/threatScoring";
import { tagThreat, isIdpFamilyTag } from "../lib/idp-tagging";
import { enqueueAutoCaptures, type AutoCaptureItem } from "../lib/page-capture";

/**
 * PhishDestroy (destroylist) — Curated phishing & scam domain blocklist.
 * Source: https://github.com/phishdestroy/destroylist
 * Format: JSON array of domain strings.
 * Free, no auth, updated hourly. Sorted alphabetically (NOT newest-first)
 * — see PHISHDESTROY_CURSOR_KEY for how runs rotate through it.
 *
 * Implementation note (2026-05-04 rewrite):
 *
 * The previous version called `isDuplicate` (KV GET) + `insertThreat`
 * (D1 INSERT) + `markSeen` (KV PUT) sequentially per domain. With a
 * 5,000-domain payload that's 15,000 sub-requests in series — well
 * past the Cloudflare Worker per-invocation ceiling. Result: every
 * pull was killed mid-loop with no row in feed_pull_history ever
 * advancing past status='partial'. Diagnostics counted 15 orphan
 * pull-history rows in 24h.
 *
 * Fix: build all INSERT OR IGNORE statements upfront and flush via
 * `db.batch()` — the platform standard per CLAUDE.md §8 ("Use
 * ON CONFLICT DO NOTHING — never SELECT then INSERT") and the same
 * pattern cartographer.ts uses for its enrichment writes. We drop
 * the KV dedup entirely; the threats table PK is deterministic
 * (`thr-phishdestroy-<hash>`) and the unique-constraint conflict path
 * gives us correct accounting via `meta.changes`.
 *
 * Per-pull cost: ceil(5000 / 50) = 100 batch round-trips, well under
 * any Worker subrequest ceiling.
 */

const BATCH_CHUNK = 50;
const MAX_DOMAINS_PER_RUN = 5_000;
// Upper bound on payload entries examined per run, so a payload that is
// mostly junk can't make the validation walk iterate the whole list.
const MAX_SCAN_PER_RUN = 50_000;

/**
 * Canonical upstream list. Verified 2026-10-12: HTTP 200, a JSON array
 * of ~218K domain strings (5.6 MB). Same URL migration 0008 seeds into
 * feed_configs.source_url.
 */
export const PHISHDESTROY_LIST_URL =
  "https://raw.githubusercontent.com/phishdestroy/destroylist/main/list.json";

/**
 * KV rotation cursor (2026-10-12). destroylist is published sorted
 * ALPHABETICALLY, not newest-first. The previous `slice(0, 50_000)` +
 * 5,000-row cap therefore re-read the same first 5,000 domains
 * (`0-*` … `a*`) on every run, so after the first pull the feed never
 * produced a new row past that prefix. Each run now resumes where the
 * previous one stopped and wraps at the end, covering the full list
 * every ceil(len / 5,000) runs. Best-effort: a KV failure restarts at 0.
 */
export const PHISHDESTROY_CURSOR_KEY = "feed:phishdestroy:cursor";

/**
 * Fetch the list. A 404 on an operator-edited `feed_configs.source_url`
 * falls back to the canonical URL, and every error names the URL(s)
 * tried so the next reader of feed_status.last_error knows which one
 * to fix.
 */
async function fetchList(configuredUrl: string): Promise<unknown> {
  const primary = configuredUrl.trim() || PHISHDESTROY_LIST_URL;
  const urls = primary === PHISHDESTROY_LIST_URL ? [primary] : [primary, PHISHDESTROY_LIST_URL];
  const notFound: string[] = [];
  for (const url of urls) {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) {
      notFound.push(url);
      continue;
    }
    if (!res.ok) throw new Error(`PhishDestroy HTTP ${res.status} (${url})`);
    if (notFound.length > 0) {
      console.warn(
        `[phishdestroy] feed_configs.source_url ${notFound[0]} returned 404; ` +
          `used canonical ${url}. Update source_url to the canonical URL.`,
      );
    }
    return res.json();
  }
  throw new Error(
    `PhishDestroy HTTP 404 (${notFound.join(", ")}): list not found. Check ` +
      `https://github.com/phishdestroy/destroylist for a moved/discontinued list; ` +
      `update feed_configs.source_url or disable the feed.`,
  );
}

async function readCursor(env: FeedContext["env"]): Promise<number> {
  try {
    const raw = await env.CACHE.get(PHISHDESTROY_CURSOR_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(env: FeedContext["env"], next: number): Promise<void> {
  try {
    await env.CACHE.put(PHISHDESTROY_CURSOR_KEY, String(next));
  } catch {
    // Best-effort — next run restarts from 0, which is still correct, just slower.
  }
}

/** Shape filter + normalisation for one payload entry; null = reject. */
export function normalizeDestroylistEntry(d: unknown): string | null {
  if (typeof d !== "string") return null;
  const trimmed = d.trim().toLowerCase();
  // Must contain a dot, no whitespace, no protocol prefix, no leading
  // wildcard. The wildcard filter mirrors the SQL gate in
  // lib/dns-backfill (`malicious_domain NOT LIKE '*%'`).
  if (trimmed.length < 4) return null;
  if (!trimmed.includes(".")) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.startsWith("*")) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return null;
  return trimmed;
}

export const phishdestroy: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    const raw = await fetchList(ctx.feedUrl);
    if (!Array.isArray(raw)) throw new Error("PhishDestroy: expected JSON array");
    const domains: unknown[] = raw;
    if (domains.length === 0) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Walk from the rotation cursor, wrapping at the end. Validate and
    // dedupe in memory before touching D1.
    const start = (await readCursor(ctx.env)) % domains.length;
    const scanLimit = Math.min(domains.length, MAX_SCAN_PER_RUN);
    const seenInPayload = new Set<string>();
    const valid: string[] = [];
    let scanned = 0;
    while (scanned < scanLimit && valid.length < MAX_DOMAINS_PER_RUN) {
      const domain = normalizeDestroylistEntry(domains[(start + scanned) % domains.length]);
      scanned++;
      if (domain === null || seenInPayload.has(domain)) continue;
      seenInPayload.add(domain);
      valid.push(domain);
    }
    await writeCursor(ctx.env, (start + scanned) % domains.length);

    if (valid.length === 0) {
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // Pre-resolve threat-scoring once per payload — every row is
    // type='phishing' from the same feed, so the inputs to
    // calculateConfidence / calculateSeverity / reclassifyThreatType
    // don't depend on the domain. No need to re-derive 5k times.
    const baseType = reclassifyThreatType("phishing", null, null) ?? "phishing";
    const baseConfidence = 80; // pre-#998 default for phishdestroy
    const baseSeverity = calculateSeverity(
      // calculateConfidence has feed-aware overrides; honor them so we
      // stay aligned with single-row insertThreat() callers elsewhere.
      calculateConfidence("phishdestroy", baseType, false),
    );
    const finalConfidence = baseConfidence;
    const finalSeverity = baseSeverity;
    const finalType = baseType;

    // Build statements once, flush in chunks. Each chunk is a single
    // D1 transaction; failures roll back that chunk only.
    // IdP-impersonation tagging (lib/idp-tagging.ts): domain-only, no
    // brand context here, so strong lures + IdP tenant hosts only.
    const idpFamily: boolean[] = [];
    const stmts = valid.map((domain) => {
      const idp = tagThreat({ malicious_domain: domain, malicious_url: `https://${domain}` });
      idpFamily.push(isIdpFamilyTag(idp));
      return ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO threats
           (id, source_feed, threat_type, malicious_url, malicious_domain,
            ioc_value, severity, confidence_score, status, technique, impersonated_idp,
            first_seen, last_seen, created_at)
         VALUES (?, 'phishdestroy', ?, ?, ?, ?, ?, ?, 'active', ?, ?,
                 datetime('now'), datetime('now'), datetime('now'))`,
      ).bind(
        threatId("phishdestroy", "domain", domain),
        finalType,
        `https://${domain}`,
        domain,
        domain,
        finalSeverity,
        finalConfidence,
        idp.technique,
        idp.impersonated_idp,
      );
    });

    let itemsNew = 0;
    let itemsError = 0;
    const captureItems: AutoCaptureItem[] = [];
    for (let i = 0; i < stmts.length; i += BATCH_CHUNK) {
      const chunk = stmts.slice(i, i + BATCH_CHUNK);
      try {
        const results = await ctx.env.DB.batch(chunk);
        for (let k = 0; k < results.length; k++) {
          // INSERT OR IGNORE: changes=1 → new row, changes=0 → PK collision (duplicate).
          const changed = results[k]?.meta?.changes ?? 0;
          itemsNew += changed;
          const domain = valid[i + k];
          if (changed > 0 && domain && idpFamily[i + k]) {
            captureItems.push({ threatId: threatId("phishdestroy", "domain", domain), maliciousDomain: domain });
          }
        }
      } catch (err) {
        itemsError += chunk.length;
        console.error(`[phishdestroy] batch ${i}-${i + chunk.length} failed:`, err);
      }
    }

    // New IdP-family rows → page-capture queue (lib/page-capture.ts).
    // Best-effort, never throws, never awaits the browser.
    if (captureItems.length > 0) await enqueueAutoCaptures(ctx.env.DB, captureItems);

    const itemsDuplicate = valid.length - itemsNew - itemsError;
    return { itemsFetched: valid.length, itemsNew, itemsDuplicate, itemsError };
  },
};

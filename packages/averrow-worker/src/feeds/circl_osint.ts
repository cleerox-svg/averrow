import type { FeedModule, FeedContext, FeedResult, ThreatRow } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

/**
 * CIRCL OSINT feed (Luxembourg CERT) — free, no API key.
 *
 * CIRCL publishes its OSINT indicator set as a **MISP feed** (NOT
 * TAXII — abuse.ch/CIRCL both dropped/never had TAXII 2.1, so the
 * generic taxii.ts consumer can't read this). A MISP feed is a
 * directory of JSON:
 *
 *   <base>/manifest.json   → { "<event-uuid>": { info, date, timestamp, ... }, ... }
 *   <base>/<event-uuid>.json → { "Event": { Attribute:[...], Object:[{Attribute:[...]}] } }
 *
 * We fetch the manifest, drain events newer than a KV timestamp
 * cursor (oldest-first, capped per pull), fetch each event, and
 * extract the detection-quality (`to_ids=true`) network IOCs
 * (domain / hostname / url / ip) into `threats`. Overlap with our
 * other feeds is absorbed by the deterministic threatId PK + KV dedup.
 *
 * Base URL is MISP's documented default-feed location for CIRCL OSINT.
 * Schedule: every 6h (the upstream adds a handful of events per day).
 */

// Events processed per pull. Bounds the per-tick subrequest + wall-clock
// budget (1 manifest fetch + up to MAX_EVENTS event fetches).
const MAX_EVENTS = 20;
// Safety cap on IOCs inserted per pull, independent of event count.
const MAX_IOCS = 1500;
// Never drain more than this much history on a cold cursor — a threat
// feed only cares about recent indicators, and CIRCL's manifest spans years.
const BACKFILL_WINDOW_SEC = 30 * 24 * 60 * 60;
// Per-run wall-clock budget. 1 + up-to-MAX_EVENTS sequential 30s fetches
// could otherwise approach the orchestrator reap window (CLAUDE.md §6).
const BUDGET_MS = 8 * 60_000;
const CURSOR_KEY = "circl_osint:cursor";

interface ManifestEntry {
  timestamp?: string;
  info?: string;
  date?: string;
}
interface MispAttribute {
  type?: string;
  value?: string;
  // MISP feeds usually serialize to_ids as a JSON boolean, but some
  // exporters emit 1/0 or "1"/"0". Accept all truthy forms so a stringy
  // value can't silently drop every IOC (the feed would report success
  // with itemsNew=0 and look healthy while ingesting nothing).
  to_ids?: boolean | number | string;
}
interface MispEvent {
  Event?: {
    Attribute?: MispAttribute[];
    Object?: Array<{ Attribute?: MispAttribute[] }>;
  };
}

export const circl_osint: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.feedUrl) throw new Error("CIRCL OSINT: feed_configs.source_url is empty");
    const base = ctx.feedUrl.endsWith("/") ? ctx.feedUrl : `${ctx.feedUrl}/`;

    // ── 1. Manifest ──
    const manRes = await fetch(`${base}manifest.json`, {
      signal: AbortSignal.timeout(30_000),
      headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
    });
    if (!manRes.ok) throw new Error(`CIRCL OSINT manifest HTTP ${manRes.status}`);

    let manifest: Record<string, ManifestEntry>;
    try {
      manifest = (await manRes.json()) as Record<string, ManifestEntry>;
    } catch (err) {
      throw new Error(`CIRCL OSINT manifest JSON parse failed: ${err}`);
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error("CIRCL OSINT: manifest is not a {uuid: meta} object");
    }

    // ── 2. Cursor + candidate events ──
    let cursor = parseInt((await ctx.env.CACHE.get(CURSOR_KEY)) ?? "0", 10);
    if (!Number.isFinite(cursor)) cursor = 0;
    // Clamp a cold/stale cursor so we ingest only the recent window, never
    // years of backlog. Date.now() is available in the worker runtime.
    const floor = Math.floor(Date.now() / 1000) - BACKFILL_WINDOW_SEC;
    if (cursor < floor) cursor = floor;

    // `>=` (not `>`) so a same-timestamp event straddling the MAX_EVENTS
    // batch boundary is re-included on the next pull rather than skipped;
    // the deterministic threatId PK + KV dedup make the re-processed
    // boundary event cheap.
    const candidates = Object.entries(manifest)
      .map(([uuid, m]) => ({ uuid, ts: parseInt(m?.timestamp ?? "0", 10) }))
      .filter((e) => e.uuid && Number.isFinite(e.ts) && e.ts >= cursor)
      .sort((a, b) => a.ts - b.ts) // oldest-first so the cursor advances without skipping
      .slice(0, MAX_EVENTS);

    let itemsFetched = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;

    // The cursor advances only across a CONTIGUOUS PREFIX of fully-drained
    // events (oldest-first). The first event that fails to fetch, is cut
    // off by the IOC scan cap, or is stopped by the wall-clock budget
    // CLOSES the frontier: later events may still be processed (dedup makes
    // the inevitable re-pull cheap), but the cursor never advances past the
    // gap, so no event's IOCs are ever silently skipped.
    let commitTs = cursor;
    let frontierOpen = true;
    const deadline = Date.now() + BUDGET_MS;

    // ── 3. Drain events (oldest-first) ──
    for (const { uuid, ts } of candidates) {
      if (Date.now() > deadline) break; // frontier stays where the last full event left it

      let event: MispEvent;
      try {
        const evRes = await fetch(`${base}${uuid}.json`, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": "Averrow-ThreatIntel/1.0", Accept: "application/json" },
        });
        if (!evRes.ok) {
          console.warn(`[circl_osint] event ${uuid} HTTP ${evRes.status} — skipped`);
          frontierOpen = false; // don't advance the cursor past a failed event
          continue;
        }
        event = (await evRes.json()) as MispEvent;
      } catch (err) {
        console.warn(`[circl_osint] event ${uuid} fetch/parse failed — skipped: ${err}`);
        frontierOpen = false;
        continue;
      }

      const attrs = [
        ...(event.Event?.Attribute ?? []),
        ...((event.Event?.Object ?? []).flatMap((o) => o?.Attribute ?? [])),
      ];

      let truncated = false;
      for (const attr of attrs) {
        const ioc = mapMispAttribute(attr);
        if (!ioc) continue;
        // Bound total attributes SCANNED per run (not just inserted) so an
        // all-duplicate event can't spin unbounded KV reads.
        if (itemsFetched >= MAX_IOCS) { truncated = true; break; }
        itemsFetched++;

        try {
          if (await isDuplicate(ctx.env, ioc.iocType, ioc.value)) {
            itemsDuplicate++;
            continue;
          }
          const inserted = await insertThreat(ctx.env.DB, buildRow(ioc));
          await markSeen(ctx.env, ioc.iocType, ioc.value);
          if (inserted) itemsNew++;
          else itemsDuplicate++; // INSERT OR IGNORE PK conflict — not new
        } catch (err) {
          console.error(`[circl_osint] insert error for ${ioc.iocType}=${ioc.value}: ${err instanceof Error ? err.message : err}`);
          itemsError++;
        }
      }

      if (truncated) {
        // Event only partially drained — do NOT advance the cursor to it;
        // the next pull re-pulls and completes it.
        break;
      }
      if (frontierOpen) commitTs = ts;
    }

    // ── 4. Persist cursor (only forward, only across the fully-drained prefix) ──
    if (commitTs > cursor) {
      await ctx.env.CACHE.put(CURSOR_KEY, String(commitTs));
    }

    return { itemsFetched, itemsNew, itemsDuplicate, itemsError };
  },
};

interface ParsedIoc {
  iocType: "domain" | "url" | "ip";
  value: string;
}

/**
 * Map a MISP attribute to one of our network-IOC shapes. Only
 * `to_ids=true` attributes (flagged by the publisher as usable for
 * detection) are kept; hashes / emails / registry keys / etc. are
 * dropped since this is a network-signal feed.
 */
function mapMispAttribute(attr: MispAttribute): ParsedIoc | null {
  if (!attr) return null;
  const t = attr.to_ids;
  if (t !== true && t !== 1 && t !== "1") return null;
  const type = (attr.type ?? "").trim();
  const raw = (attr.value ?? "").trim();
  if (!raw) return null;
  // Composite MISP types pack "host|extra" (domain|ip, hostname|port,
  // ip|port); the IOC is the part before the pipe.
  const before = (raw.split("|")[0] ?? "").trim();

  switch (type) {
    case "domain":
    case "hostname":
      return { iocType: "domain", value: raw.toLowerCase() };
    case "domain|ip":
    case "hostname|port":
      return before ? { iocType: "domain", value: before.toLowerCase() } : null;
    case "url":
    case "uri":
      // NB: MISP `link` is an external-analysis reference, not an IOC — excluded.
      return { iocType: "url", value: raw };
    case "ip-dst":
    case "ip-src":
      return { iocType: "ip", value: raw };
    case "ip-dst|port":
    case "ip-src|port":
      return before ? { iocType: "ip", value: before } : null;
    default:
      return null;
  }
}

function buildRow(ioc: ParsedIoc): ThreatRow {
  const isIp = ioc.iocType === "ip";
  const isUrl = ioc.iocType === "url";
  const domain = ioc.iocType === "domain" ? ioc.value : isUrl ? extractDomain(ioc.value) : null;
  return {
    id: threatId("circl_osint", ioc.iocType, ioc.value),
    source_feed: "circl_osint",
    // Neutral defaults; insertThreat's reclassifyThreatType refines
    // url/domain shapes downstream, and the Analyst agent narrates.
    threat_type: isIp ? "malicious_ip" : "malware_distribution",
    malicious_url: isUrl ? ioc.value : null,
    malicious_domain: domain,
    ip_address: isIp ? ioc.value : null,
    ioc_value: ioc.value,
    severity: "medium",
    confidence_score: 75,
  };
}

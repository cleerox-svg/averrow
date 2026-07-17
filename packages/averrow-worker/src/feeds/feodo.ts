import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";

const IP_REGEX = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Feodo Tracker (abuse.ch) — Botnet C2 IP blocklist.
 *
 * Source format: JSON array at https://feodotracker.abuse.ch/downloads/ipblocklist.json
 * Each entry has: { ip_address, port, status, hostname, as_number, as_name,
 *                   country, first_seen, last_online, malware }
 *
 * History: this parser previously assumed a flat newline-delimited IP list
 * (the old `ipblocklist.txt` URL). When `feed_configs.source_url` was migrated
 * to `ipblocklist.json` the parser was not updated, so every pull threw
 * `Feodo: 62 lines, 0 IPs (format change?): [ |     {` for ~weeks.
 * Switched to JSON parsing on 2026-05-03.
 */
export const feodo: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.feedUrl) throw new Error("Feodo: feed_configs.source_url is empty");
    const res = await fetch(ctx.feedUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Feodo HTTP ${res.status}`);

    const text = await res.text();

    // Parse JSON. The abuse.ch endpoint returns a top-level array of IOC
    // objects. If the upstream ever pivots back to a text format (or shifts
    // to a wrapped envelope), we want a clean diagnostic, not a crash.
    let entries: Array<{ ip_address?: unknown; malware?: unknown; status?: unknown }>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(
          `Feodo: expected top-level JSON array, got ${typeof parsed}: ${text.slice(0, 200)}`,
        );
      }
      entries = parsed as Array<{ ip_address?: unknown; malware?: unknown; status?: unknown }>;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Feodo: JSON parse failed (${err.message}). First 200 chars: ${text.slice(0, 200)}`);
      }
      throw err;
    }

    let itemsNew = 0;
    let itemsDuplicate = 0;
    let itemsError = 0;
    let ipMatches = 0;

    for (const entry of entries) {
      const ip = typeof entry.ip_address === "string" ? entry.ip_address.trim() : "";
      if (!IP_REGEX.test(ip)) continue;
      ipMatches++;

      try {
        if (await isDuplicate(ctx.env, "ip", ip)) {
          itemsDuplicate++;
          continue;
        }

        const malware = typeof entry.malware === "string" ? entry.malware : null;
        // Carry the malware family in ioc_value so downstream classifiers
        // (Sentinel, Cartographer) can see WHY this IP is on the list.
        const iocValue = malware ? `${ip} (${malware})` : ip;

        await insertThreat(ctx.env.DB, {
          id: threatId("feodo", "ip", ip),
          source_feed: "feodo",
          threat_type: "malware_distribution",
          malicious_url: null,
          malicious_domain: null,
          ip_address: ip,
          ioc_value: iocValue,
          severity: "high",
          confidence_score: 90,
        });
        await markSeen(ctx.env, "ip", ip);
        itemsNew++;
      } catch {
        itemsError++;
      }
    }

    // Got a populated array but no rows had a usable ip_address — probable
    // schema rename upstream. Throw so the diagnostic lands in feed_pull_history
    // instead of being silently 0-record.
    if (entries.length > 0 && ipMatches === 0) {
      const sampleKeys = entries.length > 0 && typeof entries[0] === "object"
        ? Object.keys(entries[0] ?? {}).slice(0, 8).join(",")
        : "(no keys)";
      throw new Error(
        `Feodo: ${entries.length} entries, 0 IPs (schema change?): keys=[${sampleKeys}]`,
      );
    }

    return { itemsFetched: entries.length, itemsNew, itemsDuplicate, itemsError };
  },
};

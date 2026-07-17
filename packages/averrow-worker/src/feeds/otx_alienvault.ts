import type { FeedModule, FeedContext, FeedResult } from "./types";
import { threatId, extractDomain } from "./types";
import { isDuplicate, markSeen, insertThreat } from "../lib/feedRunner";
import { diagnosticFetch } from "../lib/feedDiagnostic";
import { upsertActorFromPulse, recordOtxAttribution } from "../lib/otx-attribution";

/**
 * AlienVault OTX — Pulse activity feed.
 * Requires OTX_API_KEY for authenticated access (free account at otx.alienvault.com).
 * Falls back to public endpoint if no key, but may get HTTP 403.
 * Extracts domain, URL, and IPv4 indicators from recent pulses.
 *
 * As of Phase B (Threat Actors rebuild), this feed also persists the
 * pulse-level attribution metadata it used to discard:
 *   * Pulse `adversary` field + APT-tagged actor names → upsert into
 *     threat_actors (auto-creating new rows for first-seen actors,
 *     bumping last_seen on existing reference taxonomy).
 *   * Each (threat, pulse) pair → row in threat_attributions so the
 *     Threat Actors page can answer "who attacked whom, when, via
 *     what" instead of rendering static seed data.
 *
 * Schedule: every 2 hours.
 */
export const otx_alienvault: FeedModule = {
  async ingest(ctx: FeedContext): Promise<FeedResult> {
    if (!ctx.env.OTX_API_KEY) {
      console.error("[otx] OTX feed disabled — OTX_API_KEY secret not set. Create a free account at otx.alienvault.com and run: wrangler secret put OTX_API_KEY");
      return { itemsFetched: 0, itemsNew: 0, itemsDuplicate: 0, itemsError: 0 };
    }

    // OTX requires modified_since param — without it, subscribed endpoint returns 403
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const baseUrl = ctx.feedUrl || "https://otx.alienvault.com/api/v1/pulses/subscribed";
    const feedUrl = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}modified_since=${encodeURIComponent(since)}`;
    console.log(`[otx_alienvault] feedUrl from config: "${ctx.feedUrl}"`);
    console.log(`[otx_alienvault] Fetching: ${feedUrl}`);
    const headers: Record<string, string> = {
      "User-Agent": "Averrow-ThreatIntel/1.0",
      Accept: "application/json",
      "X-OTX-API-KEY": ctx.env.OTX_API_KEY,
    };
    const res = await diagnosticFetch(ctx.env.DB, "otx_alienvault", feedUrl, { headers });
    if (!res.ok) throw new Error(`OTX HTTP ${res.status}`);

    let body: {
      results?: Array<{
        id?: string;
        name?: string;
        description?: string;
        adversary?: string;
        tags?: string[];
        targeted_countries?: string[];
        industries?: string[];
        attack_ids?: string[];
        indicators?: Array<{ type: string; indicator: string }>;
      }>;
    };
    try {
      body = await res.json() as typeof body;
    } catch (jsonErr) {
      console.error(`[otx] JSON parse error:`, jsonErr);
      throw new Error(`OTX JSON parse failed: ${jsonErr}`);
    }

    const pulses = body.results ?? [];
    let itemsNew = 0, itemsDuplicate = 0, itemsError = 0;
    let total = 0;

    for (const pulse of pulses) {
      if (total >= 200) break;
      const tags = (pulse.tags ?? []).map(t => t.toLowerCase());

      let threatType: "phishing" | "malware_distribution" | "c2" = "malware_distribution";
      if (tags.some(t => t.includes("phishing"))) threatType = "phishing";
      else if (tags.some(t => t.includes("c2") || t.includes("c&c") || t.includes("command"))) threatType = "c2";

      // Resolve (or auto-create) the threat actor for this pulse once,
      // then attach every threat from the pulse to that actor below.
      // Pulses without a recognizable adversary or APT-tagged actor
      // skip attribution silently — the indicators still get inserted
      // into threats, just without an actor link.
      const pulseId = pulse.id ?? "";
      let actorId: string | null = null;
      if (pulseId) {
        try {
          actorId = await upsertActorFromPulse(ctx.env.DB, {
            id:                 pulseId,
            name:               pulse.name ?? "",
            description:        pulse.description,
            adversary:          pulse.adversary,
            tags:               pulse.tags,
            targeted_countries: pulse.targeted_countries,
            industries:         pulse.industries,
            attack_ids:         pulse.attack_ids,
          });
        } catch (e) {
          // Non-fatal: attribution failure must not block ingest.
          console.error(`[otx] actor upsert failed for pulse ${pulseId}:`, e);
        }
      }

      for (const ind of pulse.indicators ?? []) {
        if (total >= 200) break;
        const iocType = ind.type;
        const iocValue = ind.indicator;

        if (iocType !== "domain" && iocType !== "URL" && iocType !== "IPv4") continue;

        try {
          if (await isDuplicate(ctx.env, iocType, iocValue)) { itemsDuplicate++; continue; }

          const url = iocType === "URL" ? iocValue : (iocType === "domain" ? `http://${iocValue}` : null);
          const domain = iocType === "domain" ? iocValue : (iocType === "URL" ? extractDomain(iocValue) : null);
          const ip = iocType === "IPv4" ? iocValue : null;

          const tid = threatId("otx", iocType, iocValue);
          await insertThreat(ctx.env.DB, {
            id: tid,
            source_feed: "otx_alienvault",
            threat_type: threatType,
            malicious_url: url,
            malicious_domain: domain,
            ip_address: ip,
            ioc_value: iocValue,
            severity: threatType === "phishing" ? "high" : "medium",
            confidence_score: 65,
          });

          // Persist the per-threat attribution row if we resolved an
          // actor for this pulse. Best-effort — failures are logged
          // but don't bubble up because the threat itself was inserted
          // successfully.
          if (actorId && pulseId) {
            try {
              await recordOtxAttribution(ctx.env.DB, tid, actorId, {
                id:                 pulseId,
                name:               pulse.name ?? "",
                adversary:          pulse.adversary,
                tags:               pulse.tags,
                targeted_countries: pulse.targeted_countries,
                industries:         pulse.industries,
                attack_ids:         pulse.attack_ids,
              });
            } catch (e) {
              console.error(`[otx] attribution write failed for threat ${tid}:`, e);
            }
          }

          await markSeen(ctx.env, iocType, iocValue);
          itemsNew++;
          total++;
        } catch (e) {
          itemsError++;
          if (itemsError <= 3) console.error(`[otx] item error: ${e}`);
        }
      }
    }

    return { itemsFetched: total, itemsNew, itemsDuplicate, itemsError };
  },
};

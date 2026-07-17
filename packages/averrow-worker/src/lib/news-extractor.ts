// News article → structured threat intel extraction via Haiku.
//
// Phase D of the Threat Actors rebuild. The news-watcher agent feeds
// each article (title + leading 800 chars of description) through here
// and gets back a tight JSON object: actors mentioned, target countries,
// target sectors, severity, and whether the article describes
// state-sponsored / geopolitical activity (drives geopolitical_campaigns
// auto-population).
//
// The prompt is engineered for cheap, predictable Haiku output:
//   * Strict JSON-only response with a constrained schema
//   * Empty arrays / null fields when uncertain — never invent data
//   * Maximum 256 tokens out (Haiku-speed, ~$0.0001 per article)

import { callHaikuRaw } from "./haiku";
import type { Env } from "../types";

export interface NewsExtraction {
  /** Threat actors named in the article. Free-form names — caller
   *  canonicalizes via canonicalActorName(). */
  actors: string[];
  /** ISO-3166-1 alpha-2 codes for affected countries / regions. */
  target_countries: string[];
  /** Sector tags ('finance', 'healthcare', 'energy', 'tech', 'gov',
   *  'defense', 'telecom', 'critical_infrastructure'). */
  target_sectors: string[];
  /** 'critical' | 'high' | 'medium' | 'low' | 'info' */
  severity: string;
  /** True when the article describes state-sponsored, APT-attributed,
   *  or otherwise geopolitical activity. Drives whether the watcher
   *  creates / updates a geopolitical_campaigns row. */
  is_geopolitical: boolean;
  /** Optional cluster name derived from the article — used as the
   *  geopolitical_campaigns row name when is_geopolitical is true. */
  campaign_label: string | null;
}

const EMPTY: NewsExtraction = {
  actors: [],
  target_countries: [],
  target_sectors: [],
  severity: "info",
  is_geopolitical: false,
  campaign_label: null,
};

const SYSTEM_PROMPT = `You are a threat-intelligence analyst extracting structured intel from cyber-security news articles.

Given an article (title + body excerpt), respond with a single compact JSON object on one line:

{"actors":[<canonical APT or cybercrime group names>],"target_countries":[<ISO-3166-1 alpha-2 codes>],"target_sectors":[<one of: finance, healthcare, energy, tech, gov, defense, telecom, critical_infrastructure, retail, education, media>],"severity":"critical"|"high"|"medium"|"low"|"info","is_geopolitical":true|false,"campaign_label":<short title or null>}

Rules:
* Only include data you are confident about. Use empty arrays and null when uncertain — NEVER invent.
* "is_geopolitical" = true only when the article describes state-sponsored or geopolitical-tension cyber activity.
* "campaign_label" = a short descriptor when is_geopolitical is true (e.g. "Iran post-strike retaliation"). Null otherwise.
* Reply with ONLY the JSON object. No prose, no markdown, no explanation.`;

/**
 * Extract structured intel from a news article. Best-effort — returns
 * an EMPTY result on Haiku failure or unparseable JSON. Caller checks
 * `actors.length > 0` to decide whether to upsert anything.
 */
export async function extractFromArticle(
  env: Env,
  callCtx: { agentId: string; runId?: string | null },
  title: string,
  excerpt: string,
): Promise<NewsExtraction> {
  // Cap excerpt so a long blog post doesn't blow the prompt budget.
  const trimmedExcerpt = (excerpt || "").slice(0, 800);
  const userMessage = `TITLE: ${title}\n\nEXCERPT: ${trimmedExcerpt}`;

  const result = await callHaikuRaw(env, callCtx, SYSTEM_PROMPT, userMessage, 256);
  if (!result.success || !result.text) return EMPTY;

  // Strip code fences if Haiku decorates anyway.
  const stripped = result.text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped);
    return {
      actors: arrayOfStrings(parsed.actors).slice(0, 5),
      target_countries: arrayOfStrings(parsed.target_countries).map((c) => c.toUpperCase().slice(0, 2)).slice(0, 5),
      target_sectors: arrayOfStrings(parsed.target_sectors).slice(0, 5),
      severity: typeof parsed.severity === "string" ? parsed.severity : "info",
      is_geopolitical: Boolean(parsed.is_geopolitical),
      campaign_label: typeof parsed.campaign_label === "string" && parsed.campaign_label.trim()
        ? parsed.campaign_label.trim().slice(0, 80)
        : null,
    };
  } catch {
    return EMPTY;
  }
}

function arrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

// SaaS technique auto-classifier.
// Assigns a saas_technique_id to threats based on threat_type, URL/domain
// patterns, and source context. Returns null when no confident match.
//
// Rule order (most-specific first):
//   1. Domain / URL regex patterns (login., oauth., office365, slack., ...)
//   2. Threat type → technique mapping
//   3. Source-based social hints

import {
  THREAT_TYPE_TO_TECHNIQUE,
  DOMAIN_PATTERN_HINTS,
} from "./saas-techniques-seed";

export interface ClassifiableThreat {
  threat_type:      string | null;
  malicious_domain: string | null;
  malicious_url:    string | null;
  source_feed:      string | null;
}

export function classifySaasTechnique(threat: ClassifiableThreat): string | null {
  const domain = (threat.malicious_domain ?? threat.malicious_url ?? "").toLowerCase();
  const type   = (threat.threat_type ?? "").toLowerCase();

  // 1. Domain / URL pattern matching (most specific).
  if (domain) {
    for (const { pattern, technique } of DOMAIN_PATTERN_HINTS) {
      if (pattern.test(domain)) return technique;
    }
  }

  // 2. Exact / substring threat type mapping.
  if (type) {
    if (THREAT_TYPE_TO_TECHNIQUE[type]) return THREAT_TYPE_TO_TECHNIQUE[type];
    for (const [threatType, techniqueId] of Object.entries(THREAT_TYPE_TO_TECHNIQUE)) {
      const spaced = threatType.replace(/_/g, " ");
      const dashed = threatType.replace(/_/g, "-");
      if (type.includes(spaced) || type.includes(dashed) || type.includes(threatType)) {
        return techniqueId;
      }
    }
  }

  // 3. Source-based hints — social feeds default to IM user spoofing.
  const source = (threat.source_feed ?? "").toLowerCase();
  if (source && (
    source.includes("social") ||
    source.includes("twitter") || source.includes("tweetfeed") ||
    source.includes("tiktok") ||
    source.includes("instagram") ||
    source.includes("mastodon")
  )) {
    return "im_user_spoofing";
  }

  return null;
}

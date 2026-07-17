// Averrow — Abuse Mailbox deeper AI investigator
//
// Runs AFTER the Haiku verdict + URL promotion (PR-AX) on HIGH/CRITICAL
// confirmed phishing/malware captures. Produces structured output that
// goes beyond verdict to attribution, campaign correlation, and a
// specific recommended action.
//
// Severity-gated upstream so cost is bounded: ~10 confirmed/day worst
// case × ~$0.003 per Sonnet call = pennies per day.
//
// Two-narrative pattern:
//   internal_narrative — full, with IPs / URLs / sender emails.
//                        Surfaced in the operator's drill-down UI.
//   external_narrative — sanitized for the submitter's determination
//                        email. The prompt explicitly forbids IPs,
//                        full URLs, sender email addresses, and
//                        specific campaign internal IDs. A regex
//                        sanitizer (lib/abuse-mailbox-responder.ts)
//                        is a defense-in-depth safety net.
//
// Deterministic enrichment happens BEFORE the AI call. We resolve:
//   - sender_ip → ASN + country via geoip-mmdb
//   - ASN → canonical hosting_providers.name via the platform catalog
//   - correlated_threat_ids → campaign metadata via threats join
// All of that gets stamped on the attribution block in code, not by
// the model. The model only writes the narrative + picks the action.

import type { Env } from "../types";
import type { D1Database } from "@cloudflare/workers-types";
import { callAnthropicJSON, AnthropicError } from "./anthropic";
import { lookupGeoMmdb } from "./geoip-mmdb";

const SONNET_MODEL = "claude-sonnet-4-5-20250929";

// ─── Types ───────────────────────────────────────────────────────

export type RecommendedActionCategory =
  | "takedown"
  | "abuse_report"
  | "block"
  | "monitor"
  | "none";

export interface CorrelatedCampaignSummary {
  id:         string;
  name:       string | null;
  first_seen: string;
}

export interface DeepAnalysisAttribution {
  hosting_provider:      string | null;
  hosting_country:       string | null;
  sender_asn:            string | null;
  correlated_campaigns:  CorrelatedCampaignSummary[];
}

export interface RecommendedAction {
  category: RecommendedActionCategory;
  target:   string | null;
  details:  string;
}

export interface DeepAnalysisResult {
  attribution:         DeepAnalysisAttribution;
  internal_narrative:  string;
  external_narrative:  string;
  recommended_action:  RecommendedAction;
  analyzed_at:         string;
  model:               string;
}

export interface DeepAnalysisInputs {
  message_id:       string;
  classification:   "phishing" | "malware";
  confidence:       number;
  brand_name:       string | null;
  brand_domain:     string | null;
  original_from:    string | null;
  original_subject: string | null;
  body_snippet:     string | null;
  url_list:         ReadonlyArray<{ url: string; domain: string | null; count: number }>;
  attachment_list:  ReadonlyArray<{ filename: string; mime_type: string | null }>;
  auth_results:     { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  sender_ip:        string | null;
  correlated_threat_ids: string[];
}

// ─── Deterministic attribution enrichment ────────────────────────

/**
 * Resolve hosting provider + country + correlated campaigns from
 * the structured row data. Pure D1 reads; no AI involvement; no
 * external API calls.
 */
export async function resolveAttribution(
  env:                    Env,
  senderIp:               string | null,
  correlatedThreatIds:    string[],
): Promise<DeepAnalysisAttribution> {
  let hostingProvider: string | null = null;
  let hostingCountry:  string | null = null;
  let senderAsn:       string | null = null;

  if (senderIp) {
    const geo = await lookupGeoMmdb(env, senderIp);
    if (geo) {
      senderAsn      = geo.asn ?? null;
      hostingCountry = geo.countryName ?? geo.countryCode ?? null;
      if (senderAsn) {
        // Prefer the platform's canonical hosting_providers.name over
        // MaxMind's asnOrg — operators have curated the catalog. Fall
        // back to MaxMind's asnOrg when we don't have the ASN yet.
        const provRow = await env.DB.prepare(
          "SELECT name FROM hosting_providers WHERE asn = ? LIMIT 1",
        ).bind(senderAsn).first<{ name: string }>();
        hostingProvider = provRow?.name ?? geo.asnOrg ?? null;
      } else {
        hostingProvider = geo.asnOrg ?? null;
      }
    }
  }

  const correlatedCampaigns = await resolveCampaigns(env.DB, correlatedThreatIds);

  return {
    hosting_provider:     hostingProvider,
    hosting_country:      hostingCountry,
    sender_asn:           senderAsn,
    correlated_campaigns: correlatedCampaigns,
  };
}

async function resolveCampaigns(
  db:        D1Database,
  threatIds: string[],
): Promise<CorrelatedCampaignSummary[]> {
  if (threatIds.length === 0) return [];
  // Cap to avoid runaway IN clauses
  const capped = threatIds.slice(0, 20);
  const placeholders = capped.map(() => "?").join(",");
  const rows = await db.prepare(
    `SELECT DISTINCT c.id, c.name, c.first_seen
     FROM campaigns c
     JOIN threats t ON t.campaign_id = c.id
     WHERE t.id IN (${placeholders})
       AND c.id IS NOT NULL
     ORDER BY c.first_seen ASC
     LIMIT 5`,
  ).bind(...capped).all<{ id: string; name: string | null; first_seen: string }>();
  return rows.results.map((r) => ({
    id:         r.id,
    name:       r.name,
    first_seen: r.first_seen,
  }));
}

// ─── Prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior phishing/malware analyst writing a triage report for an abuse mailbox submission that has already been classified by a first-pass model. Your job is to produce TWO short narratives plus a specific recommended action.

Return JSON with EXACTLY these keys:
- internal_narrative (string, 2-3 sentences, full-fidelity for the operator UI)
- external_narrative (string, 2-3 sentences, SANITIZED for the submitter's email)
- recommended_action: { category, target, details }
    category ∈ "takedown" | "abuse_report" | "block" | "monitor" | "none"
    target   ∈ string | null  (specific abuse contact email, registrar, provider, etc.)
    details  ∈ string         (one sentence on what to do)

CRITICAL SANITIZATION RULES for external_narrative:
- NEVER include IP addresses (no IPv4, no IPv6)
- NEVER include full URLs (refer to "the suspicious links" / "the linked site")
- NEVER include attacker email addresses (refer to "the sender")
- NEVER include campaign internal IDs (refer to "an ongoing campaign" / "similar attacks")
- NEVER include attachment hashes or file paths
- DO include: hosting provider name (corporate name), country, brand affected,
  attack family at a high level (e.g. "credential harvesting", "fake invoice"),
  whether it matches a known campaign (general phrasing only)

The internal_narrative can include everything — IPs, full URLs, sender addresses,
campaign IDs — anything an analyst needs to investigate.

Tone for external_narrative: confident, helpful, reassuring without being smug.
The submitter is a non-technical employee who forwarded a suspicious email.
They want to know "what was it, what did you do, what should I do."`;

interface SonnetOutput {
  internal_narrative: string;
  external_narrative: string;
  recommended_action: RecommendedAction;
}

export function buildPrompt(inputs: DeepAnalysisInputs, attribution: DeepAnalysisAttribution): string {
  const lines: string[] = [];
  lines.push(`First-pass verdict: ${inputs.classification} @ ${inputs.confidence}% confidence`);
  if (inputs.brand_name) lines.push(`Customer brand: ${inputs.brand_name}${inputs.brand_domain ? ` (${inputs.brand_domain})` : ""}`);
  if (inputs.original_from)    lines.push(`Original sender: ${inputs.original_from}`);
  if (inputs.original_subject) lines.push(`Subject: ${inputs.original_subject}`);
  if (inputs.sender_ip)        lines.push(`Sender IP (from Received chain): ${inputs.sender_ip}`);

  if (attribution.hosting_provider) {
    const country = attribution.hosting_country ? `, ${attribution.hosting_country}` : "";
    lines.push(`Hosting provider: ${attribution.hosting_provider}${country}` +
               (attribution.sender_asn ? ` (${attribution.sender_asn})` : ""));
  }

  if (inputs.auth_results) {
    const a = inputs.auth_results;
    const parts: string[] = [];
    if (a.spf)   parts.push(`SPF=${a.spf}`);
    if (a.dkim)  parts.push(`DKIM=${a.dkim}`);
    if (a.dmarc) parts.push(`DMARC=${a.dmarc}`);
    if (parts.length > 0) lines.push(`Email auth: ${parts.join(" / ")}`);
  }

  if (inputs.url_list.length > 0) {
    lines.push("");
    lines.push("URLs in message:");
    for (const u of inputs.url_list.slice(0, 15)) {
      const domain = u.domain ? ` [${u.domain}]` : "";
      const count  = u.count > 1 ? ` ×${u.count}` : "";
      lines.push(`  - ${u.url}${domain}${count}`);
    }
  }
  if (inputs.attachment_list.length > 0) {
    lines.push("");
    lines.push("Attachments:");
    for (const a of inputs.attachment_list.slice(0, 10)) {
      const mime = a.mime_type ? ` (${a.mime_type})` : "";
      lines.push(`  - ${a.filename}${mime}`);
    }
  }
  if (attribution.correlated_campaigns.length > 0) {
    lines.push("");
    lines.push("This submission's indicators match these existing campaigns:");
    for (const c of attribution.correlated_campaigns) {
      const name = c.name ?? "(unnamed campaign)";
      lines.push(`  - ${name} (id ${c.id}, first seen ${c.first_seen})`);
    }
  }
  if (inputs.correlated_threat_ids.length > 0 && attribution.correlated_campaigns.length === 0) {
    lines.push("");
    lines.push(`Platform correlation: ${inputs.correlated_threat_ids.length} URL/domain(s) in this message already exist in our threat intelligence (no campaign assignment).`);
  }

  if (inputs.body_snippet) {
    lines.push("");
    lines.push("Body snippet (truncated):");
    lines.push(inputs.body_snippet.slice(0, 2000));
  }

  lines.push("");
  lines.push("Return JSON with the two narratives + recommended_action.");
  return lines.join("\n");
}

// ─── Sanitisation safety net ─────────────────────────────────────

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F]{0,4}\b/g;
const URL_RE  = /https?:\/\/[^\s<>"']+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Defense-in-depth scrub of the external_narrative string. Even though
 * the system prompt explicitly forbids IPs / URLs / emails, the model
 * occasionally leaks one. This regex pass guarantees the
 * downstream-email-bound text doesn't carry sensitive identifiers.
 *
 * - IPv4 / IPv6  → "[ip]"
 * - https URLs   → "[link]"  (preserves the prose flow)
 * - Email addr   → "[sender]"
 *
 * The internal_narrative is NOT sanitised — operators need the real data.
 */
export function sanitizeExternalNarrative(text: string): string {
  return text
    .replace(URL_RE, "[link]")
    .replace(IPV4_RE, "[ip]")
    .replace(IPV6_RE, "[ip]")
    .replace(EMAIL_RE, "[sender]")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Output parser ──────────────────────────────────────────────

const VALID_ACTIONS: ReadonlySet<RecommendedActionCategory> = new Set([
  "takedown", "abuse_report", "block", "monitor", "none",
]);

export function parseDeepAnalysisOutput(raw: unknown): SonnetOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const internal = o.internal_narrative;
  const external = o.external_narrative;
  const action   = o.recommended_action;
  if (typeof internal !== "string" || internal.trim().length === 0) return null;
  if (typeof external !== "string" || external.trim().length === 0) return null;
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;
  if (typeof a.category !== "string" || !VALID_ACTIONS.has(a.category as RecommendedActionCategory)) return null;
  if (typeof a.details  !== "string" || a.details.trim().length === 0) return null;
  return {
    internal_narrative: internal.trim(),
    external_narrative: external.trim(),
    recommended_action: {
      category: a.category as RecommendedActionCategory,
      target:   typeof a.target === "string" ? a.target.trim() : null,
      details:  a.details.trim(),
    },
  };
}

// ─── Public entrypoint ───────────────────────────────────────────

/**
 * Run the deeper AI analysis for one captured message. Pure function
 * over the inputs — caller is responsible for severity gating + storing
 * the result. Returns null on AI failure or unparseable output so the
 * caller can leave the row with classifier-only context.
 */
export async function runDeepAnalysis(
  env:    Env,
  inputs: DeepAnalysisInputs,
): Promise<DeepAnalysisResult | null> {
  const attribution = await resolveAttribution(
    env,
    inputs.sender_ip,
    inputs.correlated_threat_ids,
  );

  try {
    const { parsed } = await callAnthropicJSON<unknown>(env, {
      agentId:   "abuse_mailbox_deep_analyzer",
      runId:     null,
      model:     SONNET_MODEL,
      system:    SYSTEM_PROMPT,
      messages:  [{ role: "user", content: buildPrompt(inputs, attribution) }],
      maxTokens: 1024,
    });
    const out = parseDeepAnalysisOutput(parsed);
    if (!out) return null;
    return {
      attribution,
      internal_narrative: out.internal_narrative,
      external_narrative: sanitizeExternalNarrative(out.external_narrative),
      recommended_action: out.recommended_action,
      analyzed_at:        new Date().toISOString(),
      model:              SONNET_MODEL,
    };
  } catch (err) {
    if (err instanceof AnthropicError) {
      console.error("[abuse_mailbox_deep_analyzer] anthropic error:", err.message);
    } else {
      console.error("[abuse_mailbox_deep_analyzer] unexpected error:",
        err instanceof Error ? err.message : String(err));
    }
    return null;
  }
}

/**
 * Provider Resolver — Sparrow Phase 4
 *
 * Identifies hosting provider, registrar, and abuse contact for a domain
 * using internal threat data, URL scan results, and DNS lookups.
 */

import type { Env, TakedownProvider } from "../types";
import { isLiveSendMode } from "./takedown-submitters/email-send";

export interface ProviderInfo {
  hosting_provider: string | null;
  hosting_ip: string | null;
  hosting_country: string | null;
  registrar: string | null;
  abuse_contact: TakedownProvider | null;
}

/**
 * Resolve hosting provider and abuse contact for a domain.
 * Uses internal threat data first, then DNS lookups.
 */
export async function resolveProvider(env: Env, domain: string): Promise<ProviderInfo> {
  const result: ProviderInfo = {
    hosting_provider: null,
    hosting_ip: null,
    hosting_country: null,
    registrar: null,
    abuse_contact: null,
  };

  // 1. Check our threats table for existing infrastructure data
  const threatInfo = await env.DB.prepare(`
    SELECT hosting_provider_id, ip_address, country_code, registrar, asn
    FROM threats
    WHERE malicious_domain = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).bind(domain).first<{
    hosting_provider_id: string | null;
    ip_address: string | null;
    country_code: string | null;
    registrar: string | null;
    asn: string | null;
  }>();

  if (threatInfo) {
    result.hosting_ip = threatInfo.ip_address;
    result.hosting_country = threatInfo.country_code;
    result.registrar = threatInfo.registrar;

    // Look up provider name from hosting_providers table
    if (threatInfo.hosting_provider_id) {
      const provider = await env.DB.prepare(
        "SELECT name, asn FROM hosting_providers WHERE id = ?"
      ).bind(threatInfo.hosting_provider_id).first<{ name: string; asn: string | null }>();
      if (provider) {
        result.hosting_provider = provider.name;
      }
    }
  }

  // 2. Check URL scan results for additional data
  if (!result.hosting_provider) {
    const scanData = await env.DB.prepare(`
      SELECT hosting_provider, hosting_ip, hosting_country, registrar
      FROM url_scan_results
      WHERE domain = ? AND hosting_provider IS NOT NULL
      ORDER BY scanned_at DESC LIMIT 1
    `).bind(domain).first<{
      hosting_provider: string | null;
      hosting_ip: string | null;
      hosting_country: string | null;
      registrar: string | null;
    }>();

    if (scanData) {
      result.hosting_provider = scanData.hosting_provider || result.hosting_provider;
      result.hosting_ip = scanData.hosting_ip || result.hosting_ip;
      result.hosting_country = scanData.hosting_country || result.hosting_country;
      result.registrar = scanData.registrar || result.registrar;
    }
  }

  // 3. Try DNS resolution via Cloudflare DoH if we still have no IP
  if (!result.hosting_ip) {
    try {
      const dohResponse = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`,
        { headers: { Accept: "application/dns-json" } },
      );
      const dnsData = await dohResponse.json() as { Answer?: Array<{ data: string }> };
      if (dnsData.Answer?.[0]?.data) {
        result.hosting_ip = dnsData.Answer[0].data;
      }
    } catch {
      // DNS resolution failed — continue without IP
    }
  }

  // 4. Try to identify provider from IP using threats + hosting_providers
  if (result.hosting_ip && !result.hosting_provider) {
    const ipProvider = await env.DB.prepare(`
      SELECT hp.name
      FROM threats t
      JOIN hosting_providers hp ON hp.id = t.hosting_provider_id
      WHERE t.ip_address = ?
      LIMIT 1
    `).bind(result.hosting_ip).first<{ name: string }>();

    if (ipProvider) {
      result.hosting_provider = ipProvider.name;
    }
  }

  // 5. Match provider to our takedown_providers directory for abuse contact
  if (result.hosting_provider) {
    result.abuse_contact = await matchProvider(env, result.hosting_provider);
  }

  // 6. If no hosting provider match, try registrar match
  if (!result.abuse_contact && result.registrar) {
    result.abuse_contact = await matchProvider(env, result.registrar);
  }

  return result;
}

/**
 * NetBeacon (registrar-routed, X-ARF) is the preferred channel for *domain*
 * takedowns — one API fans the report out to the participating-registrar
 * network. This returns the NetBeacon provider row to route a domain takedown
 * to it, but only when NetBeacon is actually *dispatchable*:
 *
 *   - live send mode (TAKEDOWN_SEND_MODE='live'), AND
 *   - a configured NETBEACON_API_KEY, AND
 *   - the NetBeacon provider row flipped to auto_submit_enabled=1.
 *
 * Returns null otherwise, so the caller keeps the resolved host/registrar
 * contact and today's email-draft behavior is unchanged. The live+enabled gate
 * is a safety guarantee: the NetBeacon row has no abuse_email, so routing a
 * domain to it in a posture where the dispatcher couldn't select the NetBeacon
 * submitter (draft mode / no key) would strand the takedown with no deliverable
 * channel. Gating here mirrors netbeaconSubmitter.canHandle exactly.
 */
export async function preferredDomainReportingProvider(
  env: Env,
): Promise<TakedownProvider | null> {
  if (!isLiveSendMode(env)) return null;
  const key = (env as unknown as Record<string, string | undefined>).NETBEACON_API_KEY;
  if (!key) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM takedown_providers
     WHERE abuse_api_type = 'netbeacon' AND auto_submit_enabled = 1
     LIMIT 1`,
  ).first<TakedownProvider>();
  return row ?? null;
}

/**
 * Fuzzy match a provider name against the takedown_providers directory.
 */
async function matchProvider(env: Env, name: string): Promise<TakedownProvider | null> {
  // Exact match first
  const exact = await env.DB.prepare(
    "SELECT * FROM takedown_providers WHERE LOWER(provider_name) = LOWER(?) LIMIT 1"
  ).bind(name).first<TakedownProvider>();

  if (exact) return exact;

  // Fuzzy match — check if name contains provider name or vice versa
  const providers = await env.DB.prepare(
    "SELECT * FROM takedown_providers"
  ).all<TakedownProvider>();

  const nameLower = name.toLowerCase();
  for (const p of providers.results || []) {
    const pName = p.provider_name.toLowerCase();
    if (nameLower.includes(pName) || pName.includes(nameLower)) {
      return p;
    }
  }

  return null;
}

/**
 * Generate a provider-specific abuse submission draft.
 */
export function generateSubmissionDraft(
  takedown: {
    target_type: string;
    target_value: string;
    target_url?: string | null;
    evidence_summary: string;
    evidence_detail?: string | null;
    brand_name?: string;
  },
  provider: TakedownProvider | null,
  providerInfo: ProviderInfo,
): string {
  const providerName = provider?.provider_name || providerInfo.hosting_provider || "Provider";
  const isSocial = provider?.provider_type === "social_platform";
  const isRegistrar = provider?.provider_type === "registrar";

  if (isSocial) {
    return [
      `Subject: Brand Impersonation Report — ${takedown.target_value}`,
      `To: ${providerName} Trust & Safety Team`,
      "",
      `I am writing on behalf of ${takedown.brand_name || "the brand owner"} to report an account that is impersonating their brand.`,
      "",
      `Impersonating Account: ${takedown.target_value}`,
      takedown.target_url ? `Profile URL: ${takedown.target_url}` : null,
      "",
      takedown.evidence_summary,
      "",
      "This account violates your platform's impersonation policy. We request immediate removal.",
      "",
      "Evidence:",
      takedown.evidence_detail || takedown.evidence_summary,
      "",
      "Reported by: Averrow Brand Protection (averrow.com)",
      "Authorized brand protection service acting on behalf of the rights holder.",
      "",
      "Thank you for your prompt attention to this matter.",
    ].filter((l): l is string => l !== null).join("\n");
  }

  if (isRegistrar) {
    return [
      `Subject: Phishing Domain Abuse Report — ${takedown.target_value}`,
      `To: ${providerName} Abuse Department`,
      "",
      "We are reporting a domain registered through your service that is being used for brand abuse/phishing:",
      "",
      `Domain: ${takedown.target_value}`,
      takedown.target_url ? `Active URL: ${takedown.target_url}` : null,
      providerInfo.hosting_ip ? `IP Address: ${providerInfo.hosting_ip}` : null,
      providerInfo.registrar ? `Registrar: ${providerInfo.registrar}` : null,
      "",
      takedown.evidence_summary,
      "",
      `This domain is targeting ${takedown.brand_name || "a legitimate brand"} and poses a direct risk to consumers. We request suspension of this domain.`,
      "",
      "Technical Evidence:",
      takedown.evidence_detail || takedown.evidence_summary,
      "",
      "Reported by: Averrow Brand Protection (averrow.com)",
      "Authorized brand protection service.",
    ].filter((l): l is string => l !== null).join("\n");
  }

  // Default: hosting provider
  return [
    "Subject: Abuse Report — Phishing/Brand Abuse Content Hosted on Your Infrastructure",
    `To: ${providerName} Abuse Team`,
    provider?.abuse_email ? `Email: ${provider.abuse_email}` : null,
    "",
    "We are reporting malicious content hosted on your infrastructure:",
    "",
    `Target: ${takedown.target_value}`,
    takedown.target_url ? `URL: ${takedown.target_url}` : null,
    providerInfo.hosting_ip ? `IP Address: ${providerInfo.hosting_ip}` : null,
    providerInfo.hosting_country ? `Country: ${providerInfo.hosting_country}` : null,
    "",
    takedown.evidence_summary,
    "",
    `This content is targeting ${takedown.brand_name || "a legitimate brand"} and is being used for phishing/credential harvesting. We request immediate removal.`,
    "",
    "Technical Evidence:",
    takedown.evidence_detail || takedown.evidence_summary,
    "",
    "Reported by: Averrow Brand Protection (averrow.com)",
    "Authorized brand protection service acting on behalf of the rights holder.",
  ].filter((l): l is string => l !== null).join("\n");
}

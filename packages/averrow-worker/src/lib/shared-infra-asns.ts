// Averrow — shared-infrastructure ASNs (CDN / hyperscale cloud / parking).
//
// Hundreds of unrelated operators park phishing on these networks, so an
// ASN-ONLY cluster on one of them (NEXUS's `cluster_asn_<asn>_<type>` lane)
// groups strangers by landlord: it is NOT operator evidence. Clusters with
// SPECIFIC evidence that merely sit on these networks — a shared cert
// serial / SAN, a single IP, a /24 — still are, and must not be filtered by
// this list.
//
// Read today by GET /api/observatory/operations-geo
// (handlers/observatoryLenses.ts) to hide ASN-only shared-infra clusters
// from the Operations lens by default.
//
// NOT yet wired into NEXUS. The /24 lane carries its own 5-ASN literal
// (`asn NOT IN ('AS13335','AS54113','AS16509','AS20940','AS15169')` at
// agents/nexus.ts:726 and workflows/nexusRun.ts:421); the NEXUS follow-up
// should import SHARED_INFRA_ASNS there instead (owner-gated — it changes
// what NEXUS writes).

/** Canonical `AS<digits>` keys. */
export const SHARED_INFRA_ASNS: ReadonlySet<string> = new Set<string>([
  // Cloudflare
  "AS13335", "AS209242",
  // Amazon
  "AS16509", "AS14618", "AS8987",
  // Google
  "AS15169", "AS396982", "AS19527",
  // Microsoft
  "AS8075",
  // Akamai / Linode
  "AS20940", "AS16625", "AS63949",
  // Fastly
  "AS54113",
  // DigitalOcean
  "AS14061",
  // OVH
  "AS16276",
  // Hetzner
  "AS24940",
  // Vultr
  "AS20473",
  // Sedo (parking)
  "AS47846",
  // Squarespace
  "AS53831",
]);

/**
 * Leading ASN token → canonical `AS<digits>`, or null. Accepts the forms
 * threats.asn carries: `AS13335`, `as13335`, `13335`, and the geo-lookup
 * org form `AS13335 Cloudflare, Inc.` (everything after the number is
 * ignored). Numbers (e.g. a JSON `13335`) are accepted too.
 */
export function asnKey(raw: unknown): string | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? `AS${raw}` : null;
  if (typeof raw !== "string") return null;
  const m = /^\s*(?:AS)?(\d+)(?![\d])/i.exec(raw);
  if (!m) return null;
  const digits = m[1]!.replace(/^0+(?=\d)/, "");
  return `AS${digits}`;
}

/** True when the (raw, any accepted form) ASN is a shared-infra network. */
export function isSharedInfraAsn(raw: unknown): boolean {
  const k = asnKey(raw);
  return k !== null && SHARED_INFRA_ASNS.has(k);
}

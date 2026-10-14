/**
 * Shared NEXUS cluster identity helpers.
 *
 * `agents/nexus.ts` (manual-trigger fallback) and `workflows/nexusRun.ts`
 * (the live 4-hourly path) write the SAME `infrastructure_clusters` rows,
 * keyed on deterministic ids derived from each lane's natural key. Both the
 * id slug AND the display name therefore have to be computed identically —
 * `cluster_name` sits in the `ON CONFLICT(id) DO UPDATE SET` list, so any
 * divergence makes the two paths overwrite each other's name on every run
 * (operator manual run → workflow 4h later → name flips back).
 *
 * Keeping both helpers here means there is exactly one definition to change.
 * Do NOT re-inline a copy into either caller.
 */

/**
 * Sanitize a natural-key part for use inside a deterministic cluster id.
 * Keeps lowercase alphanumerics + dashes; collapses everything else to
 * underscores; bounds length to keep id strings reasonable.
 */
export function slugifyKey(value: string | null | undefined): string {
  if (!value) return 'unknown';
  return value
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

/**
 * Display names are EVIDENCE-FIRST: each names the key the lane clustered on
 * and nothing else. The ASN-lane name used to be prefixed with the FIRST
 * entry of an unordered GROUP_CONCAT(DISTINCT country_code) ("CA AS13335
 * malware distribution cluster") — an arbitrary country presented as if it
 * were the operation's origin. Per-country volume now lives in
 * `infrastructure_clusters.country_counts` (migration 0302) instead.
 */

/** Threat type for display: underscores → spaces, `threat` when missing. */
function displayType(threatType: string | null | undefined): string {
  const t = (threatType ?? '').replace(/_/g, ' ').trim();
  return t || 'threat';
}

/** Shorten an opaque key for display: first `n` chars + "…" when longer. */
function shortKey(value: string, n: number): string {
  return value.length > n ? `${value.slice(0, n)}…` : value;
}

/**
 * ASN lane: `"AS4837 · malware distribution"`. `asn` is the normalised
 * `AS<digits>` group key (lib/shared-infra-asns.ts asnKey).
 */
export function generateClusterName(cluster: {
  threat_type?: string | null;
  asn?: string | null;
}): string {
  const asn = (cluster.asn ?? '').trim() || 'Unknown ASN';
  return `${asn} · ${displayType(cluster.threat_type)}`;
}

/** Cert-serial lane: `"Cert serial 0a1b2c3d4e5f… · 12 domains"`. */
export function certSerialClusterName(serial: string, domainCount: number): string {
  return `Cert serial ${shortKey(serial, 12)} · ${domainCount} domains`;
}

/** Cert-SAN lane: `"Cert SAN 85bbc2… · 370 domains"`. */
export function certSanClusterName(sanHash: string, domainCount: number): string {
  return `Cert SAN ${shortKey(sanHash, 6)} · ${domainCount} domains`;
}

/** Per-IP lane: `"IP 203.0.113.7 · 14 brands"`. */
export function perIpClusterName(ip: string, brandCount: number): string {
  return `IP ${ip} · ${brandCount} brands`;
}

/**
 * /24 lane: `"Subnet 74.115.51.0/24 · 6 IPs"`. `subnet24` is the
 * ip_subnet24 generated-column value, which keeps the trailing dot
 * ("74.115.51.").
 */
export function subnetClusterName(subnet24: string, distinctIps: number): string {
  const prefix = subnet24.endsWith('.') ? subnet24 : `${subnet24}.`;
  return `Subnet ${prefix}0/24 · ${distinctIps} IPs`;
}

/** Registrar lane: `"Registrar Example Registrar, Inc. · 14d cohort"`. */
export function registrarClusterName(registrar: string): string {
  return `Registrar ${registrar} · 14d cohort`;
}

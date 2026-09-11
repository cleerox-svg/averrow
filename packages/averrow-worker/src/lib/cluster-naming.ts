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
 * Display name for an ASN-lane cluster: `"<country> <asn-org> <type> cluster"`,
 * e.g. `"US Cloudflare malware distribution cluster"`.
 *
 * - country: first entry of the GROUP_CONCAT'd `countries` column, `Unknown`
 *   when the lane produced none.
 * - asn: the `AS<number>` prefix is stripped so the operator-facing name reads
 *   as the org ("Cloudflare"), falling back to the raw value when the string
 *   is nothing but the AS number.
 * - type: `threat_type` with underscores turned into spaces.
 */
export function generateClusterName(cluster: {
  countries?: string | null;
  threat_type?: string | null;
  asn?: string | null;
}): string {
  const country = cluster.countries?.split(',')?.[0] ?? 'Unknown';
  const type = cluster.threat_type?.replace(/_/g, ' ') ?? 'threat';
  const asnRaw = cluster.asn ?? '';
  const asn = asnRaw.replace(/^AS\d+\s*/, '').trim() || asnRaw;
  return `${country} ${asn} ${type} cluster`.trim();
}

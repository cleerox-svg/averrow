// Averrow — shared-infrastructure ASNs (CDN / hyperscale cloud / mass hoster
// / parking) and the ONE ASN normaliser the platform uses.
//
// Hundreds of unrelated operators park phishing on these networks, so an
// ASN-ONLY cluster on one of them (NEXUS's `cluster_asn_<asn>_<type>` lane)
// groups strangers by landlord: it is NOT operator evidence. Clusters with
// SPECIFIC evidence that merely sit on these networks — a shared cert
// serial / SAN, a single IP, a /24 — still are, and must not be filtered by
// this list alone.
//
// Consumers (all read THIS list and THIS normaliser — no second copy):
//   - NEXUS lanes (lib/nexus-threat-lanes.ts): the ASN lane skips these
//     networks, the per-IP and /24 lanes exclude their members (the /24
//     lane's old 5-ASN literal is gone), and asnKeySql is the SQL twin used
//     to group / filter threats.asn in-query.
//   - Legacy-cluster retirement (lib/cluster-retirement.ts): ASN-only rows on
//     these networks retire to status 'shared_infra'.
//   - GET /api/observatory/operations-geo (handlers/observatoryLenses.ts):
//     the evidence-tier classifier's `shared_infra` exclusion.

/** Canonical `AS<digits>` keys. */
export const SHARED_INFRA_ASNS: ReadonlySet<string> = new Set<string>([
  // Cloudflare (incl. Spectrum / WARP)
  "AS13335", "AS209242",
  // Amazon (AWS, us-east, Global Accelerator / EU)
  "AS16509", "AS14618", "AS8987",
  // Google (incl. Cloud, Firebase / App Engine)
  "AS15169", "AS396982", "AS19527",
  // Microsoft (Azure)
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
  // Vultr (Choopa)
  "AS20473",
  // Sedo (parking)
  "AS47846",
  // Squarespace
  "AS53831",
]);

for (const a of SHARED_INFRA_ASNS) {
  // The list is interpolated into SQL text (SHARED_INFRA_ASNS_SQL_LIST);
  // refuse anything that is not a canonical ASN so the literal can never
  // carry SQL.
  if (!/^AS[0-9]+$/.test(a)) throw new Error(`SHARED_INFRA_ASNS: non-canonical entry ${a}`);
}

/** `'AS13335', 'AS209242', …` — for `NOT IN (…)` predicates in NEXUS SQL. */
export const SHARED_INFRA_ASNS_SQL_LIST: string = [...SHARED_INFRA_ASNS].map((a) => `'${a}'`).join(", ");

/**
 * ASN value → canonical `AS<digits>`, or null when it can't be determined.
 *
 * Takes the first space/comma-delimited token, so every form threats.asn and
 * the cluster `asns` JSON carry resolve: `AS13335`, `as13335`, `13335`, and
 * the geo-lookup org form `AS13335 Cloudflare, Inc.` (1,708 legacy cluster
 * rows carry it). A number (e.g. a JSON `13335`) is read through its string
 * form. `Cloudflare AS13335`, `AS 13335` and `AS13335x` are null.
 *
 * MUST stay equivalent to asnKeySql — test/nexus-threat-lanes.test.ts runs
 * both over the same inputs. That is why trimming is spaces-only (SQLite's
 * one-argument trim() strips only U+0020) and leading zeros are kept.
 */
export function asnKey(raw: unknown): string | null {
  if (typeof raw === "number") raw = String(raw);
  if (typeof raw !== "string") return null;
  const s = raw.replace(/,/g, " ").replace(/^ +| +$/g, "");
  const sp = s.indexOf(" ");
  const token = (sp === -1 ? s : s.slice(0, sp)).toUpperCase();
  if (/^AS[0-9]+$/.test(token)) return token;
  if (/^[0-9]+$/.test(token)) return `AS${token}`;
  return null;
}

/** SQL twin of asnKey over column `col` (NULL when undeterminable). */
export function asnKeySql(col: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/i.test(col)) throw new Error(`asnKeySql: bad column ${col}`);
  const s = `trim(replace(${col}, ',', ' '))`;
  const t = `upper(substr(${s}, 1, instr(${s} || ' ', ' ') - 1))`;
  return `(CASE WHEN length(${t}) > 2 AND substr(${t}, 1, 2) = 'AS' AND ltrim(substr(${t}, 3), '0123456789') = '' THEN ${t}`
    + ` WHEN length(${t}) > 0 AND ltrim(${t}, '0123456789') = '' THEN 'AS' || ${t} END)`;
}

/** True when the (raw, any accepted form) ASN is a shared-infra network. */
export function isSharedInfraAsn(raw: unknown): boolean {
  const k = asnKey(raw);
  return k !== null && SHARED_INFRA_ASNS.has(k);
}

// Averrow — shared-infrastructure ASNs and the ONE ASN normaliser the
// platform uses.
//
// Two DISJOINT sets, because "shared" means two different things depending
// on the evidence key:
//
//   MULTI_TENANT_ASNS — networks where a SINGLE IP serves many unrelated
//     tenants: CDN / anycast front-ends (Cloudflare, Akamai, Fastly, Azure
//     Front Door), Google's front-end network (Sites, Forms, Blogger,
//     appspot, Firebase Hosting, Cloud Run *.run.app), Amazon's primary
//     ASN (CloudFront, S3 website endpoints, Amplify), site builders (Wix,
//     Weebly, Squarespace), free / mass shared hosting (InfinityFree,
//     Hostinger, IONOS, Strato, Gandi, Render), parking (Sedo, Above /
//     Trellian, Network Solutions), registrar hosting (Namecheap, Tucows),
//     WordPress.com, Sucuri's WAF and IPFS gateways. On these an IP is not
//     an operator, so they are excluded from EVERY NEXUS lane keyed on IP /
//     subnet / ASN.
//
//   SINGLE_TENANT_IAAS_ASNS — hyperscalers and VPS providers (AWS EC2,
//     Google Cloud, DigitalOcean, OVH, Hetzner, Vultr, Linode, Alibaba,
//     Tencent, Oracle, UCloud). The whole ASN is a landlord — grouping by
//     it, or by a /24 of it, groups strangers — but an individual IP is
//     normally ONE customer's VM, so one IP hosting several brands'
//     impersonations IS operator evidence. Excluded from the ASN and /24
//     lanes ONLY; the per-IP lane keeps them and relies on its <=
//     hub-threshold brand cap to drop the few genuinely shared IPs.
//
// SHARED_INFRA_ASNS is their union ("not usable as an ASN- or subnet-level
// key") and keeps its old meaning for existing callers.
//
// Clusters with SPECIFIC evidence that merely sit on these networks — a
// shared cert serial / SAN — are still operator evidence and must not be
// filtered by these lists.
//
// Consumers (all read THESE lists and THIS normaliser — no second copy):
//   - NEXUS lanes (lib/nexus-threat-lanes.ts): ASN lane and /24 lane skip
//     SHARED_INFRA_ASNS (union); the per-IP lane skips MULTI_TENANT_ASNS
//     only. asnKeySql is the SQL twin used to group / filter threats.asn.
//   - NEXUS retire pass (lib/nexus-threat-lanes.ts
//     retireNonOperationalLaneClusters) mirrors the same split.
//   - Legacy-cluster retirement (lib/cluster-retirement.ts): ASN-only rows on
//     the union release their threats instead of re-pointing them.
//   - GET /api/observatory/operations-geo (handlers/observatoryLenses.ts):
//     the evidence-tier classifier's `shared_infra` exclusion (ASN kind,
//     union).

/** One IP serves many unrelated tenants. Canonical `AS<digits>` keys. */
export const MULTI_TENANT_ASNS: ReadonlySet<string> = new Set<string>([
  // Cloudflare (incl. Spectrum / WARP)
  "AS13335", "AS209242",
  // Akamai
  "AS16625", "AS20940",
  // Fastly
  "AS54113",
  // Google front-end network: AS15169 serves Sites, Forms, Blogger,
  // appspot / App Engine, Firebase Hosting, Cloud Run *.run.app and
  // storage.googleapis.com from shared GFE IPs — one IP, thousands of
  // tenants. AS19527 carries further Google front-ends.
  // (AS396982, Google Cloud, is NOT here — see SINGLE_TENANT_IAAS_ASNS.)
  "AS15169", "AS19527",
  // Amazon's primary ASN: besides EC2 it announces CloudFront, S3 website
  // endpoints and Amplify Hosting front-ends, all multi-tenant per IP. The
  // EC2-only ASNs AS14618 / AS8987 stay in SINGLE_TENANT_IAAS_ASNS.
  "AS16509",
  // Microsoft (Azure Front Door / shared front-ends)
  "AS8075",
  // Site builders: Weebly, Wix, Squarespace
  "AS27647", "AS58182", "AS53831",
  // WordPress.com (Automattic)
  "AS2635",
  // Sucuri WAF / reverse proxy
  "AS30148",
  // IPFS gateways (Protocol Labs)
  "AS40680",
  // Free / mass shared hosting: iFastNet (InfinityFree), Hostinger, IONOS,
  // Strato, Gandi, Render
  "AS34119", "AS47583", "AS8560", "AS6724", "AS29169", "AS397273",
  // Registrar hosting / parking: Namecheap, Tucows, Network Solutions,
  // Trellian / Above, Sedo
  "AS22612", "AS15348", "AS32491", "AS40034", "AS133618", "AS47846",
]);

/** Whole-ASN landlord, but one IP is normally one customer. */
export const SINGLE_TENANT_IAAS_ASNS: ReadonlySet<string> = new Set<string>([
  // Amazon EC2 (us-east-1, EU) — AS16509 is multi-tenant, see above
  "AS14618", "AS8987",
  // Google Cloud (AS396982, 34.x / 35.x). Classified IaaS on purpose:
  // the bulk of it is GCE VM external IPs, one customer each. Google Cloud
  // load balancers also announce here, but an external LB address is
  // allocated to ONE customer project's forwarding rule, so it is still one
  // customer per IP. Google's genuinely shared front-ends (Firebase Hosting,
  // App Engine, Cloud Run default URLs, Sites) answer from AS15169, which
  // is in MULTI_TENANT_ASNS. The per-IP lane's hub cap remains the backstop
  // for any shared GCP address.
  "AS396982",
  // DigitalOcean
  "AS14061",
  // OVH
  "AS16276",
  // Hetzner
  "AS24940",
  // Vultr (Choopa)
  "AS20473",
  // Linode (Akamai Cloud)
  "AS63949",
  // Alibaba Cloud
  "AS45102", "AS37963",
  // Tencent Cloud
  "AS132203", "AS45090",
  // Oracle Cloud
  "AS31898",
  // UCloud
  "AS135377",
]);

/** Union — not usable as an ASN-level or /24-level grouping key. */
export const SHARED_INFRA_ASNS: ReadonlySet<string> = new Set<string>([
  ...MULTI_TENANT_ASNS,
  ...SINGLE_TENANT_IAAS_ASNS,
]);

for (const a of SHARED_INFRA_ASNS) {
  // The lists are interpolated into SQL text (the *_SQL_LIST constants);
  // refuse anything that is not a canonical ASN so the literal can never
  // carry SQL.
  if (!/^AS[0-9]+$/.test(a)) throw new Error(`SHARED_INFRA_ASNS: non-canonical entry ${a}`);
  if (MULTI_TENANT_ASNS.has(a) && SINGLE_TENANT_IAAS_ASNS.has(a)) {
    throw new Error(`SHARED_INFRA_ASNS: ${a} is in both MULTI_TENANT_ASNS and SINGLE_TENANT_IAAS_ASNS`);
  }
}

const sqlList = (s: ReadonlySet<string>): string => [...s].map((a) => `'${a}'`).join(", ");

/** `'AS13335', …` (union) — for `NOT IN (…)` in the ASN and /24 lanes. */
export const SHARED_INFRA_ASNS_SQL_LIST: string = sqlList(SHARED_INFRA_ASNS);
/** `'AS13335', …` (multi-tenant only) — for `NOT IN (…)` in the per-IP lane. */
export const MULTI_TENANT_ASNS_SQL_LIST: string = sqlList(MULTI_TENANT_ASNS);
/** `'AS14618', …` (IaaS only). */
export const SINGLE_TENANT_IAAS_ASNS_SQL_LIST: string = sqlList(SINGLE_TENANT_IAAS_ASNS);

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

/** True when the (raw, any accepted form) ASN is in either shared set. */
export function isSharedInfraAsn(raw: unknown): boolean {
  const k = asnKey(raw);
  return k !== null && SHARED_INFRA_ASNS.has(k);
}

/** True when the (raw, any accepted form) ASN is a multi-tenant network. */
export function isMultiTenantAsn(raw: unknown): boolean {
  const k = asnKey(raw);
  return k !== null && MULTI_TENANT_ASNS.has(k);
}
